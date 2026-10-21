/* Magic-link auth (T18): 6-digit codes, 10-min expiry, KV sessions.
 * POST /api/auth/request-code {email} → sends code iff email is a known active user
 * POST /api/auth/verify-code {email, code} → sets httpOnly session cookie
 * POST /api/auth/logout → clears session
 * Security: codes are SHA-256 hashed in KV; existence of an email is never
 * revealed; auth endpoints are strictly rate-limited; sessions are
 * httpOnly + secure + sameSite=lax cookies. */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { sendEmail, shell, esc } from "../lib/email";
import { cleanStr, isEmail, clientIp, sha256Hex } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { safeEqual } from "../lib/safe-equal";
import { setSessionCookie, createSession, destroySession, readSession } from "../lib/auth";
import { inviteCodeHmac } from "../lib/invites";

type Env = Bindings & {
  RESEND_API_KEY?: string;
  SESSIONS_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();
const CODE_TTL = 600; // 10 minutes
const MAX_ATTEMPTS = 5;

function codeKey(email: string) {
  return sha256Hex("authcode:" + email.toLowerCase());
}

/** Cryptographically secure 6-digit code via rejection sampling (no modulo
 * bias: 2^32 is not a multiple of 900000, so `rand % 900000` would favour
 * some codes slightly). */
function randomSixDigit(): string {
  const range = 900000;
  const limit = Math.floor(0x100000000 / range) * range;
  let rand: number;
  do {
    rand = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (rand >= limit);
  return String(100000 + (rand % range));
}

/** Store a magic-code record: code hash + attempt counter + strict expiry.
 * expiresAt (ms epoch) is enforced on verify; the KV TTL is only a backstop
 * so a failed-attempt re-put can never extend the code's life. */
async function storeCode(
  kv: KVNamespace,
  email: string,
  code: string
): Promise<void> {
  const key = "authcode:" + (await codeKey(email));
  await kv.put(
    key,
    JSON.stringify({
      email,
      codeHash: await sha256Hex("code:" + code),
      attempts: 0,
      expiresAt: Date.now() + CODE_TTL * 1000,
    }),
    { expirationTtl: CODE_TTL }
  );
}

app.post("/request-code", async (c) => {
  const { DB, SESSIONS_KV } = c.env;
  const resendKey = c.env.RESEND_API_KEY;
  if (!resendKey) return c.json({ ok: false }, 500);

  // Strict rate limit on the auth endpoint (security skill: ~10/15min).
  if (!(await checkRateLimitD1(DB, "authreq:" + clientIp(c.req.raw), 10, 900))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  const email = cleanStr(data.email, 200).toLowerCase();
  if (!isEmail(email)) return c.json({ ok: true }); // never reveal validity

  // Per-email throttle (inbox-bombing defence): pretend success either way.
  if (!(await checkRateLimitD1(DB, "authreq:email:" + email, 5, 3600))) {
    return c.json({ ok: true });
  }

  const user = await DB.prepare(
    "SELECT id, name FROM users WHERE email = ? AND status = 'active'"
  )
    .bind(email)
    .first<{ id: string; name: string }>();

  // Unknown or inactive → pretend success. No code, no email, no leak.
  if (!user) return c.json({ ok: true });

  // Cryptographically secure 6-digit code.
  const code = randomSixDigit();
  await storeCode(SESSIONS_KV, email, code);

  // A Resend outage must not throw unhandled after the code is stored in KV:
  // log the failure and return a clean 503. The code stays valid for its
  // 10-minute TTL, so retrying the request sends a fresh email with the
  // same code still usable. Validity of the email is never revealed.
  try {
    await sendEmail(resendKey, {
      to: email,
      subject: "Your Brimwood sign-in code",
      html: shell(
        "Your sign-in code",
        "Use this code within 10 minutes.",
        "<p style=\"margin:0 0 16px;\">Hello" + (user.name ? " " + esc(user.name) : "") + ",</p>" +
          "<p style=\"margin:0 0 8px;\">Your Brimwood sign-in code is:</p>" +
          '<p style="font-size:36px;font-weight:700;letter-spacing:0.3em;color:#0C9463;margin:16px 0;">' + code + "</p>" +
          '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">It expires in 10 minutes. If you did not request this, just ignore it.</p>'
      ),
      text: "Your Brimwood sign-in code is: " + code + "\n\nIt expires in 10 minutes. If you did not request this, just ignore it.",
    });
  } catch (err) {
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status, error) VALUES (?, 'auth-code', ?, ?, 'failed', ?)"
    )
      .bind(crypto.randomUUID(), email, "Your Brimwood sign-in code", String(err).slice(0, 300))
      .run();
    return c.json({ ok: false, error: "Could not send the sign-in code. Please try again." }, 503);
  }
  await DB.prepare(
    "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'auth-code', ?, ?, 'sent')"
  )
    .bind(crypto.randomUUID(), email, "Your Brimwood sign-in code")
    .run();

  return c.json({ ok: true });
});

app.post("/verify-code", async (c) => {
  const { DB, SESSIONS_KV } = c.env;
  if (!(await checkRateLimitD1(DB, "authver:" + clientIp(c.req.raw), 10, 900))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  const email = cleanStr(data.email, 200).toLowerCase();
  const code = cleanStr(data.code, 10).replace(/\D/g, "");
  if (!isEmail(email) || code.length !== 6) {
    return c.json({ ok: false, error: "Invalid code." }, 401);
  }

  const kvKey = "authcode:" + (await codeKey(email));
  const raw = await SESSIONS_KV.get(kvKey);
  if (!raw) return c.json({ ok: false, error: "Code expired. Request a new one." }, 401);

  const rec = JSON.parse(raw) as {
    email: string;
    codeHash: string;
    attempts: number;
    expiresAt?: number;
  };
  // Strict expiry from the record itself: failed attempts re-put the record,
  // and must never extend the code's life via a fresh KV TTL.
  if (typeof rec.expiresAt === "number" && Date.now() > rec.expiresAt) {
    await SESSIONS_KV.delete(kvKey);
    return c.json({ ok: false, error: "Code expired. Request a new one." }, 401);
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    await SESSIONS_KV.delete(kvKey);
    return c.json({ ok: false, error: "Too many attempts. Request a new code." }, 401);
  }
  const ok = safeEqual(await sha256Hex("code:" + code), rec.codeHash);
  if (!ok) {
    rec.attempts += 1;
    // Preserve the original expiry — do not refresh the KV TTL.
    const ttl = Math.max(
      1,
      Math.ceil(((rec.expiresAt ?? Date.now() + CODE_TTL * 1000) - Date.now()) / 1000)
    );
    await SESSIONS_KV.put(kvKey, JSON.stringify(rec), { expirationTtl: ttl });
    return c.json({ ok: false, error: "Invalid code." }, 401);
  }

  const user = await DB.prepare(
    "SELECT id, role FROM users WHERE email = ? AND status = 'active'"
  )
    .bind(email)
    .first<{ id: string; role: string }>();
  if (!user) {
    await SESSIONS_KV.delete(kvKey);
    return c.json({ ok: false, error: "Invalid code." }, 401);
  }

  await SESSIONS_KV.delete(kvKey); // single-use
  const token = await createSession(c.env, user.id, user.role);
  setSessionCookie(c, token);
  return c.json({ ok: true });
});

app.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

/* Invite redemption (T28, SCHEMA section 7 item 3): POST
 * /api/auth/redeem-invite {email, name, code}
 * v5 flow: the invite is looked up by the HMAC of the submitted code (the
 * plain code is never stored, S2), then ONE batch inserts the redemption
 * row and the user. The 0023 triggers validate and consume the invite and
 * claim the redemption for the new user, atomically. No password is taken
 * at sign-up (D1). A magic sign-in code follows so they can sign in at
 * once. */
app.post("/redeem-invite", async (c) => {
  const { DB } = c.env;
  if (!(await checkRateLimitD1(DB, "redeem:" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  const email = cleanStr(data.email, 200).toLowerCase();
  const name = cleanStr(data.name, 100);
  const code = cleanStr(data.code, 50).toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!isEmail(email) || !name || !code) {
    return c.json({ ok: false, error: "Please include your name, email, and invite code." }, 400);
  }

  // Validate the invite code FIRST (hardening: the code gate stands before any
  // email-dependent branch, so this endpoint cannot be used to probe whether
  // an email is registered — the magic-code endpoint already behaves this way).
  // Lookup is by HMAC: invite_codes.code stores HMAC(code), never the code.
  const stored = await inviteCodeHmac(c.env, code);
  type InviteRow = {
    id: string;
    max_uses: number;
    uses: number;
    expires_at: string | null;
    revoked_at: string | null;
    email: string | null;
  };
  const fetchInvite = () =>
    DB.prepare(
      `SELECT id, max_uses, uses, expires_at, revoked_at, email FROM invite_codes WHERE code = ?`
    )
      .bind(stored)
      .first<InviteRow>();
  const inviteProblem = (inv: InviteRow | null): string | null => {
    if (!inv) return "Invalid invite code.";
    if (inv.revoked_at) return "This invite code has been revoked.";
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return "This invite code has expired.";
    }
    if (inv.email && inv.email.toLowerCase() !== email) {
      return "This invite was issued for a different email address.";
    }
    if (inv.uses >= inv.max_uses) return "This invite code has already been used.";
    return null;
  };
  const invite = await fetchInvite();
  const problem = inviteProblem(invite);
  if (problem) return c.json({ ok: false, error: problem }, 400);

  // Existing-user check comes after code validation, so the endpoint cannot
  // be used to probe whether an email is registered without a valid invite.
  const existing = await DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    return c.json({ ok: false, error: "This email is already registered. Please sign in." }, 400);
  }

  // One batch: the redemption row first (its trigger validates the invite
  // again and consumes one use), then the user (whose trigger requires the
  // unclaimed redemption and claims it). If either statement fails, the
  // whole batch rolls back, so an invite use can never be burned by a
  // failed sign-up and no compensation step is needed. No password columns:
  // passwords are not offered at sign-up (D1).
  const userId = crypto.randomUUID();
  try {
    await DB.batch([
      DB.prepare("INSERT INTO invite_redemptions (id, invite_code_id, email) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), invite!.id, email),
      DB.prepare(
        `INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, 'member', 'active')`
      ).bind(userId, email, name),
    ]);
  } catch (e) {
    // A racer may have consumed the invite between the check above and the
    // batch; the trigger's verdict is the authority. Re-read and report the
    // specific problem when there is one.
    const now = await fetchInvite().catch(() => null);
    const raced = inviteProblem(now);
    if (raced) return c.json({ ok: false, error: raced }, 400);
    if (String(e).includes("invite is not valid")) {
      return c.json({ ok: false, error: "Invalid invite code." }, 400);
    }
    throw e;
  }

  // Audit log.
  await DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, target) VALUES (?, ?, 'invite.redeem', ?)"
  )
    .bind(crypto.randomUUID(), userId, email)
    .run()
    .catch(() => {});

  // Send a magic sign-in code so they can sign in immediately.
  const resendKey = (c.env as Env).RESEND_API_KEY;
  if (resendKey) {
    const magicCode = randomSixDigit();
    await storeCode(c.env.SESSIONS_KV, email, magicCode);
    const html = shell(
      "Your Brimwood sign-in code",
      "Welcome to Brimwood.",
      "<p style=\"margin:0 0 8px;\">Welcome" + (name ? ", " + esc(name) : "") + ". Your invite code worked — here is your sign-in code:</p>" +
        '<p style="font-size:36px;font-weight:700;letter-spacing:0.3em;color:#0C9463;margin:16px 0;">' + magicCode + "</p>" +
        '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">Use this code within 10 minutes. Build a business. Build yourself.</p>'
    );
    await sendEmail(resendKey, {
      to: email,
      subject: "Welcome to Brimwood — your sign-in code",
      html,
      text: "Welcome to Brimwood" + (name ? ", " + name : "") + ".\n\nYour sign-in code is: " + magicCode + "\n\nIt expires in 10 minutes.",
    }).catch(() => {});
  }

  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const sess = await readSession(c);
  if (!sess) return c.json({ ok: false }, 401);
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, role FROM users WHERE id = ? AND status = 'active'"
  )
    .bind(sess.userId)
    .first<{ id: string; email: string; name: string; role: string }>();
  if (!user) return c.json({ ok: false }, 401);
  return c.json({ ok: true, user });
});

/** Auth middleware for protected routes: resolves the session or 401s. */
export async function requireAuth(c: any, next: () => Promise<Response>): Promise<Response> {
  const sess = await readSession(c);
  if (!sess) {
    return new Response(JSON.stringify({ ok: false, error: "Not signed in." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return next();
}

export default app;
