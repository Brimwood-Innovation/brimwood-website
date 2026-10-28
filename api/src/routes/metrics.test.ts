/* Route tests: admin metrics - admin gates (including demoted admins),
 * the four aggregate queries in one batch, and the response shape
 * (status/role maps, email log rows, generatedAt). Phase 5 slice 4: the
 * metrics route previously had no dedicated test file (cycle 33 grading).
 *
 * Note on the fake: the shared mock D1 batch returns run results, which
 * carry no SELECT rows, so this file wraps prepare to remember each
 * statement's SQL and serves canned aggregates from batch. The route's
 * batch call, grouping, and mapping are still exercised end to end. */
import { describe, it, expect } from "vitest";
import app from "./metrics";
import { mockEnv, adminSession, memberSession, type MockEnv } from "../test/helpers";

interface Aggregates {
  intro: { status: string; n: number }[];
  news: { status: string; n: number }[];
  users: { role: string; n: number }[];
  emails: { kind: string; status: string; n: number }[];
}

const SAMPLE: Aggregates = {
  intro: [
    { status: "new", n: 3 },
    { status: "approved", n: 2 },
  ],
  news: [{ status: "confirmed", n: 5 }],
  users: [
    { role: "admin", n: 1 },
    { role: "member", n: 9 },
  ],
  emails: [
    { kind: "intro", status: "sent", n: 4 },
    { kind: "intro", status: "failed", n: 1 },
  ],
};

function metricsEnv(agg: Aggregates = SAMPLE) {
  const env = mockEnv();
  const sqlByStmt = new Map<object, string>();
  const seenSql: string[] = [];
  const origPrepare = env.DB.prepare.bind(env.DB);
  (env.DB as any).prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    sqlByStmt.set(stmt, sql);
    return stmt;
  };
  (env.DB as any).batch = async (stmts: any[]) =>
    stmts.map((s) => {
      const sql = sqlByStmt.get(s) ?? "";
      seenSql.push(sql);
      if (/introduction_requests/.test(sql)) return { results: agg.intro };
      if (/newsletter_subscribers/.test(sql)) return { results: agg.news };
      if (/FROM users/.test(sql)) return { results: agg.users };
      if (/email_log/.test(sql)) return { results: agg.emails };
      return { results: [] };
    });
  return { env, seenSql };
}

const getMetrics = (env: MockEnv, headers: Record<string, string> = {}) =>
  app.request("/", { headers }, env as any);

describe("admin gates", () => {
  it("requires sign-in (401)", async () => {
    const { env } = metricsEnv();
    expect((await getMetrics(env)).status).toBe(401);
  });

  it("rejects non-admin members (403)", async () => {
    const { env } = metricsEnv();
    const h = memberSession(env);
    expect((await getMetrics(env, h)).status).toBe(403);
  });

  it("rejects a demoted admin (role re-read from D1 on every call)", async () => {
    const { env } = metricsEnv();
    const h = adminSession(env);
    env.DB.handler = (sql) =>
      /from\s+users/i.test(sql)
        ? { row: { id: "admin-1", email: "admin@example.com", role: "member", status: "active" } }
        : undefined;
    expect((await getMetrics(env, h)).status).toBe(403);
  });
});

describe("aggregates", () => {
  it("returns all four aggregates in one batch, mapped to the dashboard shape", async () => {
    const { env, seenSql } = metricsEnv();
    const h = adminSession(env);
    const res = await getMetrics(env, h);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.introductionRequests).toEqual({ new: 3, approved: 2 });
    expect(d.newsletterSubscribers).toEqual({ confirmed: 5 });
    expect(d.users).toEqual({ admin: 1, member: 9 });
    expect(d.emailLog).toEqual([
      { kind: "intro", status: "sent", count: 4 },
      { kind: "intro", status: "failed", count: 1 },
    ]);
    expect(Number.isNaN(Date.parse(d.generatedAt))).toBe(false);
    expect(seenSql).toHaveLength(4);
    expect(seenSql[0]).toMatch(/introduction_requests/);
    expect(seenSql[1]).toMatch(/newsletter_subscribers/);
    expect(seenSql[2]).toMatch(/FROM users/);
    expect(seenSql[3]).toMatch(/email_log/);
  });

  it("returns empty maps and an empty email log when the tables are empty", async () => {
    const { env } = metricsEnv({ intro: [], news: [], users: [], emails: [] });
    const h = adminSession(env);
    const d: any = await (await getMetrics(env, h)).json();
    expect(d.introductionRequests).toEqual({});
    expect(d.newsletterSubscribers).toEqual({});
    expect(d.users).toEqual({});
    expect(d.emailLog).toEqual([]);
  });
});
