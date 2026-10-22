/* Magic-link auth (T18, SCHEMA section 7 item 6): 6-digit codes, 10-min
 * expiry, codes in D1 auth_email_codes (not KV).
 * POST /api/auth/request-code {email} → sends code iff email is a known active user
 * POST /api/auth/verify-code {email, code} → sets httpOnly session cookie
 * POST /api/auth/logout → clears session
 * Security: codes are HMAC-SHA256 (Worker pepper) in D1, never plaintext;
 * attempts increment atomically (single UPDATE guarded by attempts < 5);
 * one live code per (email, purpose): a fresh code supersedes the old one;
 * each code is bound to the requesting browser via a binding cookie, so a
 * phished code alone is useless; existence of an email is never revealed;
 * auth endpoints are strictly rate-limited; sessions are httpOnly + secure
 * + sameSite=lax cookies and carry the S6 sign-in context (amr, auth_time,
 * is_staff, ua_summary, city, device_id). */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";
import { sendEmail, shell, esc } from "../lib/email";
import { cleanStr, isEmail, clientIp, sha256Hex } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { safeEqual } from "../lib/safe-equal";
import { codeHmac, hmacSha256Hex } from "../lib/hmac";
import {
  setSessionCookie,
  createSession,
  destroySession,
  readSession,
  summarizeUa,
  cfCity,
} from "../lib/auth";
import { inviteCodeHmac } from "../lib/invites";

type Env = Bindings;

const app = new Hono<{ Bindings: Env }>();
const CODE_TTL_MS = 600_000; // 10 minutes; matches the 0023 CHECK (1s to 600.5s)
const MAX_ATTEMPTS = 5;
const CODE_PURPOSE = "sign_in";

/* Browser-binding cookie for email codes (S4). The code row stores only the
 * SHA-256 of this secret; verify compares what the browser presents.
 * __Host- rules: no Domain, Path=/, Secure, https only. 10-minute life,
 * same as the code it is bound to. */
const CBIND_COOKIE = "__Host-brimwood-cbind";
const CBIND_ATTRS = "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";

function setBindingCookie(c: any, token: string): void {
  c.header("Set-Cookie", `${CBIND_COOKIE}=${token}; ${CBIND_ATTRS}`, {
    append: true,
  });
}

