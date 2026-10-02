/* Admin metrics endpoint (T20): aggregate counts for the analytics dashboard.
 * Admin-only: requires a valid session with role='admin'. */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";

type Env = Bindings & { SESSIONS_KV: KVNamespace };
const app = new Hono<{ Bindings: Env }>();
const COOKIE = "brimwood_sess";

async function requireAdmin(c: {
  env: Env;
  req: { header: (n: string) => string | undefined };
  json: (o: object, s?: number) => Response;
}): Promise<{ id: string; role: string } | null> {
  const cookie = c.req.header("cookie") || "";
  const m = cookie.match(new RegExp(COOKIE + "=([^;]+)"));
  if (!m) return null;
  const raw = await c.env.SESSIONS_KV.get("sess:" + m[1]);
  if (!raw) return null;
  const sess = JSON.parse(raw) as { userId: string; role: string };
  if (sess.role !== "admin") return null;
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
    .bind(sess.userId)
    .first<{ id: string }>();
  return user ? { id: user.id, role: sess.role } : null;
}

app.get("/", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ ok: false, error: "Forbidden." }, 403);

  const { DB } = c.env;
  const [intro, news, users, emails] = await DB.batch([
    DB.prepare("SELECT status, COUNT(*) AS n FROM introduction_requests GROUP BY status"),
    DB.prepare("SELECT status, COUNT(*) AS n FROM newsletter_subscribers GROUP BY status"),
    DB.prepare("SELECT role, COUNT(*) AS n FROM users GROUP BY role"),
    DB.prepare("SELECT kind, status, COUNT(*) AS n FROM email_log GROUP BY kind, status"),
  ]);

  const toMap = (rows: Record<string, unknown>[], k: string): Record<string, number> =>
    Object.fromEntries(rows.map((r) => [String(r[k]), r.n as number]));

  return c.json({
    ok: true,
    introductionRequests: toMap(intro.results as unknown as Record<string, unknown>[], "status"),
    newsletterSubscribers: toMap(news.results as unknown as Record<string, unknown>[], "status"),
    users: toMap(users.results as unknown as Record<string, unknown>[], "role"),
    emailLog: (emails.results as { kind: string; status: string; n: number }[]).map((r) => ({
      kind: r.kind,
      status: r.status,
      count: r.n,
    })),
    generatedAt: new Date().toISOString(),
  });
});

export default app;
