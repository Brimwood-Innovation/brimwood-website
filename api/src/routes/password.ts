/* Password authentication (Phase D1): email + password alongside magic codes.
 * POST /api/auth/login {email, password} → session cookie (same as magic-code)
 * POST /api/auth/password/set → initial password for existing users (authed)
 * POST /api/auth/password/change → change password (authed, needs current)
 * POST /api/auth/password/reset/request {email} → reset email (no enumeration)
 * POST /api/auth/password/reset/confirm {token, newPassword}
 * Logout reuses POST /api/auth/logout in auth.ts.
 * Security: PBKDF2-SHA256 600k iterations; generic errors (no enumeration);
 * strict rate limits; reset tokens are hashed at rest, single-use, 30-min TTL;
 * password changes/resets are audit-logged. Never log passwords. */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { sendEmail, shell, button, esc, SITE } from "../lib/email";
import { cleanStr, isEmail, clientIp, sha256Hex } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { hashPassword, verifyPassword, validatePassword } from "../lib/password";
import { setSessionCookie, createSession, readSession, destroyUserSessions, destroyOtherUserSessions, hashToken, COOKIE } from "../lib/auth";
import { getCookie } from "hono/cookie";

type Env = Bindings & {
  RESEND_API_KEY?: string;
  SESSIONS_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();
const RESET_TTL_MIN = 30;

const GENERIC_FAIL = "Invalid email or password.";

/* Timing-equalization padding for the login failure paths. A real password
 * verification burns ~600k PBKDF2 iterations; without padding, unknown-email
 * / suspended / no-password failures return much faster than wrong-password
 * failures, letting an attacker distinguish registered emails by timing.
 * The dummy values below are NOT secrets — they exist only to burn the same
 * CPU cost as a real verification. */
const DUMMY_SALT_HEX = [...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const DUMMY_HASH_HEX = "f".repeat(64);

/** Burn one PBKDF2 verification's worth of CPU. Call on every login failure
 * path that skips the real verifyPassword, before returning GENERIC_FAIL. */
async function burnDummyVerify(): Promise<void> {
  await verifyPassword("dummy-password-for-timing", DUMMY_SALT_HEX, DUMMY_HASH_HEX);
}

/** Resolve the current session from the cookie, or null. */
async function sessionUser(c: any) {
  const s = await readSession(c);
  return s && s.userId ? s : null;
}

/** Create a session + set the cookie (same mechanism as magic-code verify). */
async function setSessionCookieFor(c: any, userId: string, role: string) {
  const token = await createSession(c.env, userId, role);
  setSessionCookie(c, token);
}

async function audit(
  DB: D1Database,
  actorId: string,
  action: string,
  detail: string
) {
  await DB.prepare("INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorId, action, detail)
    .run()
    .catch(() => {});
}

async function jsonBody(c: any): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ---------------- Login ---------------- */

/** POST /login {email, password} → session cookie. Generic errors only. */
app.post("/login", async (c) => {
  const { DB, SESSIONS_KV } = c.env;
  const ip = clientIp(c.req.raw);
  if (!(await checkRateLimitD1(DB, "pwlogin:" + ip, 10, 900))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  const data = await jsonBody(c);
  if (!data) return c.json({ ok: false }, 400);
  const email = cleanStr(data.email, 200).toLowerCase();
  const password = typeof data.password === "string" ? data.password : "";
  if (!isEmail(email) || !password) {
    await burnDummyVerify();
    return c.json({ ok: false, error: GENERIC_FAIL }, 401);
  }

  // Per-email throttle (anti brute-force) — checked before the DB lookup
  // result is revealed, error stays generic either way.
  if (!(await checkRateLimitD1(DB, "pwlogin:email:" + email, 5, 3600))) {
    return c.json({ ok: false, error: GENERIC_FAIL }, 401);
  }

  const user = await DB.prepare(
    "SELECT id, role, status, password_hash, password_salt FROM users WHERE email = ?"
  )
    .bind(email)
    .first<{
      id: string;
      role: string;
      status: string;
      password_hash: string | null;
      password_salt: string | null;
    }>();
  // Unknown email, suspended account, or no password set → identical
  // response AND identical timing: burn a dummy PBKDF2 verify so response
  // times don't reveal whether the email is registered.
  if (!user || user.status !== "active" || !user.password_hash || !user.password_salt) {
    await burnDummyVerify();
    return c.json({ ok: false, error: GENERIC_FAIL }, 401);
  }

  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    return c.json({ ok: false, error: GENERIC_FAIL }, 401);
  }

  await setSessionCookieFor(c, user.id, user.role);
  return c.json({ ok: true });
});

/* ---------------- Set initial password ---------------- */

/** POST /password/set {password} — authenticated; for users without one yet. */
app.post("/password/set", async (c) => {
  const { DB } = c.env;
  if (!(await checkRateLimitD1(DB, "pwset:" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }
  const sess = await sessionUser(c);
  if (!sess) return c.json({ ok: false, error: "Not signed in." }, 401);

  const data = await jsonBody(c);
  if (!data) return c.json({ ok: false }, 400);
  const password = typeof data.password === "string" ? data.password : "";
  const policyError = validatePassword(password);
  if (policyError) return c.json({ ok: false, error: policyError }, 400);

  const user = await DB.prepare("SELECT id, password_hash FROM users WHERE id = ?")
    .bind(sess.userId)
    .first<{ id: string; password_hash: string | null }>();
  if (!user) return c.json({ ok: false, error: "Not signed in." }, 401);
  if (user.password_hash) {
    return c.json(
      { ok: false, error: "A password is already set. Use change password instead." },
      400
    );
  }

  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  await DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, updated_at = ? WHERE id = ?"
  )
    .bind(hash, salt, now, now, user.id)
    .run();
  await audit(DB, user.id, "password.set", "Initial password set");
  return c.json({ ok: true });
});

/* ---------------- Change password ---------------- */

/** POST /password/change {currentPassword, newPassword} — authenticated. */
app.post("/password/change", async (c) => {
  const { DB } = c.env;
  if (!(await checkRateLimitD1(DB, "pwchange:" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }
  const sess = await sessionUser(c);
  if (!sess) return c.json({ ok: false, error: "Not signed in." }, 401);

  const data = await jsonBody(c);
  if (!data) return c.json({ ok: false }, 400);
  const currentPassword = typeof data.currentPassword === "string" ? data.currentPassword : "";
  const newPassword = typeof data.newPassword === "string" ? data.newPassword : "";
  const policyError = validatePassword(newPassword);
  if (policyError) return c.json({ ok: false, error: policyError }, 400);

  const user = await DB.prepare(
    "SELECT id, password_hash, password_salt FROM users WHERE id = ? AND status = 'active'"
  )
    .bind(sess.userId)
    .first<{ id: string; password_hash: string | null; password_salt: string | null }>();
  if (!user || !user.password_hash || !user.password_salt) {
    return c.json({ ok: false, error: "No password is set on this account." }, 400);
  }
  const ok = await verifyPassword(currentPassword, user.password_salt, user.password_hash);
  if (!ok) {
    return c.json({ ok: false, error: "Current password is incorrect." }, 401);
  }

  const { hash, salt } = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, updated_at = ? WHERE id = ?"
  )
    .bind(hash, salt, now, now, user.id)
    .run();
  // A password change kicks every OTHER session: the changer stays signed
  // in, but anything else using the old credential is invalidated.
  const currentToken = getCookie(c, COOKIE);
  if (currentToken) {
    await destroyOtherUserSessions(c.env, user.id, await hashToken(currentToken));
  } else {
    await destroyUserSessions(c.env, user.id);
  }
  await audit(DB, user.id, "password.change", "Password changed");
  return c.json({ ok: true });
});

/* ---------------- Reset via email ---------------- */

/** POST /password/reset/request {email} — always returns ok (no enumeration). */
app.post("/password/reset/request", async (c) => {
  const { DB } = c.env;
  const resendKey = (c.env as Env).RESEND_API_KEY;
  if (!(await checkRateLimitD1(DB, "pwreset:" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  const data = await jsonBody(c);
  if (!data) return c.json({ ok: false }, 400);
  const email = cleanStr(data.email, 200).toLowerCase();

  // Per-email throttle (inbox-bombing defence): respond ok either way so the
  // throttle itself doesn't reveal anything.
  if (isEmail(email)) {
    if (!(await checkRateLimitD1(DB, "pwreset:email:" + email, 3, 3600))) {
      return c.json({ ok: true });
    }
  }

  // Always respond ok — never reveal whether the email exists.
  if (isEmail(email) && resendKey) {
    const user = await DB.prepare(
      "SELECT id, name FROM users WHERE email = ? AND status = 'active'"
    )
      .bind(email)
      .first<{ id: string; name: string }>();
    if (user) {
      // Invalidate previously issued, still-unused tokens: only one live
      // reset link per user at a time.
      await DB.prepare(
        "DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL"
      )
        .bind(user.id)
        .run();
      const rawToken = toHexToken();
      const tokenHash = await sha256Hex("pwreset:" + rawToken);
      const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000).toISOString();
      await DB.prepare(
        "INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), user.id, tokenHash, expiresAt)
        .run();
      const site = SITE(c.env as { SITE_URL?: string });
      const resetUrl = site + "/reset-password?token=" + encodeURIComponent(rawToken);
      await sendEmail(resendKey, {
        to: email,
        subject: "Reset your Brimwood password",
        html: shell(
          "Reset your password",
          "This link expires in 30 minutes.",
          "<p style=\"margin:0 0 16px;\">Hello" + (user.name ? " " + esc(user.name) : "") + ",</p>" +
            "<p style=\"margin:0 0 16px;\">We received a request to reset your Brimwood password. This link expires in 30 minutes:</p>" +
            button(resetUrl, "Reset password") +
            '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">If you did not request this, just ignore it — your password will not change.</p>'
        ),
        text:
          "We received a request to reset your Brimwood password.\n\n" +
          resetUrl +
          "\n\nThis link expires in 30 minutes. If you did not request this, just ignore it.",
      }).catch(() => {});
    }
  }
  return c.json({ ok: true });
});

function toHexToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST /password/reset/confirm {token, newPassword} — single-use, 30-min TTL. */
app.post("/password/reset/confirm", async (c) => {
  const { DB, SESSIONS_KV } = c.env;
  if (!(await checkRateLimitD1(DB, "pwconfirm:" + clientIp(c.req.raw), 10, 900))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  const data = await jsonBody(c);
  if (!data) return c.json({ ok: false }, 400);
  const token = typeof data.token === "string" ? data.token.trim() : "";
  const newPassword = typeof data.newPassword === "string" ? data.newPassword : "";
  const policyError = validatePassword(newPassword);
  if (policyError) return c.json({ ok: false, error: policyError }, 400);
  if (!token) return c.json({ ok: false, error: "Invalid or expired reset link." }, 400);

  const tokenHash = await sha256Hex("pwreset:" + token);
  const rec = await DB.prepare(
    `SELECT id, user_id, expires_at, used_at FROM password_resets
     WHERE token_hash = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();
  const nowIso = new Date().toISOString();
  if (!rec || rec.used_at || rec.expires_at <= nowIso) {
    // Generic: expired, used, or unknown all look the same.
    return c.json({ ok: false, error: "Invalid or expired reset link." }, 400);
  }

  const user = await DB.prepare("SELECT id, status FROM users WHERE id = ?")
    .bind(rec.user_id)
    .first<{ id: string; status: string }>();
  if (!user || user.status !== "active") {
    return c.json({ ok: false, error: "Invalid or expired reset link." }, 400);
  }

  const { hash, salt } = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, updated_at = ? WHERE id = ?"
  )
    .bind(hash, salt, now, now, user.id)
    .run();
  await DB.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?")
    .bind(now, rec.id)
    .run();
  // A reset invalidates every existing session for this user.
  await destroyUserSessions(c.env, user.id);
  await audit(DB, user.id, "password.reset", "Password reset via email link");
  return c.json({ ok: true });
});

export default app;
