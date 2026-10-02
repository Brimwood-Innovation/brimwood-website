/* Admin API (T28, T29): intro triage, subscribers, invites, audit log.
 * All endpoints require admin role. Every mutation writes to audit_log.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();
const COOKIE = "brimwood_sess";

async function adminUser(c: any): Promise<{ id: string; email: string } | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const raw = await c.env.SESSIONS_KV.get("sess:" + token);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s.role !== "admin") return null;
    // Get email for audit log.
    const u: any = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(s.userId)
      .first();
    return { id: s.userId, email: u?.email || "unknown" };
  } catch {
    return null;
  }
}

async function audit(c: any, admin: { id: string; email: string }, action: string, detail: string) {
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), admin.id, action, `${admin.email}: ${detail}`)
    .run();
}

function needAdmin(c: any, admin: any) {
  if (!admin) return c.json({ ok: false, error: "Admin only" }, 403);
  return null;
}

/* --- Introduction requests --- */

app.get("/intros", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const status = c.req.query("status") || "new";
  const rows = await DB.prepare(
    `SELECT id, name, email, referral, message, status, created_at
     FROM introduction_requests WHERE status = ? ORDER BY created_at DESC LIMIT 100`
  )
    .bind(status)
    .all();
  const counts = await DB.prepare(
    `SELECT status, COUNT(*) as n FROM introduction_requests GROUP BY status`
  ).all();
  return c.json({ ok: true, intros: rows.results, counts: counts.results });
});

app.post("/intros/:id", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const id = c.req.param("id");
  const { status } = await c.req.json().catch(() => ({}));
  if (!["new", "contacted", "archived"].includes(status)) {
    return c.json({ ok: false, error: "Invalid status" }, 400);
  }
  await DB.prepare("UPDATE introduction_requests SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
  await audit(c, admin!, "intro.status", `${id} → ${status}`);
  return c.json({ ok: true });
});

/* --- Subscribers --- */

app.get("/subscribers", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const status = c.req.query("status") || "active";
  const rows = await DB.prepare(
    `SELECT id, email, name, status, subscribed_at, created_at
     FROM newsletter_subscribers WHERE status = ? ORDER BY created_at DESC LIMIT 200`
  )
    .bind(status)
    .all();
  const counts = await DB.prepare(
    `SELECT status, COUNT(*) as n FROM newsletter_subscribers GROUP BY status`
  ).all();
  return c.json({ ok: true, subscribers: rows.results, counts: counts.results });
});

/* --- Invite codes --- */

app.get("/invites", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT ic.id, ic.code, ic.max_uses, ic.uses, ic.expires_at, ic.created_at, u.email as created_by
     FROM invite_codes ic LEFT JOIN users u ON u.id = ic.created_by
     ORDER BY ic.created_at DESC LIMIT 100`
  ).all();
  return c.json({ ok: true, invites: rows.results });
});

app.post("/invites", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const { max_uses, expires_days } = await c.req.json().catch(() => ({}));
  const code = "BRM-" + crypto.randomUUID().slice(0, 8).toUpperCase();
  const expires_at = expires_days
    ? new Date(Date.now() + expires_days * 86400000).toISOString()
    : null;
  await DB.prepare(
    `INSERT INTO invite_codes (id, code, created_by, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), code, admin!.id, max_uses || 1, expires_at)
    .run();
  await audit(c, admin!, "invite.create", code);
  return c.json({ ok: true, code });
});

/* --- Users --- */

app.get("/users", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT id, email, name, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 200`
  ).all();
  return c.json({ ok: true, users: rows.results });
});

/* --- Audit log --- */

app.get("/audit", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT action, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT 100`
  ).all();
  return c.json({ ok: true, log: rows.results });
});

export default app;
