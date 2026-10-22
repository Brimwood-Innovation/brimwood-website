/* One auth module (F5, F9). All session handling lives here.
 * Sessions are keyed by SHA-256 of the token, never the raw token.
 * Since F9, sessions live in D1 (not KV): atomic, indexed per user,
 * zero KV writes per login.
 * Since Phase 1 item 6, sessions also carry the sign-in context (S6):
 * amr (factors used), auth_time (epoch ms of the real sign-in), is_staff,
 * ua_summary ("iPhone, Safari", never the full UA string), city (from
 * request.cf.city, no raw IP), device_id, and revoked_at/revoked_reason.
 * Staff sessions expire within 12 hours (P1-7, enforced by the
 * trg_sessions_staff_ttl trigger); everyone else keeps the 30-day TTL.
 * readSession JOINs users on every read: suspended/deleted users are locked
 * out immediately and the role is always live (never the login-time cache),
 * so demotion takes effect on the very next request everywhere.
 * Revoked sessions (revoked_at set) are rejected by readSession.
 */
import { getCookie, deleteCookie } from "hono/cookie";
import type { Bindings } from "../index";

export const COOKIE = "__Host-brimwood-sess";
const PREFIX = "sess:";
export const SESS_TTL = 30 * 24 * 3600;

/* __Host- prefix rules (F3): no Domain attribute, Path=/, Secure, and the
 * cookie is only ever set from an https response. All session cookies go
 * through setSessionCookie so the attributes cannot drift between routes. */
export const SESSION_COOKIE_ATTRS = "Path=/; HttpOnly; Secure; SameSite=Lax";

/** Set the session cookie with the exact hardened attributes:
 * `__Host-brimwood-sess=<token>; Path=/; HttpOnly; Secure; SameSite=Lax`.
 * SameSite=None branches were removed (F3): the site calls the API
 * same-origin, so cross-origin cookies are no longer needed. */
export function setSessionCookie(c: any, token: string): void {
  c.header("Set-Cookie", `${COOKIE}=${token}; ${SESSION_COOKIE_ATTRS}`, {
    append: true,
  });
}

export interface Session {
  userId: string;
  role: string;
  createdAt: number;
}

/** Optional sign-in context written by createSession (SCHEMA S6).
 * amr lists the factors used, for example ["email_code"] or ["passkey"].
 * deviceId is a devices.id row; null until the trusted-device flow lands. */
export interface SessionOptions {
  amr?: string[];
  uaSummary?: string | null;
  city?: string | null;
  deviceId?: string | null;
}

/** Twelve hours in milliseconds: the staff session cap (P1-7). The
 * trg_sessions_staff_ttl trigger aborts any staff insert past this. */
export const STAFF_SESS_TTL_MS = 12 * 3600 * 1000;

/** Summarize a User-Agent as "OS, Browser" (S6). The full UA string is
 * never stored: it is a fingerprinting-grade identifier. Unknown parts
 * fall back to "Unknown OS" / "Unknown browser"; a missing UA is null. */
export function summarizeUa(ua: string | null | undefined): string | null {
  if (!ua || !ua.trim()) return null;
  const s = ua;
  let os = "Unknown OS";
  if (/iPhone|iPad|iPod/i.test(s)) os = /iPad/i.test(s) ? "iPad" : "iPhone";
  else if (/Android/i.test(s)) os = "Android";
  else if (/Windows/i.test(s)) os = "Windows";
  else if (/Macintosh|Mac OS X/i.test(s)) os = "Mac";
  else if (/Linux/i.test(s)) os = "Linux";
  let browser = "Unknown browser";
  if (/EdgA?\/|EdgiOS/i.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(s)) browser = "Opera";
  else if (/FxiOS|Firefox/i.test(s)) browser = "Firefox";
  else if (/CriOS|CrOS|Chrome/i.test(s)) browser = "Chrome";
  else if (/Version\/.*Safari/i.test(s)) browser = "Safari";
  return `${os}, ${browser}`;
}

/** City from the Cloudflare request properties (S6). No raw IP is stored. */
export function cfCity(c: any): string | null {
  const city = c?.req?.raw?.cf?.city;
  if (typeof city !== "string" || !city.trim()) return null;
  return city.trim().slice(0, 120);
}

/** Context variables set by requireUser / requireAdmin. */
export type AuthVariables = {
  user: Session;
  admin: { id: string; email: string };
};

/** SHA-256 hex of a session token. Keys are never the raw token. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Create a session, return the raw token (set as cookie by the caller).
 *
 * Writes the S6 sign-in context: amr (factors used), auth_time (epoch ms of
 * this real sign-in), is_staff (1 for admin role), ua_summary, city,
 * device_id. Staff sessions expire within 12 hours (P1-7); the
 * trg_sessions_staff_ttl trigger aborts anything longer, so the cap is
 * enforced in the database as well as here. */
