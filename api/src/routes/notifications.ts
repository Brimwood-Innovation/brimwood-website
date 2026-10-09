/* Social notifications (audit/social/wiring).
 *
 * One bell for everything social: @mentions, replies, follows, story replies,
 * closed polls, event reminders. Unread rows drive the header badge; opening a
 * row marks it read and follows its deep link (same-origin only).
 *
 * Routes (mounted at /api):
 *   GET  /notifications?limit=&offset=&unread=1 — auth; latest first.
 *   POST /notifications/:id/read                — auth; ownership-checked.
 *   POST /notifications/read-all                — auth; marks all read.
 *
 * Shared helpers — sibling agents (feed, stories, profiles, chat) MUST import
 * these instead of reimplementing:
 *   emitNotification(DB, n) — insert (deduped while unread) one notification.
 *   parseMentions(text)     — extract @handles per the username rules.
 *   deepLinkFor(n)          — canonical in-app URL for a notification row.
 *
 * Emission contract (called from the owning route at write time):
 *   mention:        parse @handles from a post/comment body, resolve to active
 *                   users, emit per user. targetType 'blog_comment' (targetId =
 *                   comment id) or 'post'/'comment' (feed; targetId = id, or
 *                   '<postId>:<commentId>' for a feed comment).
 *   reply:          userId = parent author, targetType 'post'|'comment' as above.
 *   follow:         userId = followed member, actorId = follower,
 *                   targetType 'user', targetId = follower id.
 *   story_reply:    userId = story author, targetType 'story', targetId = story id.
 *   poll_closed:    userId = each voter, targetType 'poll', targetId = post id.
 *   event_reminder: userId = RSVP member, targetType 'event', targetId = event slug.
 *
 * Anonymity: notification rows are private to user_id. Actors resolve to the
 * public profile shape only (never email/real name).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { readSession } from "../lib/auth";
import { cleanStr, clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

const app = new Hono<{ Bindings: Bindings }>();

export type NotificationKind =
  | "mention"
  | "reply"
  | "follow"
  | "story_reply"
  | "poll_closed"
  | "event_reminder";

export interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  actorId?: string | null;
  targetType: string;
  targetId: string;
  preview?: string;
}

/** @handle extraction. Mirrors the username rules in routes/profiles.ts:
 *  3-30 chars, lowercase letters/numbers/underscores, starts with a letter.
 *  The preceding-char guard keeps email addresses (jane@x.com) from matching. */
const MENTION_RE = /(^|[^a-zA-Z0-9_@])@([a-z][a-z0-9_]{2,29})/g;

export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) out.add(m[2]);
  return [...out];
}

/** Resolve @handles to active user ids (single query). */
export async function resolveMentionedUsers(
  DB: D1Database,
  handles: string[]
): Promise<{ id: string; username: string }[]> {
  if (!handles.length) return [];
  const placeholders = handles.map(() => "?").join(",");
  const rows = await DB.prepare(
    `SELECT id, username FROM users
     WHERE username IN (${placeholders}) AND status = 'active'`
  )
    .bind(...handles)
    .all();
  return ((rows.results as any[]) || []).map((r) => ({ id: r.id, username: r.username }));
}

/**
 * Insert one notification. Deduped while unread by the partial unique index
 * in 0020 (same user/kind/actor/target) — repeat emissions are a no-op.
 * Never notifies the actor about their own action. Best-effort by design:
 * a failed notification must not fail the write that triggered it.
 */
export async function emitNotification(
  DB: D1Database,
  n: NotificationInput
): Promise<void> {
  if (!n.userId || !n.kind || !n.targetType || !n.targetId) return;
  if (n.actorId && n.actorId === n.userId) return;
  const preview = (n.preview || "").replace(/\s+/g, " ").trim().slice(0, 200);
  await DB.prepare(
    `INSERT INTO notifications
       (id, user_id, kind, actor_id, target_type, target_id, preview)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  )
    .bind(
      crypto.randomUUID(),
      n.userId,
      n.kind,
      n.actorId || null,
      cleanStr(n.targetType, 40),
      cleanStr(n.targetId, 200),
      preview || null
    )
    .run()
    .catch(() => {});
}

/** Canonical in-app URL for a notification. Same-origin only — the bell never
 *  navigates anywhere these builders do not produce. */
export function deepLinkFor(n: {
  kind: string;
  target_type: string;
  target_id: string;
  actor_username?: string | null;
  actor_id?: string | null;
  post_slug?: string | null;
}): string {
  const tid = n.target_id || "";
  switch (n.kind) {
    case "follow":
      return n.actor_username ? `/@${n.actor_username}` : n.actor_id ? `/u/${n.actor_id}` : "/members";
    case "story_reply":
      return "/hub/stories";
    case "poll_closed":
      return `/hub/post/?id=${encodeURIComponent(tid)}`;
    case "event_reminder":
      return `/events/${encodeURIComponent(tid)}`;
    case "mention":
    case "reply":
    default: {
      if (n.target_type === "blog_comment") {
        return n.post_slug
          ? `/blog/${n.post_slug}#comment-${encodeURIComponent(tid)}`
          : "/blog";
      }
      if (n.target_type === "comment" && tid.includes(":")) {
        const [postId, commentId] = tid.split(":");
        return `/hub/post/?id=${encodeURIComponent(postId)}#comment-${encodeURIComponent(commentId)}`;
      }
      if (n.target_type === "post" || n.target_type === "comment" || n.target_type === "poll") {
        return `/hub/post/?id=${encodeURIComponent(tid)}`;
      }
      if (n.target_type === "event") {
        return `/events/${encodeURIComponent(tid)}`;
      }
      return "/";
    }
  }
}

