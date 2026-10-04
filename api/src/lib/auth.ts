/* One auth module (F5). All session handling lives here.
 * Sessions are keyed by SHA-256 of the token, never the raw token.
 * Admin checks re-read the role from D1 so demotion takes effect immediately.
 */
import { getCookie, deleteCookie } from "hono/cookie";
import type { Bindings } from "../index";

export const COOKIE = "brimwood_sess";
const PREFIX = "sess:";
export const SESS_TTL = 30 * 24 * 3600;

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
  await env.SESSIONS_KV.put(
    key,
    JSON.stringify({ userId, role, createdAt: Date.now() } as Session),
    { expirationTtl: SESS_TTL }
  );
  return token;
}

/** Read the session for the request cookie, or null. */
export async function readSession(c: any): Promise<Session | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const raw = await c.env.SESSIONS_KV.get(PREFIX + (await hashToken(token)));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

/** Delete the session for the request cookie. */
export async function destroySession(c: any): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) {
    await c.env.SESSIONS_KV.delete(PREFIX + (await hashToken(token)));
  }
  deleteCookie(c, COOKIE, { path: "/" });
}

/** Delete a single session by its raw token (used by password reset). */
export async function destroySessionByToken(
  env: Bindings,
  token: string
): Promise<void> {
  await env.SESSIONS_KV.delete(PREFIX + (await hashToken(token)));
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