export async function createSession(
  env: Bindings,
  userId: string,
  role: string,
  opts: SessionOptions = {}
): Promise<string> {
  const token = crypto.randomUUID();
  const key = PREFIX + (await hashToken(token));
  const now = Date.now();
  const isStaff = role === "admin" ? 1 : 0;
  const ttlMs = isStaff === 1 ? STAFF_SESS_TTL_MS : SESS_TTL * 1000;
  await env.DB.prepare(
    `INSERT INTO sessions (key, user_id, role, created_at, expires_at,
      amr, auth_time, is_staff, ua_summary, city, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      key,
      userId,
      role,
      now,
      now + ttlMs,
      JSON.stringify(opts.amr ?? []),
      now,
      isStaff,
      opts.uaSummary ?? null,
      opts.city ?? null,
      opts.deviceId ?? null
    )
    .run();
  return token;
}

/** Read the session for the request cookie, or null.
 *
 * Joins users in the same query so that:
 * - suspended or deleted users lose access immediately (no waiting for the
 *   session TTL), and
 * - the returned role is always live, never the value cached in the
 *   session row at login.
 * Revoked sessions (s.revoked_at set, S6) are rejected here: sign-out-all,
 * lockdown, suspension and friends take effect on the very next request.
 * One indexed query; no extra round trip. */
export async function readSession(c: any): Promise<Session | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const row = (await c.env.DB.prepare(
    `SELECT s.user_id, u.role, s.created_at FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.key = ? AND s.expires_at > ? AND s.revoked_at IS NULL
       AND u.status = 'active'`
  )
    .bind(PREFIX + (await hashToken(token)), Date.now())
    .first()) as { user_id: string; role: string; created_at: number } | null;
  if (!row) return null;
  return { userId: row.user_id, role: row.role, createdAt: row.created_at };
}

/** Delete the session for the request cookie. */
export async function destroySession(c: any): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE key = ?")
      .bind(PREFIX + (await hashToken(token)))
      .run();
  }
  deleteCookie(c, COOKIE, { path: "/", secure: true });
}

/** Delete every session belonging to a user (password reset). Uses the
 * per-user index; cost scales with the user's sessions, not all members. */
export async function destroyUserSessions(
  env: Bindings,
  userId: string
): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
    .bind(userId)
    .run();
}

/** Delete every session belonging to a user EXCEPT the current one
 * (password change: the changer stays signed in, everyone else is kicked).
 * keepTokenHash is the SHA-256 hex of the current session token. */
export async function destroyOtherUserSessions(
  env: Bindings,
  userId: string,
  keepTokenHash: string
): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND key != ?")
    .bind(userId, PREFIX + keepTokenHash)
    .run();
}

/** Re-read the user's role from D1 and return true iff they are an active
 * admin. Authorization decisions MUST use this, never the role cached in
 * the session row, which can be stale for up to SESS_TTL after a demotion. */
export async function isAdminUser(c: any, userId: string): Promise<boolean> {
  const u: any = await c.env.DB.prepare(
    "SELECT role FROM users WHERE id = ? AND status = 'active'"
  )
    .bind(userId)
    .first();
  return !!u && u.role === "admin";
}

/** Delete expired sessions. Call from a scheduled job. */
export async function pruneSessions(env: Bindings): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?")
    .bind(Date.now())
    .run();
}

/**
 * Middleware: require a logged-in user. Sets c.get("user") to the Session.
 * Returns 401 JSON when there is no valid session.
 */
export async function requireUser(c: any, next: any) {
  const s = await readSession(c);
  if (!s) return c.json({ ok: false, error: "Sign in required." }, 401);
  c.set("user", s);
  await next();
}

/**
 * Helper for routes with mixed public/admin endpoints: returns { id, email }
 * for a valid admin session, or null. Re-reads the role from D1.
 */
export async function getAdminUser(
  c: any
): Promise<{ id: string; email: string } | null> {
  const s = await readSession(c);
  if (!s) return null;
  const u: any = await c.env.DB.prepare(
    "SELECT id, email, role FROM users WHERE id = ? AND status = 'active'"
  )
    .bind(s.userId)
    .first();
  if (!u || u.role !== "admin") return null;
  return { id: u.id, email: u.email };
}

/**
 * Helper: returns the session's userId, or null. For member-only endpoints.
 */
export async function getUserId(c: any): Promise<string | null> {
  const s = await readSession(c);
  return s ? s.userId : null;
}

/**
 * Middleware: require an admin. Re-reads the role from D1 on every call so
 * a demoted admin loses access on the next request. Sets c.get("admin") to
 * { id, email } for audit logging.
 */
export async function requireAdmin(c: any, next: any) {
  const s = await readSession(c);
  if (!s) return c.json({ ok: false, error: "Sign in required." }, 401);
  const u: any = await c.env.DB.prepare(
    "SELECT id, email, role FROM users WHERE id = ? AND status = 'active'"
  )
    .bind(s.userId)
    .first();
  if (!u || u.role !== "admin") {
    return c.json({ ok: false, error: "Admin only." }, 403);
  }
  c.set("admin", { id: u.id, email: u.email });
  c.set("user", s);
  await next();
}
