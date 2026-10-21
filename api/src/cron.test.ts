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

/** Env for the reminder job: one event in the 24h window, one confirmed RSVP. */
function reminderEnv(opts: { eventInWindow: boolean; alreadyReminded: boolean; memberEmail: string | null }) {
  const env = mockEnv();
  env.DB.handler = (sql) => {
    if (/FROM events/.test(sql)) {
      if (!opts.eventInWindow || opts.alreadyReminded) return { results: [] };
      return {
        results: [
          {
            id: "ev1",
            slug: "demo-night",
            title: "Demo night",
            starts_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
            location: "1365 Gerrard St E",
          },
        ],
      };
    }
    if (/FROM event_rsvps/.test(sql))
      return { results: [{ name: "Karl", email: "karl@example.com" }] };
    if (/FROM users/.test(sql))
      return opts.memberEmail ? { row: { id: "user-karl" } } : { row: null };
    return undefined;
  };
  return env;
}

describe("event reminders (*/15 * * * *)", () => {
  it("emails the RSVP list and notifies the matching member, then marks the event", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      const env = reminderEnv({ eventInWindow: true, alreadyReminded: false, memberEmail: "karl@example.com" });
      const { sendEventReminders } = await import("./cron");
      const n = await sendEventReminders(env.DB as any, env.RESEND_API_KEY, "https://brimwoodinnovation.com");
      expect(n).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("karl@example.com");
      expect(sent[0].subject).toBe("Tomorrow: Demo night — Brimwood Innovation");
      const notifs = env.DB.inserts.get("notifications") || [];
      expect(notifs).toHaveLength(1);
      expect(notifs[0]).toMatchObject({
        user_id: "user-karl",
        kind: "event_reminder",
        target_type: "event",
        target_id: "demo-night",
      });
      const mark = env.DB.calls.find((c) => /UPDATE events SET reminder_sent_at/.test(c.sql));
      expect(mark?.params).toEqual([expect.any(String), "ev1"]);
    } finally {
      restore();
    }
  });

  it("skips events outside the window or already reminded (idempotent)", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      const { sendEventReminders } = await import("./cron");
      for (const opts of [
        { eventInWindow: false, alreadyReminded: false, memberEmail: "karl@example.com" },
        { eventInWindow: true, alreadyReminded: true, memberEmail: "karl@example.com" },
      ]) {
        const env = reminderEnv(opts);
        const n = await sendEventReminders(env.DB as any, env.RESEND_API_KEY, "https://brimwoodinnovation.com");
        expect(n).toBe(0);
      }
      expect(sent).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("still emails when the RSVP email matches no member (no in-app row)", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      const env = reminderEnv({ eventInWindow: true, alreadyReminded: false, memberEmail: null });
      const { sendEventReminders } = await import("./cron");
      await sendEventReminders(env.DB as any, env.RESEND_API_KEY, "https://brimwoodinnovation.com");
      expect(sent).toHaveLength(1);
      expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("runs inside the 15-minute scheduled job", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      const env = reminderEnv({ eventInWindow: true, alreadyReminded: false, memberEmail: "karl@example.com" });
      // No scheduled posts in this env: the posts query returns nothing.
      await handleScheduled({ cron: "*/15 * * * *" } as any, env as any);
      expect(sent).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe("poll close notifications (*/15 * * * *)", () => {
  function pollEnv(polls: any[], voters: any[]) {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/FROM polls/.test(sql)) return { results: polls };
      if (/FROM poll_votes/.test(sql)) return { results: voters };
      return undefined;
    };
    return env;
  }

  it("notifies every voter once when a poll closes, then marks it", async () => {
    const env = pollEnv(
      [{ id: "poll1", post_id: "post1", question: "Best demo night?" }],
      [{ voter_id: "v1" }, { voter_id: "v2" }]
    );
    const { sendPollCloseNotifications } = await import("./cron");
    const n = await sendPollCloseNotifications(env.DB as any);
    expect(n).toBe(1);
    const notifs = env.DB.inserts.get("notifications") || [];
    expect(notifs).toHaveLength(2);
    expect(notifs[0]).toMatchObject({ user_id: "v1", kind: "poll_closed", target_type: "poll", target_id: "post1" });
    expect(notifs[1]).toMatchObject({ user_id: "v2", kind: "poll_closed" });
    const mark = env.DB.calls.find((c) => /UPDATE polls SET notified_closed_at/.test(c.sql));
    expect(mark?.params).toEqual([expect.any(String), "poll1"]);
  });

  it("skips polls with nothing due (idempotent)", async () => {
    const env = pollEnv([], []);
    const { sendPollCloseNotifications } = await import("./cron");
    const n = await sendPollCloseNotifications(env.DB as any);
    expect(n).toBe(0);
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
  });
});
