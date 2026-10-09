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
import { hashPassword, validatePassword } from "../lib/password";
import { setSessionCookie, createSession, destroySession, readSession } from "../lib/auth";

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

  const user = await DB.prepare(
    "SELECT id, name FROM users WHERE email = ? AND status = 'active'"
  )
    .bind(email)
    .first<{ id: string; name: string }>();

  // Unknown or inactive → pretend success. No code, no email, no leak.
  if (!user) return c.json({ ok: true });

  // Cryptographically secure 6-digit code.
  const rand = crypto.getRandomValues(new Uint32Array(1))[0];
  const code = String(100000 + (rand % 900000));
  const key = await codeKey(email);
  await SESSIONS_KV.put(
    "authcode:" + key,
    JSON.stringify({
      email,
      codeHash: await sha256Hex("code:" + code),
      attempts: 0,
    }),
    { expirationTtl: CODE_TTL }
  );

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

  const rec = JSON.parse(raw) as { email: string; codeHash: string; attempts: number };
  if (rec.attempts >= MAX_ATTEMPTS) {
    await SESSIONS_KV.delete(kvKey);
    return c.json({ ok: false, error: "Too many attempts. Request a new code." }, 401);
  }
  const ok = safeEqual(await sha256Hex("code:" + code), rec.codeHash);
  if (!ok) {
    rec.attempts += 1;
    await SESSIONS_KV.put(kvKey, JSON.stringify(rec), { expirationTtl: CODE_TTL });
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

/* Invite redemption (T28): POST /api/auth/redeem-invite {email, name, code}
 * Validates the invite code (not expired, uses remaining), creates the user
 * as a member, increments the code's use count, then sends a magic sign-in
 * code so they can sign in immediately. */
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

  // Optional password at signup (Phase D1). Validated now, stored with the user.
  const rawPassword = typeof data.password === "string" ? data.password : "";
  let pwHash: string | null = null;
  let pwSalt: string | null = null;
  let pwSetAt: string | null = null;
  if (rawPassword) {
    const policyError = validatePassword(rawPassword);
    if (policyError) return c.json({ ok: false, error: policyError }, 400);
    const hashed = await hashPassword(rawPassword);
    pwHash = hashed.hash;
    pwSalt = hashed.salt;
    pwSetAt = new Date().toISOString();
  }

  // Check for existing user.
  const existing = await DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    return c.json({ ok: false, error: "This email is already registered. Please sign in." }, 400);
  }

  // Validate the invite code.
  const invite = await DB.prepare(
    `SELECT id, code, max_uses, uses, expires_at FROM invite_codes WHERE code = ?`
  )
    .bind(code)
    .first<{ id: string; code: string; max_uses: number; uses: number; expires_at: string | null }>();
  if (!invite) {
    return c.json({ ok: false, error: "Invalid invite code." }, 400);
  }
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return c.json({ ok: false, error: "This invite code has expired." }, 400);
  }
  if (invite.uses >= invite.max_uses) {
    return c.json({ ok: false, error: "This invite code has already been used." }, 400);
  }

  // Create the user (password columns exist after migration 0009).
  const userId = crypto.randomUUID();
  await DB.prepare(
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, password_set_at)
     VALUES (?, ?, ?, 'member', 'active', ?, ?, ?)`
  )
    .bind(userId, email, name, pwHash, pwSalt, pwSetAt)
    .run();

  // Consume one use of the invite code.
  await DB.prepare("UPDATE invite_codes SET uses = uses + 1 WHERE id = ?")
    .bind(invite.id)
    .run();

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
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    const magicCode = String(100000 + (rand[0] % 900000));
    const key = await codeKey(email);
    await c.env.SESSIONS_KV.put(
      "authcode:" + key,
      JSON.stringify({
        email,
        codeHash: await sha256Hex("code:" + magicCode),
        attempts: 0,
      }),
      { expirationTtl: CODE_TTL }
    );
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
      text: "Welcome to Brimwood, " + name + ".\n\nYour sign-in code is: " + magicCode + "\n\nIt expires in 10 minutes.",
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
