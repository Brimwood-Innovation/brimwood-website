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
      expect(sent[0].subject).toBe("Tomorrow: Demo night - Brimwood Innovation");
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

/* Item 12, messaging half: sendDueReminders (event_reminders rows, quiet
 * hours suppression) and runPublishQueue (atomic claim + dispatch). */

describe("sendDueReminders (item 12, messaging half)", () => {
  /** One due row; programmable event / user / settings. */
  function dueReminderEnv(opts: { quietEnabled: number; settingsRow: boolean; userRow: boolean }) {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/FROM event_reminders/.test(sql))
        return {
          results: [{ id: "er1", event_id: "ev1", user_id: "u1", offset_minutes: 1440 }],
        };
      if (/FROM events WHERE id/.test(sql))
        return {
          row: {
            id: "ev1",
            slug: "demo-night",
            title: "Demo night",
            starts_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
            location: "1365 Gerrard St E",
          },
        };
      if (/FROM users WHERE id/.test(sql))
        return opts.userRow ? { row: { id: "u1", email: "karl@example.com", name: "Karl" } } : { row: null };
      if (/FROM member_settings/.test(sql))
        return opts.settingsRow
          ? { row: { quiet_enabled: opts.quietEnabled, quiet_start: "00:00", quiet_end: "23:59", tz: "America/Toronto" } }
          : { row: null };
      return undefined;
    };
    return env;
  }

  it("suppresses a due reminder inside quiet hours (no email, no notification)", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      const env = dueReminderEnv({ quietEnabled: 1, settingsRow: true, userRow: true });
      const { sendDueReminders } = await import("./cron");
      const n = await sendDueReminders(env.DB as any, env.RESEND_API_KEY, "https://brimwoodinnovation.com");
      expect(n).toBe(0);
      expect(sent).toHaveLength(0);
      expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
      const sup = env.DB.calls.find((c) => /SET suppressed_reason = 'quiet_hours'/.test(c.sql));
      expect(sup?.params).toEqual(["er1"]);
    } finally {
      restore();
    }
  });

  it("sends the email and the in-app notification outside quiet hours, then marks sent", async () => {
    const sent: { to: string; subject: string }[] = [];
    const restore = mailStub(sent);
    try {
      const env = dueReminderEnv({ quietEnabled: 0, settingsRow: true, userRow: true });
      const { sendDueReminders } = await import("./cron");
      const n = await sendDueReminders(env.DB as any, env.RESEND_API_KEY, "https://brimwoodinnovation.com");
      expect(n).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("karl@example.com");
      expect(sent[0].subject).toBe("Reminder: Demo night - Brimwood Innovation");
      const notifs = env.DB.inserts.get("notifications") || [];
      expect(notifs).toHaveLength(1);
      expect(notifs[0]).toMatchObject({
        user_id: "u1",
        kind: "event_reminder",
        target_type: "event",
        target_id: "demo-night",
      });
      const mark = env.DB.calls.find((c) => /UPDATE event_reminders SET sent_at/.test(c.sql));
      expect(mark?.params).toEqual([expect.any(String), "er1"]);
    } finally {
      restore();
    }
  });

  it("falls back to the schema quiet-hours defaults when the member has no settings row", async () => {
    const env = dueReminderEnv({ quietEnabled: 1, settingsRow: false, userRow: true });
    const { sendDueReminders, inQuietHours } = await import("./cron");
    const n = await sendDueReminders(env.DB as any, undefined, "https://brimwoodinnovation.com");
    const suppressed = env.DB.calls.some((c) => /SET suppressed_reason = 'quiet_hours'/.test(c.sql));
    const marked = env.DB.calls.some((c) => /UPDATE event_reminders SET sent_at/.test(c.sql));
    // Exactly one terminal state, and it agrees with the default window.
    expect(suppressed !== marked).toBe(true);
    const expectQuiet = inQuietHours(new Date(), "22:00", "08:00", "America/Toronto");
    expect(suppressed).toBe(expectQuiet);
    expect(n).toBe(expectQuiet ? 0 : 1);
  });

  it("marks sent when the member is gone so the row stops being due", async () => {
    const env = dueReminderEnv({ quietEnabled: 0, settingsRow: true, userRow: false });
    const { sendDueReminders } = await import("./cron");
    const n = await sendDueReminders(env.DB as any, undefined, "https://brimwoodinnovation.com");
    expect(n).toBe(0);
    const mark = env.DB.calls.find((c) => /UPDATE event_reminders SET sent_at/.test(c.sql));
    expect(mark).toBeDefined();
  });

  it("returns 0 when nothing is due", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) => (/FROM event_reminders/.test(sql) ? { results: [] } : undefined);
    const { sendDueReminders } = await import("./cron");
    const n = await sendDueReminders(env.DB as any, env.RESEND_API_KEY, "https://brimwoodinnovation.com");
    expect(n).toBe(0);
  });
});

