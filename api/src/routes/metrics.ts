/* Admin metrics endpoint (T20): aggregate counts for the analytics dashboard.
 * Admin-only: requires a valid session with role='admin'. */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { requireAdmin, type AuthVariables } from "../lib/auth";

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

app.use(requireAdmin);

app.get("/", async (c) => {

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
