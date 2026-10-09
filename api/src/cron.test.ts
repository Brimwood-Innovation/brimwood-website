/* Cron hygiene test (audit/auth): the 5-min job prunes expired sessions and
 * stale rate-limit rows, which would otherwise accumulate forever
 * (rate-limit keys are attacker-controlled). */
import { describe, it, expect, afterEach } from "vitest";
import { handleScheduled } from "./cron";
import { mockEnv, stubFetch, type MockEnv } from "./test/helpers";

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