describe("runPublishQueue (item 12, messaging half)", () => {
  /** Queue with one due row; rituals served from `rituals`. */
  function queueEnv(row: any, ritual: any = null) {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/FROM publish_queue/.test(sql)) return { results: [row] };
      if (/FROM rituals WHERE id/.test(sql)) return ritual ? { row: ritual } : { row: null };
      return undefined;
    };
    return env;
  }

  function queueRow(over: any = {}) {
    return {
      id: "q1",
      item_type: "page",
      item_id: "p1",
      action: "publish",
      attempts: 0,
      ...over,
    };
  }

  it("publishes a page: flips the row live and marks the queue row done", async () => {
    const env = queueEnv(queueRow());
    const { runPublishQueue } = await import("./cron");
    const n = await runPublishQueue(env.DB as any);
    expect(n).toBe(1);
    // Atomic claim first.
    const claim = env.DB.calls.find((c) =>
      /UPDATE publish_queue SET status = 'running'/.test(c.sql)
    );
    expect(claim?.params).toEqual(["q1"]);
    expect(claim?.sql).toContain("attempts = attempts + 1");
    // Dispatch flips the page.
    const pub = env.DB.calls.find((c) => /UPDATE pages SET status/.test(c.sql));
    expect(pub?.params).toEqual(["published", "p1"]);
    // Then done.
    const done = env.DB.calls.find((c) => /SET status = 'done'/.test(c.sql));
    expect(done?.params).toEqual([expect.any(String), "q1"]);
  });

  it("unpublishes to 'draft' (a valid status for events)", async () => {
    const env = queueEnv(queueRow({ item_type: "event", item_id: "ev1", action: "unpublish" }));
    const { runPublishQueue } = await import("./cron");
    await runPublishQueue(env.DB as any);
    const pub = env.DB.calls.find((c) => /UPDATE events SET status/.test(c.sql));
    expect(pub?.params).toEqual(["draft", "ev1"]);
  });

  it("turns a ritual run into one feed post", async () => {
    const env = queueEnv(
      queueRow({ item_type: "ritual_run", item_id: "r1", action: "publish" }),
      { id: "r1", title: "Monday kickoff", body_template: "Share one win.", group_id: null, author_id: "staff-1" }
    );
    const { runPublishQueue } = await import("./cron");
    const n = await runPublishQueue(env.DB as any);
    expect(n).toBe(1);
    const posts = env.DB.inserts.get("feed_posts") || [];
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      author_id: "staff-1",
      intent: "ritual",
      audience: "members",
      ritual_id: "r1",
    });
    expect(posts[0].body).toContain("Monday kickoff");
    expect(posts[0].body).toContain("Share one win.");
  });

  it("fails a newsletter send with the item-13 requeue note (never faked)", async () => {
    const env = queueEnv(queueRow({ item_type: "newsletter_issue", item_id: "ni1", action: "send" }));
    const { runPublishQueue } = await import("./cron");
    const n = await runPublishQueue(env.DB as any);
    expect(n).toBe(0);
    const failed = env.DB.calls.find((c) => /SET status = 'failed'/.test(c.sql));
    expect(failed).toBeDefined();
    expect(String(failed?.params[0])).toContain("item 13");
    expect(String(failed?.params[0]).length).toBeLessThanOrEqual(200);
  });

  it("fails an unknown item_type", async () => {
    const env = queueEnv(queueRow({ item_type: "announcement", item_id: "a1", action: "publish" }));
    const { runPublishQueue } = await import("./cron");
    await runPublishQueue(env.DB as any);
    const failed = env.DB.calls.find((c) => /SET status = 'failed'/.test(c.sql));
    expect(failed).toBeDefined();
    expect(String(failed?.params[0])).toContain("announcement");
  });

  it("fails an unknown action", async () => {
    const env = queueEnv(queueRow({ item_type: "page", item_id: "p1", action: "send" }));
    const { runPublishQueue } = await import("./cron");
    await runPublishQueue(env.DB as any);
    const failed = env.DB.calls.find((c) => /SET status = 'failed'/.test(c.sql));
    expect(failed).toBeDefined();
  });

  it("skips a row another worker claimed (claim UPDATE changes 0)", async () => {
    const env = queueEnv(queueRow());
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/SET status = 'running'/.test(sql)) return { changes: 0 };
      return prev?.(sql, params);
    };
    const { runPublishQueue } = await import("./cron");
    const n = await runPublishQueue(env.DB as any);
    expect(n).toBe(0);
    // No dispatch and no done/failed write for the skipped row.
    expect(env.DB.calls.some((c) => /UPDATE pages SET status/.test(c.sql))).toBe(false);
    expect(env.DB.calls.some((c) => /SET status = '(done|failed)'/.test(c.sql))).toBe(false);
  });

  it("records dispatch exceptions as failed with a trimmed reason", async () => {
    const env = queueEnv(queueRow({ item_type: "page", item_id: "p1", action: "publish" }));
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/UPDATE pages SET status/.test(sql)) throw new Error("D1_ERROR: boom " + "x".repeat(500));
      return prev?.(sql, params);
    };
    const { runPublishQueue } = await import("./cron");
    const n = await runPublishQueue(env.DB as any);
    expect(n).toBe(0);
    const failed = env.DB.calls.find((c) => /SET status = 'failed'/.test(c.sql));
    expect(failed).toBeDefined();
    expect(String(failed?.params[0]).length).toBeLessThanOrEqual(200);
  });

  it("runs inside the 15-minute scheduled job", async () => {
    const env = queueEnv(queueRow());
    // The rest of the 15-minute job needs its queries; default to empty.
    await handleScheduled({ cron: "*/15 * * * *" } as any, env as any);
    const done = env.DB.calls.find((c) => /SET status = 'done'/.test(c.sql));
    expect(done).toBeDefined();
  });
});

describe("inQuietHours", () => {
  it("handles wrap-around windows", async () => {
    const { inQuietHours } = await import("./cron");
    // A fixed UTC instant; America/Toronto is UTC-4 in October.
    const at = (iso: string) => new Date(iso);
    // 23:30 Toronto = 03:30 UTC next day.
    expect(inQuietHours(at("2026-10-23T03:30:00Z"), "22:00", "08:00", "America/Toronto")).toBe(true);
    // 12:00 Toronto = 16:00 UTC.
    expect(inQuietHours(at("2026-10-23T16:00:00Z"), "22:00", "08:00", "America/Toronto")).toBe(false);
    // Non-wrapping window.
    expect(inQuietHours(at("2026-10-23T16:00:00Z"), "09:00", "17:00", "America/Toronto")).toBe(true);
    expect(inQuietHours(at("2026-10-23T03:30:00Z"), "09:00", "17:00", "America/Toronto")).toBe(false);
    // An unknown timezone never suppresses.
    expect(inQuietHours(at("2026-10-23T03:30:00Z"), "00:00", "23:59", "Mars/Olympus")).toBe(false);
  });
});
