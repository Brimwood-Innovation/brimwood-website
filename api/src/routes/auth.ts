/* Magic-link auth (T18): 6-digit codes, 10-min expiry, KV sessions.
 * POST /api/auth/request-code {email} → sends code iff email is a known active user
 * POST /api/auth/verify-code {email, code} → sets httpOnly session cookie
 * POST /api/auth/logout → clears session
 * Security: codes are SHA-256 hashed in KV; existence of an email is never
 * revealed; auth endpoints are strictly rate-limited; sessions are
 * httpOnly + secure + sameSite=lax cookies. */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Bindings } from "../index";
import { sendEmail, shell, esc } from "../lib/email";
import { cleanStr, isEmail, clientIp, sha256Hex } from "../lib/validate";
import { checkRateLimit } from "../lib/ratelimit";

type Env = Bindings & {
  RESEND_API_KEY?: string;
  SESSIONS_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();
const COOKIE = "brimwood_sess";
const CODE_TTL = 600; // 10 minutes
const SESS_TTL = 30 * 86400; // 30 days
const MAX_ATTEMPTS = 5;

function codeKey(email: string) {
  return sha256Hex("authcode:" + email.toLowerCase());
}

app.post("/request-code", async (c) => {
  const { DB, SESSIONS_KV, RATE_LIMIT_KV } = c.env;
  const resendKey = c.env.RESEND_API_KEY;
  if (!resendKey) return c.json({ ok: false }, 500);

  // Strict rate limit on the auth endpoint (security skill: ~10/15min).
  if (!(await checkRateLimit(RATE_LIMIT_KV, "authreq:" + clientIp(c.req.raw), 10, 900))) {
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
  await DB.prepare(
    "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'auth-code', ?, ?, 'sent')"
  )
    .bind(crypto.randomUUID(), email, "Your Brimwood sign-in code")
    .run();

  return c.json({ ok: true });
});

app.post("/verify-code", async (c) => {
  const { DB, SESSIONS_KV, RATE_LIMIT_KV } = c.env;
  if (!(await checkRateLimit(RATE_LIMIT_KV, "authver:" + clientIp(c.req.raw), 10, 900))) {
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
  const ok = (await sha256Hex("code:" + code)) === rec.codeHash;
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
  const token = crypto.randomUUID();
  await SESSIONS_KV.put(
    "sess:" + token,
    JSON.stringify({ userId: user.id, role: user.role, createdAt: Date.now() }),
    { expirationTtl: SESS_TTL }
  );
  // SameSite=None for cross-origin staging (preview → worker); Lax for same-origin.
  const origin = c.req.header("origin") || "";
  const crossOrigin = origin && !origin.includes("workers.dev");
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: crossOrigin ? "None" : "Lax",
    path: "/",
    maxAge: SESS_TTL,
  });
  return c.json({ ok: true });
});

app.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.SESSIONS_KV.delete("sess:" + token);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const cookie = c.req.header("cookie") || "";
  const m = cookie.match(new RegExp(COOKIE + "=([^;]+)"));
  if (!m) return c.json({ ok: false }, 401);
  const raw = await c.env.SESSIONS_KV.get("sess:" + m[1]);
  if (!raw) return c.json({ ok: false }, 401);
  const sess = JSON.parse(raw) as { userId: string; role: string };
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, role FROM users WHERE id = ? AND status = 'active'"
  )
    .bind(sess.userId)
    .first<{ id: string; email: string; name: string; role: string }>();
  if (!user) return c.json({ ok: false }, 401);
  return c.json({ ok: true, user });
});

/** Auth middleware for protected routes: resolves the session or 401s. */
export async function requireAuth(
  c: { env: Env; req: { header: (n: string) => string | undefined } },
  next: () => Promise<Response>
): Promise<Response> {
  const cookie = c.req.header("cookie") || "";
  const m = cookie.match(new RegExp(COOKIE + "=([^;]+)"));
  if (!m) {
    return new Response(JSON.stringify({ ok: false, error: "Not signed in." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const raw = await c.env.SESSIONS_KV.get("sess:" + m[1]);
  if (!raw) {
    return new Response(JSON.stringify({ ok: false, error: "Session expired." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return next();
}

export default app;
