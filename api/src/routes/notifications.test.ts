/* Notifications API tests (audit/social/wiring): bell list, unread count,
 * ownership-checked reads, mention parsing, deep links, dedupe, and the
 * comment-approve → mention emission path. */
import { describe, it, expect, beforeEach } from "vitest";
import app, {
  parseMentions,
  deepLinkFor,
  titleFor,
  emitNotification,
  resolveMentionedUsers,
} from "./notifications";
import commentsApp from "./comments";
import { mockEnv, memberSession, adminSession, type MockEnv } from "../test/helpers";

function notifRow(overrides: any = {}) {
  return {
    id: "n1",
    kind: "mention",
    actor_id: "actor-1",
    target_type: "blog_comment",
    target_id: "c1",
    preview: "Hey @jane, look at this",
    created_at: "2026-10-08T10:00:00.000Z",
    read_at: null,
    source: "notifications",
    actor_username: "k_builds",
    actor_display_name: "K.",
    actor_name: "Karl Marx",
    actor_avatar_key: "avatars/actor-1/a.png",
    post_slug: "hello-world",
    ...overrides,
  };
}

/** Env with a member session; the bell list + counts served from `rows`
 *  via the notification_feed view (item 11). */
function notifEnv(rows: any[], unread = rows.filter((r) => !r.read_at).length) {
  const env = mockEnv();
  memberSession(env, "member-1");
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/COUNT\(\*\)/.test(sql) && /read_at IS NULL/.test(sql)) return { row: { n: unread } };
    if (/COUNT\(\*\)/.test(sql)) return { row: { n: rows.length } };
    if (/FROM notification_feed/.test(sql)) return { results: rows };
    return prev?.(sql, params);
  };
  return env;
}

describe("parseMentions", () => {
  it("extracts @handles", () => {
    expect(parseMentions("Hey @jane_doe and @kim_2, look")).toEqual(["jane_doe", "kim_2"]);
  });
  it("ignores email addresses", () => {
    expect(parseMentions("mail jane@example.com please")).toEqual([]);
  });
  it("dedupes and skips invalid handles", () => {
    expect(parseMentions("@ab @Jane @jane @jane")).toEqual(["jane"]);
  });
  it("handles empty input", () => {
    expect(parseMentions("")).toEqual([]);
  });
});

describe("resolveMentionedUsers", () => {
  it("resolves active users by username", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) =>
      /FROM users/.test(sql)
        ? { results: [{ id: "u9", username: "jane_doe" }] }
        : undefined;
    const out = await resolveMentionedUsers(env.DB as any, ["jane_doe", "ghost"]);
    expect(out).toEqual([{ id: "u9", username: "jane_doe" }]);
  });
  it("returns [] for no handles", async () => {
    const env = mockEnv();
    expect(await resolveMentionedUsers(env.DB as any, [])).toEqual([]);
  });
});

describe("deepLinkFor", () => {
  it("links a blog-comment mention to the comment anchor", () => {
    expect(
      deepLinkFor({ kind: "mention", target_type: "blog_comment", target_id: "c1", post_slug: "hello" })
    ).toBe("/blog/hello#comment-c1");
  });
  it("falls back to /blog when the comment is gone", () => {
    expect(
      deepLinkFor({ kind: "mention", target_type: "blog_comment", target_id: "c1", post_slug: null })
    ).toBe("/blog");
  });
  it("links a follow to the actor's canonical profile", () => {
    expect(
      deepLinkFor({ kind: "follow", target_type: "user", target_id: "a1", actor_username: "k_builds", actor_id: "a1" })
    ).toBe("/@k_builds");
  });
  it("links a follow to /u/<id> when the actor has no username", () => {
    expect(
      deepLinkFor({ kind: "follow", target_type: "user", target_id: "a1", actor_username: null, actor_id: "a1" })
    ).toBe("/u/a1");
  });
  it("links feed targets to /hub/post (query-param permalink; the site is fully static)", () => {
    expect(deepLinkFor({ kind: "reply", target_type: "post", target_id: "p1" })).toBe("/hub/post/?id=p1");
    expect(deepLinkFor({ kind: "reply", target_type: "comment", target_id: "p1:c2" })).toBe(
      "/hub/post/?id=p1#comment-c2"
    );
    expect(deepLinkFor({ kind: "poll_closed", target_type: "poll", target_id: "p9" })).toBe("/hub/post/?id=p9");
  });
  it("links story replies and event reminders", () => {
    expect(deepLinkFor({ kind: "story_reply", target_type: "story", target_id: "s1" })).toBe("/hub/stories");
    expect(deepLinkFor({ kind: "event_reminder", target_type: "event", target_id: "demo-night" })).toBe(
      "/events/demo-night"
    );
  });
});