function getBindingToken(c: any): string | undefined {
  return getCookie(c, CBIND_COOKIE);
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

/** Store a magic-code record in D1 auth_email_codes (S4).
 *
 * The code itself is stored as HMAC-SHA256 with the Worker pepper (a plain
 * hash of a 6-digit code reverses in milliseconds). attempts starts at 0
 * and is capped by the table CHECK, so the atomic increment on verify
 * cannot overrun. One live code per (email, purpose): any older live code
 * is superseded first. created_at defaults to now() in the database and
 * expires_at is now + 10 minutes, inside the 0023 life CHECK.
 *
 * Returns the browser-binding secret: its SHA-256 is stored in
 * browser_binding_hash, the secret itself only ever travels in the
 * __Host-brimwood-cbind cookie, so a code phished from the inbox cannot
 * be verified from another browser. */
async function storeCode(
  env: Bindings,
  c: any,
  email: string,
  code: string,
  userId: string | null
): Promise<string> {
  const DB = env.DB;
  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  const binding = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Supersede any older live code for this (email, purpose) first: the
  // partial unique index only admits one live row.
  await DB.prepare(
    `UPDATE auth_email_codes SET superseded_at = ?
     WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND superseded_at IS NULL`
  )
    .bind(new Date(now).toISOString(), email, CODE_PURPOSE)
    .run();
  await DB.prepare(
    `INSERT INTO auth_email_codes
       (id, email, user_id, purpose, code_hmac, browser_binding_hash, expires_at, ip_hmac)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      email,
      userId,
      CODE_PURPOSE,
      await codeHmac(env, "email-code", code),
      await sha256Hex(binding),
      expiresAt,
      await hmacSha256Hex(env.SESSION_SECRET as string, "brimwood/email-code-ip/v1:" + clientIp(c.req.raw))
    )
    .run();
  return binding;
}

/** Mark a code row consumed (single-use, expired, or locked out). The row
 * stays for the retention purge; the partial unique index frees the
 * (email, purpose) slot for the next code. */
async function consumeCode(DB: D1Database, id: string): Promise<void> {
  await DB.prepare(
    "UPDATE auth_email_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL"
  )
    .bind(new Date(Date.now()).toISOString(), id)
    .run();
}

interface CodeRow {
  id: string;
  email: string;
  user_id: string | null;
  code_hmac: string;
  browser_binding_hash: string;
  attempts: number;
  expires_at: string;
}

/** The one live code for this (email, purpose), or null. */
async function liveCode(DB: D1Database, email: string): Promise<CodeRow | null> {
  return DB.prepare(
    `SELECT id, email, user_id, code_hmac, browser_binding_hash, attempts, expires_at
     FROM auth_email_codes
     WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND superseded_at IS NULL`
  )
    .bind(email, CODE_PURPOSE)
    .first<CodeRow>();
}

app.post("/request-code", async (c) => {
  const { DB } = c.env;
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

  // Cryptographically secure 6-digit code, stored as HMAC in D1.
  const code = randomSixDigit();
  const binding = await storeCode(c.env, c, email, code, user.id);
  // Bind the code to this browser: the binding secret travels only in
  // this cookie, its hash sits in the code row.
  setBindingCookie(c, binding);

  // A Resend outage must not throw unhandled after the code is stored:
  // log the failure and return a clean 503. The code stays valid for its
  // 10-minute life, so retrying the request supersedes it with a fresh
  // code and a fresh email. Validity of the email is never revealed.
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
  const { DB } = c.env;
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

  const row = await liveCode(DB, email);
  if (!row) return c.json({ ok: false, error: "Code expired. Request a new one." }, 401);

  // Strict expiry from the row itself: failed attempts never extend the code's life.
  if (Date.parse(row.expires_at) <= Date.now()) {
    await consumeCode(DB, row.id);
    return c.json({ ok: false, error: "Code expired. Request a new one." }, 401);
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await consumeCode(DB, row.id);
    return c.json({ ok: false, error: "Too many attempts. Request a new code." }, 401);
  }

  // Both halves must match, and a failure reveals nothing about which half
  // broke: the code HMAC and the browser binding presented in the cookie.
  const bindingToken = getBindingToken(c);
  const codeOk = safeEqual(await codeHmac(c.env, "email-code", code), row.code_hmac);
  const bindingOk =
    typeof bindingToken === "string" &&
    bindingToken.length > 0 &&
    safeEqual(await sha256Hex(bindingToken), row.browser_binding_hash);
  if (!codeOk || !bindingOk) {
    // Atomic increment, guarded at the row: concurrent wrong guesses cannot
    // push attempts past 5 (the CHECK caps it too).
    await DB.prepare(
      "UPDATE auth_email_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?"
    )
      .bind(row.id, MAX_ATTEMPTS)
      .run();
    return c.json({ ok: false, error: "Invalid code." }, 401);
  }

  const user = await DB.prepare(
    "SELECT id, role FROM users WHERE email = ? AND status = 'active'"
  )
    .bind(email)
    .first<{ id: string; role: string }>();
  if (!user) {
    await consumeCode(DB, row.id);
    return c.json({ ok: false, error: "Invalid code." }, 401);
  }

  // Single-use: consume the code. If a racer consumed it first, the code is
  // spent and this attempt fails closed.
  const spent = await DB.prepare(
    "UPDATE auth_email_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL"
  )
    .bind(new Date(Date.now()).toISOString(), row.id)
    .run();
  if (spent.meta.changes === 0) {
    return c.json({ ok: false, error: "Invalid code." }, 401);
  }

  const token = await createSession(c.env, user.id, user.role, {
    amr: ["email_code"],
    uaSummary: summarizeUa(c.req.header("user-agent")),
    city: cfCity(c),
  });
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
  // an email is registered; the magic-code endpoint already behaves this way).
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

  // Send a magic sign-in code so they can sign in immediately. The code is
  // bound to this browser, like request-code: the invite was just redeemed
  // here, so this browser is the one that verifies.
  const resendKey = (c.env as Env).RESEND_API_KEY;
  if (resendKey) {
    const magicCode = randomSixDigit();
    const binding = await storeCode(c.env, c, email, magicCode, userId);
    setBindingCookie(c, binding);
    const html = shell(
      "Your Brimwood sign-in code",
      "Welcome to Brimwood.",
      "<p style=\"margin:0 0 8px;\">Welcome" + (name ? ", " + esc(name) : "") + ". Your invite code worked, and here is your sign-in code:</p>" +
        '<p style="font-size:36px;font-weight:700;letter-spacing:0.3em;color:#0C9463;margin:16px 0;">' + magicCode + "</p>" +
        '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">Use this code within 10 minutes. Build a business. Build yourself.</p>'
    );
    await sendEmail(resendKey, {
      to: email,
      subject: "Welcome to Brimwood: your sign-in code",
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
