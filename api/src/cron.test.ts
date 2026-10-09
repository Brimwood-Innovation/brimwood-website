/* Cron tests: weekly digest (confirmed-subscribers only, retry-safe sends)
 * and scheduled pruning (expired sessions + stale rate-limit rows). */
import { describe, it, expect, afterEach } from "vitest";
import { handleScheduled } from "./cron";
import { mockEnv, mailStub, stubFetch, type MockEnv } from "./test/helpers";

/** DB handler for the digest job. `claims` emulates the digest_sends PK:
 *  INSERT OR IGNORE reports changes=1 the first time, 0 on retry. */
function digestEnv(claims: Set<string>, content = true) {
  const env = mockEnv();
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM posts/.test(sql))
      return {
        results: content ? [{ slug: "hello", title: "Hello", excerpt: "An excerpt." }] : [],
      };
    if (/FROM lessons l/.test(sql))
      return {
        results: content
          ? [{ id: "l1", slug: "a", title: "Lesson A", course_slug: "foundations" }]
          : [],
      };
    if (/FROM newsletter_subscribers/.test(sql))
      return {
        results: content
          ? [{ email: "jane@example.com", name: "Jane", unsub_token: "tok123" }]
          : [],
      };
    if (/INSERT OR IGNORE INTO digest_sends/.test(sql)) {
      const key = String(params[0]) + "|" + String(params[1]);
      if (claims.has(key)) return { changes: 0 };
      claims.add(key);
      return { changes: 1 };
    }
    return prev?.(sql, params);
  };
  return env;
}

const MONDAY_9AM = { cron: "0 9 * * 1" } as any;

describe("weekly digest", () => {
  it("sends to active (double-opt-in confirmed) subscribers with lesson deep links", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      const env = digestEnv(new Set());
      await handleScheduled(MONDAY_9AM, env as any);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("jane@example.com");
      expect(sent[0].subject).toBe("This week at Brimwood");
      // The digest selects status='active' only (confirmed subscribers).
      const subsSql = env.DB.calls.find((c) => /FROM newsletter_subscribers/.test(c.sql))!.sql;
      expect(subsSql).toMatch(/status = 'active'/);
    } finally {
      restore();
    }
  });

  it("is retry-safe: a second run does not re-send to already-mailed subscribers", async () => {
    const claims = new Set<string>();
    const first: { to: string; subject: string }[] = [];
    let restore = mailStub(first);
    try {
      await handleScheduled(MONDAY_9AM, digestEnv(claims) as any);
    } finally {
      restore();
    }
    expect(first).toHaveLength(1);

    // Simulate a cron retry after a partial send: same claims set.
    const second: { to: string; subject: string }[] = [];
    restore = mailStub(second);
    try {
      const env = digestEnv(claims);
      await handleScheduled(MONDAY_9AM, env as any);
      expect(second).toHaveLength(0);
      // The dedupe INSERT was attempted for this run's digest id.
      expect(env.DB.calls.some((c) => /INSERT OR IGNORE INTO digest_sends/.test(c.sql))).toBe(true);
    } finally {
      restore();
    }
  });

  it("skips the send when there is nothing new", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      await handleScheduled(MONDAY_9AM, digestEnv(new Set(), false) as any);
      expect(sent).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
});

describe("scheduled pruning (*/5 * * * *)", () => {
  it("deletes expired sessions and stale rate-limit rows", async () => {
    const env: MockEnv = mockEnv();
    restoreFetch = stubFetch(() => new Response(null, { status: 200 }));

    const now = Date.now();
    env.DB.sessionStore.set("sess:expired", {
      user_id: "u1",
      role: "member",
      created_at: now - 40 * 86400000,
      expires_at: now - 10 * 86400000,
    });
    env.DB.sessionStore.set("sess:live", {
      user_id: "u1",
      role: "member",
      created_at: now,
      expires_at: now + 86400000,
    });
    env.DB.rateLimitStore.set("pwlogin:email:spam@example.com", {
      count: 99,
      window_start: now - 7200 * 1000,
    });

    await handleScheduled({ cron: "*/5 * * * *" } as any, env as any);

    expect(env.DB.sessionStore.has("sess:expired")).toBe(false);
    expect(env.DB.sessionStore.has("sess:live")).toBe(true);
    const pruneSessionsCall = env.DB.calls.find((c) =>
      /delete\s+from\s+sessions\s+where\s+expires_at/i.test(c.sql)
    );
    expect(pruneSessionsCall).toBeDefined();
    const pruneRateCall = env.DB.calls.find((c) =>
      /delete\s+from\s+rate_limits/i.test(c.sql)
    );
    expect(pruneRateCall).toBeDefined();
  });
});