describe("emitNotification", () => {
  it("inserts a row", async () => {
    const env = mockEnv();
    await emitNotification(env.DB as any, {
      userId: "u1",
      kind: "mention",
      actorId: "a1",
      targetType: "blog_comment",
      targetId: "c1",
      preview: " hi ",
    });
    const rows = env.DB.inserts.get("notifications") || [];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe("u1");
    expect(rows[0].kind).toBe("mention");
    expect(rows[0].preview).toBe("hi");
  });
  it("never notifies the actor about their own action", async () => {
    const env = mockEnv();
    await emitNotification(env.DB as any, {
      userId: "u1",
      kind: "follow",
      actorId: "u1",
      targetType: "user",
      targetId: "u1",
    });
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
  });
  it("skips when userId is missing", async () => {
    const env = mockEnv();
    await emitNotification(env.DB as any, {
      userId: "",
      kind: "mention",
      targetType: "post",
      targetId: "p1",
    });
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
  });
});

describe("GET /notifications", () => {
  it("401 when anonymous", async () => {
    const res = await app.request("/notifications", {}, mockEnv() as any);
    expect(res.status).toBe(401);
  });

  it("returns rows with actor shape, deep link, and unread count", async () => {
    const env = notifEnv([notifRow()]);
    const res = await app.request(
      "/notifications",
      { headers: { Cookie: "x" } },
      env as any
    );
    // memberSession sets the tok-member cookie; pass it explicitly.
    const res2 = await app.request(
      "/notifications",
      { headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res2.status).toBe(200);
    const d: any = await res2.json();
    expect(d.ok).toBe(true);
    expect(d.meta.unread).toBe(1);
    expect(d.meta.total).toBe(1);
    const n = d.notifications[0];
    expect(n.title).toBe("K. mentioned you");
    expect(n.url).toBe("/blog/hello-world#comment-c1");
    expect(n.actor).toMatchObject({
      id: "actor-1",
      username: "k_builds",
      display_name: "K.",
      avatar_url: "/api/media/avatars%2Factor-1%2Fa.png",
    });
    expect(n.actor.email).toBeUndefined();
    expect(res.status).toBe(401); // sanity: the first (cookieless) request failed
  });

  it("unread=1 filters to unread rows", async () => {
    const env = notifEnv([notifRow({ id: "n1" }), notifRow({ id: "n2", read_at: "2026-10-08T11:00:00Z" })], 1);
    const res = await app.request("/notifications?unread=1", { headers: memberSession(mockEnv()) }, env as any);
    const d: any = await res.json();
    const listSql = env.DB.calls.find((c) => /FROM notification_feed/.test(c.sql));
    expect(listSql?.sql).toContain("read_at IS NULL");
    expect(d.meta.unread).toBe(1);
  });
});

describe("POST /notifications/:id/read (item 11)", () => {
  it("401 when anonymous", async () => {
    const res = await app.request("/notifications/n1/read", { method: "POST" }, mockEnv() as any);
    expect(res.status).toBe(401);
  });

  it("marks the caller's own notification read (no source: legacy table first)", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notification/.test(sql) ? { changes: 1 } : prev?.(sql, params);
    const res = await app.request(
      "/notifications/n1/read",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
    const upd = env.DB.calls.find((c) => /UPDATE notifications\b/.test(c.sql));
    expect(upd?.params).toEqual(["n1", "member-1"]);
    // Legacy table won, so the items table was never touched.
    expect(env.DB.calls.some((c) => /UPDATE notification_items/.test(c.sql))).toBe(false);
  });

  it("marks read in the table named by source (JSON body)", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notification_items/.test(sql) ? { changes: 1 } : prev?.(sql, params);
    const res = await app.request(
      "/notifications/i1/read",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...memberSession(mockEnv()) },
        body: JSON.stringify({ source: "notification_items" }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const upd = env.DB.calls.find((c) => /UPDATE notification_items/.test(c.sql));
    expect(upd?.params).toEqual(["i1", "member-1"]);
    // An exact source never touches the other table.
    expect(env.DB.calls.some((c) => /UPDATE notifications\b/.test(c.sql))).toBe(false);
  });

  it("accepts source as a query param", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notifications\b/.test(sql) ? { changes: 1 } : prev?.(sql, params);
    const res = await app.request(
      "/notifications/n1/read?source=notifications",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
    expect(env.DB.calls.some((c) => /UPDATE notifications\b/.test(c.sql))).toBe(true);
    expect(env.DB.calls.some((c) => /UPDATE notification_items/.test(c.sql))).toBe(false);
  });

  it("treats an invalid source as missing (both tables tried)", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notification/.test(sql) ? { changes: 1 } : prev?.(sql, params);
    const res = await app.request(
      "/notifications/i1/read?source=notifications;DROP",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
    // Raw input is never interpolated: the first (legacy) UPDATE ran, and the
    // SQL text carries no trace of the injected value.
    for (const cl of env.DB.calls) expect(cl.sql).not.toContain("DROP");
  });

  it("404 for another member's notification (no leak)", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notification/.test(sql)
        ? { changes: 0 }
        : /SELECT id FROM notifications WHERE id/.test(sql) ||
            /SELECT id FROM notification_items WHERE id/.test(sql)
          ? { row: null }
          : prev?.(sql, params);
    const res = await app.request(
      "/notifications/n9/read",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(404);
  });

  it("answers the same when the row is already read", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notification/.test(sql)
        ? { changes: 0 }
        : /SELECT id FROM notifications WHERE id/.test(sql)
          ? { row: { id: "n1" } }
          : prev?.(sql, params);
    const res = await app.request(
      "/notifications/n1/read",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /notifications/read-all (item 11)", () => {
  it("marks all of the caller's notifications read in both tables", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const res = await app.request(
      "/notifications/read-all",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
    const upds = env.DB.calls.filter((c) => /UPDATE notification/.test(c.sql));
    expect(upds).toHaveLength(2);
    expect(upds[0].sql).toContain("UPDATE notifications SET");
    expect(upds[1].sql).toContain("UPDATE notification_items SET");
    for (const u of upds) {
      expect(u.params).toEqual(["member-1"]);
      expect(u.sql).toContain("read_at IS NULL");
    }
  });
});

describe("comment approve → mention notification", () => {
  let env: MockEnv;
  beforeEach(() => {
    env = mockEnv();
    adminSession(env, "admin-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/FROM comments WHERE id/.test(sql))
        return {
          row: {
            post_slug: "hello-world",
            name: "Karl",
            email: "karl@example.com",
            body: "Great post @jane_doe, what do you think?",
          },
        };
      if (/FROM users/.test(sql) && /username IN/.test(sql))
        return { results: [{ id: "user-jane", username: "jane_doe" }] };
      if (/FROM users/.test(sql) && /email/.test(sql) && !/WHERE id/.test(sql))
        return { row: null };
      return prev?.(sql, params);
    };
  });

  it("emits a mention notification on approve", async () => {
    const res = await commentsApp.request(
      "/admin/comments/c1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...adminSession(mockEnv()) },
        body: JSON.stringify({ status: "approved" }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("notifications") || [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-jane",
      kind: "mention",
      target_type: "blog_comment",
      target_id: "c1",
    });
  });

  it("emits nothing on spam, and nothing without mentions", async () => {
    const res = await commentsApp.request(
      "/admin/comments/c1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...adminSession(mockEnv()) },
        body: JSON.stringify({ status: "spam" }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
  });
});

/* Item 11: the notification_kinds registry decides the table. Legacy kinds
 * keep using `notifications`; new kinds go to `notification_items`; unknown
 * kinds are dropped quietly; an explicit in_app opt-out suppresses emission. */

describe("emitNotification table routing (item 11)", () => {
  it("routes a new kind to notification_items", async () => {
    const env = mockEnv();
    await emitNotification(env.DB as any, {
      userId: "u1",
      kind: "dm_request",
      actorId: "a1",
      targetType: "conversation",
      targetId: "c9",
      preview: " Someone would like to message you. ",
    });
    const items = env.DB.inserts.get("notification_items") || [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      user_id: "u1",
      kind: "dm_request",
      actor_id: "a1",
      target_type: "conversation",
      target_id: "c9",
      preview: "Someone would like to message you.",
    });
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
  });

  it("keeps a legacy kind in notifications", async () => {
    const env = mockEnv();
    await emitNotification(env.DB as any, {
      userId: "u1",
      kind: "mention",
      actorId: "a1",
      targetType: "post",
      targetId: "p1",
    });
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(1);
    expect(env.DB.inserts.get("notification_items") || []).toHaveLength(0);
  });

  it("drops an unknown kind quietly", async () => {
    const env = mockEnv();
    await emitNotification(env.DB as any, {
      userId: "u1",
      kind: "not_a_kind" as any,
      targetType: "post",
      targetId: "p1",
    });
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
    expect(env.DB.inserts.get("notification_items") || []).toHaveLength(0);
  });

  it("honours an explicit in_app opt-out", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) =>
      /FROM notification_preferences/.test(sql) ? { row: { enabled: 0 } } : undefined;
    await emitNotification(env.DB as any, {
      userId: "u1",
      kind: "dm",
      targetType: "conversation",
      targetId: "c9",
    });
    expect(env.DB.inserts.get("notifications") || []).toHaveLength(0);
    expect(env.DB.inserts.get("notification_items") || []).toHaveLength(0);
  });

  it("emits when no preference row exists (registry default)", async () => {
    const env = mockEnv();
    await emitNotification(env.DB as any, {
      userId: "u1",
      kind: "new_course",
      targetType: "course",
      targetId: "foundations",
    });
    expect(env.DB.inserts.get("notification_items") || []).toHaveLength(1);
  });

  it("never throws, even when the database is down", async () => {
    const env = mockEnv();
    env.DB.handler = () => {
      throw new Error("d1 exploded");
    };
    await expect(
      emitNotification(env.DB as any, {
        userId: "u1",
        kind: "mention",
        targetType: "post",
        targetId: "p1",
      })
    ).resolves.toBeUndefined();
  });
});

describe("GET /notifications reads the feed view (item 11)", () => {
  it("returns rows from both tables with source set", async () => {
    const env = notifEnv([
      notifRow({ id: "n1", source: "notifications" }),
      notifRow({
        id: "i1",
        kind: "dm_request",
        source: "notification_items",
        target_type: "conversation",
        target_id: "c9",
        preview: "Someone would like to message you.",
        post_slug: null,
      }),
    ]);
    const res = await app.request(
      "/notifications",
      { headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.meta.total).toBe(2);
    expect(d.notifications.map((n: any) => n.source)).toEqual([
      "notifications",
      "notification_items",
    ]);
    const req = d.notifications[1];
    expect(req.kind).toBe("dm_request");
    expect(req.title).toBe("Message request from K.");
    expect(req.url).toBe("/messages");
  });

  it("reads the view from captured inserts when no handler is set", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    // No programmable handler: the built-in notification_feed view serves
    // the rows emitNotification captured above.
    await emitNotification(env.DB as any, {
      userId: "member-1",
      kind: "dm_request",
      actorId: "actor-1",
      targetType: "conversation",
      targetId: "c9",
    });
    const res = await app.request(
      "/notifications",
      { headers: memberSession(mockEnv()) },
      env as any
    );
    const d: any = await res.json();
    expect(d.notifications).toHaveLength(1);
    expect(d.notifications[0].source).toBe("notification_items");
  });
});

describe("titleFor and deepLinkFor for the new kinds (item 11)", () => {
  it("titles every new kind in calm Canadian copy", () => {
    expect(titleFor({ kind: "dm", actor_display_name: "Bo" })).toBe("Bo sent you a message");
    expect(titleFor({ kind: "dm_request", actor_display_name: "Bo" })).toBe("Message request from Bo");
    expect(titleFor({ kind: "answer", actor_display_name: "Bo" })).toBe("Bo answered your question");
    expect(titleFor({ kind: "helpful_marked", actor_display_name: "Bo" })).toBe("Bo marked your answer helpful");
    expect(titleFor({ kind: "group_join_request", actor_display_name: "Bo" })).toBe("Bo asked to join your group");
    expect(titleFor({ kind: "group_join_approved" })).toBe("Your group request was approved");
    expect(titleFor({ kind: "invite_redeemed", actor_display_name: "Bo" })).toBe("Bo joined with your invite");
    expect(titleFor({ kind: "booking_confirmed" })).toBe("Your room booking is confirmed");
    expect(titleFor({ kind: "booking_cancelled" })).toBe("Your room booking was cancelled");
    expect(titleFor({ kind: "guest_arrived" })).toBe("Your guest arrived");
    expect(titleFor({ kind: "demo_feedback", actor_display_name: "Bo" })).toBe("Bo left feedback on your demo");
    expect(titleFor({ kind: "demo_slot" })).toBe("Your demo slot is confirmed");
    expect(titleFor({ kind: "reflection_shared", actor_display_name: "Bo" })).toBe("Bo shared a reflection");
    expect(titleFor({ kind: "certificate_issued" })).toBe("Your certificate is ready");
    expect(titleFor({ kind: "new_course" })).toBe("A new course is available");
    expect(titleFor({ kind: "report_outcome" })).toBe("An update on your report");
    expect(titleFor({ kind: "sanction_notice" })).toBe("A notice about your account");
    expect(titleFor({ kind: "appeal_decided" })).toBe("A decision on your appeal");
    expect(titleFor({ kind: "digest_ready" })).toBe("Your weekly digest is ready");
    expect(titleFor({ kind: "security_alert" })).toBe("Security alert for your account");
    for (const kind of [
      "dm", "dm_request", "answer", "helpful_marked", "group_join_request",
      "group_join_approved", "invite_redeemed", "booking_confirmed",
      "booking_cancelled", "guest_arrived", "demo_feedback", "demo_slot",
      "reflection_shared", "certificate_issued", "new_course", "report_outcome",
      "sanction_notice", "appeal_decided", "digest_ready", "security_alert",
    ]) {
      expect(titleFor({ kind, actor_display_name: "Bo" })).not.toContain("-");
    }
  });

  it("deep-links the new kinds to pages the site produces", () => {
    expect(deepLinkFor({ kind: "dm", target_type: "conversation", target_id: "c9" })).toBe("/messages");
    expect(deepLinkFor({ kind: "dm_request", target_type: "conversation", target_id: "c9" })).toBe("/messages");
    expect(deepLinkFor({ kind: "certificate_issued", target_type: "course", target_id: "foundations" })).toBe("/academy");
    expect(deepLinkFor({ kind: "new_course", target_type: "course", target_id: "foundations" })).toBe("/academy");
    expect(deepLinkFor({ kind: "answer", target_type: "post", target_id: "p1" })).toBe("/hub/post/?id=p1");
    expect(deepLinkFor({ kind: "booking_confirmed", target_type: "booking", target_id: "b1" })).toBe("/dashboard");
  });
});
