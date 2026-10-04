/* One auth module (F5, F9). All session handling lives here.
 * Sessions are keyed by SHA-256 of the token, never the raw token.
 * Since F9, sessions live in D1 (not KV): atomic, indexed per user,
 * zero KV writes per login.
 * Admin checks re-read the role from D1 so demotion takes effect immediately.
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

/** Create a session, return the raw token (set as cookie by the caller). */
export async function createSession(
  env: Bindings,
  userId: string,
  role: string
): Promise<string> {
  const token = crypto.randomUUID();
  const key = PREFIX + (await hashToken(token));
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (key, user_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(key, userId, role, now, now + SESS_TTL * 1000)
    .run();
  return token;
}

/** Read the session for the request cookie, or null. */
export async function readSession(c: any): Promise<Session | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const row = (await c.env.DB.prepare(
    "SELECT user_id, role, created_at FROM sessions WHERE key = ? AND expires_at > ?"
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
