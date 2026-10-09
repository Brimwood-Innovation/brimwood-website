/* Admin API (T28, T29): intro triage, subscribers, invites, audit log.
 * All endpoints require admin role. Every mutation writes to audit_log.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { requireAdmin, type AuthVariables } from "../lib/auth";

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

/* Every admin endpoint requires a fresh admin role check (F5). */
app.use(requireAdmin);

async function audit(c: any, admin: { id: string; email: string }, action: string, detail: string) {
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), admin.id, action, `${admin.email}: ${detail}`)
    .run();
}

/* --- Introduction requests --- */

app.get("/intros", async (c) => {
  const admin = c.get("admin");
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
  const admin = c.get("admin");
  const { DB } = c.env;
  const id = c.req.param("id");
  const { status } = await c.req.json().catch(() => ({}));
  if (!["new", "contacted", "archived"].includes(status)) {
    return c.json({ ok: false, error: "Invalid status" }, 400);
  }
  const existing = await DB.prepare("SELECT id FROM introduction_requests WHERE id = ?")
    .bind(id)
    .first();
  if (!existing) return c.json({ ok: false, error: "Intro not found" }, 404);
  await DB.prepare("UPDATE introduction_requests SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
  await audit(c, admin!, "intro.status", `${id} → ${status}`);
  return c.json({ ok: true });
});

/* --- Subscribers --- */

app.get("/subscribers", async (c) => {
  const admin = c.get("admin");
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
  const admin = c.get("admin");
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT ic.id, ic.code, ic.max_uses, ic.uses, ic.expires_at, ic.created_at, u.email as created_by
     FROM invite_codes ic LEFT JOIN users u ON u.id = ic.created_by
     ORDER BY ic.created_at DESC LIMIT 100`
  ).all();
  return c.json({ ok: true, invites: rows.results });
});

app.post("/invites", async (c) => {
  const admin = c.get("admin");
  const { DB } = c.env;
  const { max_uses, expires_days } = await c.req.json().catch(() => ({}));
  /* Validate inputs: a 0/negative max_uses would create an instantly-dead
   * code, and negative expires_days an already-expired one. */
  const uses = max_uses === undefined || max_uses === null ? 1 : Number(max_uses);
  if (!Number.isInteger(uses) || uses < 1 || uses > 100) {
    return c.json({ ok: false, error: "max_uses must be an integer from 1 to 100" }, 400);
  }
  let expires_at: string | null = null;
  if (expires_days !== undefined && expires_days !== null) {
    const days = Number(expires_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return c.json({ ok: false, error: "expires_days must be an integer from 1 to 365" }, 400);
    }
    expires_at = new Date(Date.now() + days * 86400000).toISOString();
  }
  const code = "BRM-" + crypto.randomUUID().slice(0, 8).toUpperCase();
  await DB.prepare(
    `INSERT INTO invite_codes (id, code, created_by, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), code, admin!.id, uses, expires_at)
    .run();
  await audit(c, admin!, "invite.create", `${code} (max_uses=${uses}${expires_at ? `, expires ${expires_at.slice(0, 10)}` : ", no expiry"})`);
  return c.json({ ok: true, code });
});

/* Revoke an invite code (e.g. leaked). Redeems after this point fail. */
app.delete("/invites/:id", async (c) => {
  const admin = c.get("admin");
  const { DB } = c.env;
  const id = c.req.param("id");
  const row = await DB.prepare("SELECT code FROM invite_codes WHERE id = ?")
    .bind(id)
    .first<{ code: string }>();
  if (!row) return c.json({ ok: false, error: "Invite not found" }, 404);
  await DB.prepare("DELETE FROM invite_codes WHERE id = ?").bind(id).run();
  await audit(c, admin!, "invite.revoke", row.code);
  return c.json({ ok: true });
});

/* --- Users --- */

app.get("/users", async (c) => {
  const admin = c.get("admin");
  const { DB } = c.env;
  const q = (c.req.query("q") || "").slice(0, 100);
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "25", 10) || 25));
  const offset = (page - 1) * limit;
  let where = "";
  const binds: any[] = [];
  if (q) {
    where = "WHERE email LIKE ? OR name LIKE ? OR display_name LIKE ?";
    const like = `%${q.replace(/[%_]/g, "")}%`;
    binds.push(like, like, like);
  }
  const rows = await DB.prepare(
    `SELECT id, email, name, role, status, display_name, show_profile, created_at
     FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all();
  const count: any = await DB.prepare(`SELECT COUNT(*) AS n FROM users ${where}`)
    .bind(...binds)
    .first();
  return c.json({ ok: true, users: rows.results, page, limit, total: count?.n || 0 });
});

/* --- Audit log --- */

app.get("/audit", async (c) => {
  const admin = c.get("admin");
  const { DB } = c.env;
  /* Actor is first-class: join users for the actor email. audit_log is
   * append-only (see migration 0012), so entries cannot be rewritten. */
  const rows = await DB.prepare(
    `SELECT a.action, a.target, a.detail, a.actor_id, u.email AS actor_email, a.created_at
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC LIMIT 100`
  ).all();
  return c.json({ ok: true, log: rows.results });
});

export default app;
