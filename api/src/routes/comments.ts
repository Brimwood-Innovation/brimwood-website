/* Moderated blog comments.
 * Mounted by the first mate at "/api" (same convention as routes/media.ts):
 * Public:
 *   POST /api/comments {post_slug, name, email, body, cf-turnstile-response}
 *     → validated, Turnstile-checked, stored as pending. Always {ok:true}
 *       so the moderation state is never revealed to submitters.
 *   GET  /api/comments/:slug → approved comments (name, body, created_at).
 * Admin (admin session required):
 *   GET   /api/admin/comments?status=pending → moderation queue.
 *   PATCH /api/admin/comments/:id {status} → approve / spam.
 *
 * Commenter emails are stored for moderation context but never exposed
 * by any public endpoint.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";
import { cleanStr, isEmail, clientIp } from "../lib/validate";
import { checkRateLimit } from "../lib/ratelimit";
import { verifyTurnstile } from "../lib/turnstile";

const app = new Hono<{ Bindings: Bindings }>();
const COOKIE = "brimwood_sess";

/* Admin helpers (same pattern as routes/admin.ts and routes/media.ts). */
async function adminUser(c: any): Promise<{ id: string; email: string } | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const raw = await c.env.SESSIONS_KV.get("sess:" + token);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s.role !== "admin") return null;
    const u: any = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(s.userId)
      .first();
    return { id: s.userId, email: u?.email || "unknown" };
  } catch {
    return null;
  }
}

function needAdmin(c: any, admin: any) {
  if (!admin) return c.json({ ok: false, error: "Admin only" }, 403);
  return null;
}

/* --- Public: submit a comment (held for moderation) --- */

app.post("/comments", async (c) => {
  const { DB, RATE_LIMIT_KV } = c.env;

  if (!(await checkRateLimit(RATE_LIMIT_KV, "comment:" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }

  const postSlug = cleanStr(data.post_slug, 200);
  const name = cleanStr(data.name, 100);
  const email = cleanStr(data.email, 200).toLowerCase();
  const body = cleanStr(data.body, 2000);

  if (!postSlug) return c.json({ ok: false, error: "Missing post." }, 400);
  if (name.length < 2) {
    return c.json({ ok: false, error: "Please include your name." }, 400);
  }
  if (!isEmail(email)) {
    return c.json({ ok: false, error: "Please enter a valid email address." }, 400);
  }
  if (body.length < 10) {
    return c.json({ ok: false, error: "Your comment is a little short — please write a bit more." }, 400);
  }

  // Turnstile bot check (fails closed).
  const turnstile = await verifyTurnstile(
    data["cf-turnstile-response"],
    (c.env as Bindings & { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY,
    clientIp(c.req.raw)
  );
  if (!turnstile.ok) {
    return c.json({ ok: false, error: turnstile.error }, 400);
  }

  await DB.prepare(
    `INSERT INTO comments (id, post_slug, name, email, body, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  )
    .bind(crypto.randomUUID(), postSlug, name, email, body)
    .run();

  // Always the same response — never reveal moderation state.
  return c.json({ ok: true });
});

/* --- Public: approved comments for a post --- */

app.get("/comments/:slug", async (c) => {
  const { DB } = c.env;
  const slug = cleanStr(c.req.param("slug"), 200);
  if (!slug) return c.json({ ok: false }, 400);

  const rows = await DB.prepare(
    `SELECT name, body, created_at FROM comments
     WHERE post_slug = ? AND status = 'approved'
     ORDER BY created_at ASC LIMIT 100`
  )
    .bind(slug)
    .all();

  // Emails are never exposed publicly.
  return c.json({ ok: true, comments: rows.results });
});

/* --- Admin: moderation queue --- */

app.get("/admin/comments", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;

  const status = c.req.query("status") || "pending";
  if (!["pending", "approved", "spam"].includes(status)) {
    return c.json({ ok: false, error: "Invalid status." }, 400);
  }

  const rows = await DB.prepare(
    `SELECT id, post_slug, name, email, body, status, created_at FROM comments
     WHERE status = ? ORDER BY created_at DESC LIMIT 100`
  )
    .bind(status)
    .all();
  const counts = await DB.prepare(
    `SELECT status, COUNT(*) as n FROM comments GROUP BY status`
  ).all();

  return c.json({ ok: true, comments: rows.results, counts: counts.results });
});

/* --- Admin: approve or mark spam --- */

app.patch("/admin/comments/:id", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;

  const id = cleanStr(c.req.param("id"), 50);
  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  const status = cleanStr(data.status, 20);
  if (!["approved", "spam"].includes(status)) {
    return c.json({ ok: false, error: "Status must be approved or spam." }, 400);
  }

  const existing = await DB.prepare("SELECT post_slug, name FROM comments WHERE id = ?")
    .bind(id)
    .first<{ post_slug: string; name: string }>();
  if (!existing) return c.json({ ok: false, error: "Comment not found." }, 404);

  await DB.prepare("UPDATE comments SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();

  await DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), admin!.id, "comment." + status, `${admin!.email}: ${existing.name} on ${existing.post_slug}`)
    .run();

  return c.json({ ok: true });
});

export default app;