/** Copy for the bell row, per kind. Calm, no hype, Canadian spelling. */
export function titleFor(n: {
  kind: string;
  actor_display_name?: string | null;
}): string {
  const who = n.actor_display_name || "Someone";
  switch (n.kind) {
    case "mention":
      return `${who} mentioned you`;
    case "reply":
      return `${who} replied to you`;
    case "follow":
      return `${who} followed you`;
    case "story_reply":
      return `${who} replied to your story`;
    case "poll_closed":
      return "Poll results are in";
    case "event_reminder":
      return "Event reminder";
    default:
      return "New activity";
  }
}

function actorShape(row: any) {
  if (!row || !row.id) return null;
  const display =
    row.display_name ||
    (row.name ? row.name.trim().charAt(0).toUpperCase() + "." : "Member");
  return {
    id: row.id,
    username: row.username || null,
    display_name: display,
    avatar_url: row.avatar_key ? `/api/media/${encodeURIComponent(row.avatar_key)}` : null,
  };
}

async function needUser(c: any) {
  const s = await readSession(c);
  if (!s) return { err: c.json({ ok: false, error: "Sign in required." }, 401) as Response, userId: null as string | null };
  return { err: null as Response | null, userId: s.userId as string };
}

/* --- GET /notifications — latest first, unread count included --- */

app.get("/notifications", async (c) => {
  const { err, userId } = await needUser(c);
  if (err) return err;
  const { DB } = c.env;

  if (!(await checkRateLimitD1(DB, "notifications:" + clientIp(c.req.raw), 60, 60))) {
    return c.json({ ok: false, error: "Too many requests. Please try again shortly." }, 429);
  }

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 50);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  const unreadOnly = c.req.query("unread") === "1";

  const where = unreadOnly ? "AND n.read_at IS NULL" : "";
  const rows = await DB.prepare(
    `SELECT n.id, n.kind, n.actor_id, n.target_type, n.target_id, n.preview,
            n.created_at, n.read_at,
            u.username AS actor_username, u.display_name AS actor_display_name,
            u.name AS actor_name, u.avatar_key AS actor_avatar_key,
            cm.post_slug AS post_slug
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     LEFT JOIN comments cm
       ON n.target_type = 'blog_comment' AND cm.id = n.target_id
     WHERE n.user_id = ? ${where}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(userId, limit, offset)
    .all();

  const totalRow = await DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""}`
  )
    .bind(userId)
    .first<{ n: number }>();
  const unreadRow = await DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`
  )
    .bind(userId)
    .first<{ n: number }>();

  const notifications = ((rows.results as any[]) || []).map((r) => {
    const actor = actorShape({
      id: r.actor_id,
      username: r.actor_username,
      display_name: r.actor_display_name,
      name: r.actor_name,
      avatar_key: r.actor_avatar_key,
    });
    return {
      id: r.id,
      kind: r.kind,
      title: titleFor({ kind: r.kind, actor_display_name: actor?.display_name || null }),
      actor,
      target_type: r.target_type,
      target_id: r.target_id,
      preview: r.preview || "",
      url: deepLinkFor({
        kind: r.kind,
        target_type: r.target_type,
        target_id: r.target_id,
        actor_username: r.actor_username,
        actor_id: r.actor_id,
        post_slug: r.post_slug,
      }),
      created_at: r.created_at,
      read_at: r.read_at,
    };
  });

  return c.json({
    ok: true,
    notifications,
    meta: {
      total: totalRow?.n || 0,
      unread: unreadRow?.n || 0,
      limit,
      offset,
    },
  });
});

/* --- POST /notifications/:id/read — ownership-checked --- */

app.post("/notifications/:id/read", async (c) => {
  const { err, userId } = await needUser(c);
  if (err) return err;
  const { DB } = c.env;

  const id = cleanStr(c.req.param("id"), 50);
  if (!id) return c.json({ ok: false }, 400);

  const row = await DB.prepare(
    `UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND user_id = ? AND read_at IS NULL`
  )
    .bind(id, userId)
    .run();

  if ((row.meta.changes || 0) === 0) {
    // Either unknown, not yours, or already read — same answer for all three.
    const exists = await DB.prepare(
      "SELECT id FROM notifications WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .first();
    if (!exists) return c.json({ ok: false, error: "Not found." }, 404);
  }
  return c.json({ ok: true });
});

/* --- POST /notifications/read-all --- */

app.post("/notifications/read-all", async (c) => {
  const { err, userId } = await needUser(c);
  if (err) return err;
  const { DB } = c.env;

  if (!(await checkRateLimitD1(DB, "notifications-readall:" + userId, 30, 60))) {
    return c.json({ ok: false, error: "Too many requests. Please try again shortly." }, 429);
  }

  await DB.prepare(
    `UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ? AND read_at IS NULL`
  )
    .bind(userId)
    .run();

  return c.json({ ok: true });
});

export default app;
