/* Notifications API tests (audit/social/wiring): bell list, unread count,
 * ownership-checked reads, mention parsing, deep links, dedupe, and the
 * comment-approve → mention emission path. */
import { describe, it, expect, beforeEach } from "vitest";
import app, {
  parseMentions,
  deepLinkFor,
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
    actor_username: "k_builds",
    actor_display_name: "K.",
    actor_name: "Karl Marx",
    actor_avatar_key: "avatars/actor-1/a.png",
    post_slug: "hello-world",
    ...overrides,
  };
}

/** Env with a member session; notification list + counts served from `rows`. */
function notifEnv(rows: any[], unread = rows.filter((r) => !r.read_at).length) {
  const env = mockEnv();
  memberSession(env, "member-1");
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM notifications n/.test(sql)) return { results: rows };
    if (/COUNT\(\*\)/.test(sql) && /read_at IS NULL/.test(sql)) return { row: { n: unread } };
    if (/COUNT\(\*\)/.test(sql)) return { row: { n: rows.length } };
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
    const listSql = env.DB.calls.find((c) => /FROM notifications n/.test(c.sql));
    expect(listSql?.sql).toContain("read_at IS NULL");
    expect(d.meta.unread).toBe(1);
  });
});

describe("POST /notifications/:id/read", () => {
  it("401 when anonymous", async () => {
    const res = await app.request("/notifications/n1/read", { method: "POST" }, mockEnv() as any);
    expect(res.status).toBe(401);
  });

  it("marks the caller's own notification read", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notifications/.test(sql) ? { changes: 1 } : prev?.(sql, params);
    const res = await app.request(
      "/notifications/n1/read",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
    const upd = env.DB.calls.find((c) => /UPDATE notifications/.test(c.sql));
    expect(upd?.params).toEqual(["n1", "member-1"]);
  });

  it("404 for another member's notification (no leak)", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) =>
      /UPDATE notifications/.test(sql)
        ? { changes: 0 }
        : /FROM notifications WHERE id/.test(sql)
          ? { row: null }
          : prev?.(sql, params);
    const res = await app.request(
      "/notifications/n9/read",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /notifications/read-all", () => {
  it("marks all of the caller's notifications read", async () => {
    const env = mockEnv();
    memberSession(env, "member-1");
    const res = await app.request(
      "/notifications/read-all",
      { method: "POST", headers: memberSession(mockEnv()) },
      env as any
    );
    expect(res.status).toBe(200);
    const upd = env.DB.calls.find((c) => /UPDATE notifications/.test(c.sql));
    expect(upd?.params).toEqual(["member-1"]);
    expect(upd?.sql).toContain("read_at IS NULL");
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
