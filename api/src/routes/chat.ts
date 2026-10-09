/* Member chat (DMs + groups), audit/social/chat.
 *
 * Mounted by the first mate at "/api/chat". Every route is behind requireUser
 * (members only); every read/write also enforces conversation membership —
 * a non-member gets 404, never a leak about whether the conversation exists.
 * Mutating routes are covered by the global CSRF guard.
 *
 * Read receipts are derived from conversation_members.last_read_at, so there
 * is no per-message receipt table to write to on every view.
 *
 * Routes:
 *   GET  /chat/conversations?q=              — list (participants, last-message
 *                                              preview, unread count, activity
 *                                              order)
 *   POST /chat/conversations                 — start a DM ({kind:'dm',
 *                                              user_id}) or a group
 *                                              ({kind:'group', user_ids:[...],
 *                                              title?}); DMs are idempotent
 *   GET  /chat/conversations/:id/messages?cursor=&limit=
 *   POST /chat/conversations/:id/messages    — JSON {body} or multipart
 *                                              {body, file}; media uploads to
 *                                              the brimwood-media R2 bucket
 *   POST /chat/conversations/:id/read        — bump last_read_at
 *   POST /chat/conversations/:id/members     — group admins add/remove
 *   GET  /chat/people?q=                     — member directory search
 *                                              (anonymous-safe: display_name /
 *                                              username / avatar only)
 *   GET  /chat/story-replies                 — replies to the caller's stories;
 *                                              feature-detected (see below)
 *
 * Brand rule: anonymous by default. Participant cards expose display_name
 * (initials fallback) and username — never email or real name.
 */
import { Hono } from "hono";
import { requireUser, type Session } from "../lib/auth";
import type { Bindings } from "../index";
import { cleanStr, isRecord } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { initialsFor } from "./profiles";

const app = new Hono<{ Bindings: Bindings; Variables: { user: Session } }>();

app.use(requireUser);

const CONV_LIMIT = 60;
const MSG_LIMIT = 30;
const MSG_MAX = 100;
const BODY_MAX = 2000;
const TITLE_MAX = 60;

const MEDIA_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
};
const MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MB, same as the media route

interface Participant {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  /** Conversation role (member|admin); null for directory results. */
  role: string | null;
}

/** Anonymous-safe participant card: display_name with initials fallback. */
function participantCard(u: {
  id: string;
  display_name?: string | null;
  name?: string | null;
  username?: string | null;
  avatar_key?: string | null;
  member_role?: string | null;
}): Participant {
  return {
    id: u.id,
    display_name: u.display_name || initialsFor(u.name || ""),
    username: u.username ?? null,
    avatar_url: u.avatar_key ? `/api/media/${u.avatar_key}` : null,
    role: u.member_role ?? null,
  };
}

/** Membership row + conversation kind/title, or null (→ 404, no leak). */
async function membership(
  DB: D1Database,
  conversationId: string,
  userId: string
): Promise<{ role: string; last_read_at: string | null; kind: string; title: string | null } | null> {
  return (await DB.prepare(
    `SELECT cm.role, cm.last_read_at, c.kind, c.title
     FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     WHERE cm.conversation_id = ? AND cm.user_id = ?`
  )
    .bind(conversationId, userId)
    .first()) as {
    role: string;
    last_read_at: string | null;
    kind: string;
    title: string | null;
  } | null;
}

/** Active user row for starting chats / adding members. */
async function activeUser(
  DB: D1Database,
  userId: string
): Promise<{ id: string } | null> {
  return (await DB.prepare(
    "SELECT id FROM users WHERE id = ? AND status = 'active'"
  )
    .bind(userId)
    .first()) as { id: string } | null;
}

async function limited(c: any, key: string, max: number, windowSecs: number) {
  const me = c.get("user").userId as string;
  if (!(await checkRateLimitD1(c.env.DB, `${key}:${me}`, max, windowSecs))) {
    return c.json(
      { ok: false, error: "Too many requests. Please try again later." },
      429
    );
  }
  return null;
}

/* --- List conversations --- */

app.get("/conversations", async (c) => {
  const { DB } = c.env;
  const me = c.get("user").userId as string;
  const q = cleanStr(c.req.query("q"), 60);

  const where: string[] = [];
  const binds: unknown[] = [me, me]; // unread subquery, membership join
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(c.title LIKE ? OR EXISTS (SELECT 1 FROM conversation_members p
        JOIN users u ON u.id = p.user_id
        WHERE p.conversation_id = c.id AND p.user_id != ?
        AND (COALESCE(u.display_name, '') LIKE ? OR COALESCE(u.username, '') LIKE ?)))`
    );
    binds.push(like, me, like, like);
  }

  const rows = (
    await DB.prepare(
      `SELECT c.id, c.kind, c.title,
        (SELECT m.body FROM messages m WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
        (SELECT m.r2_key FROM messages m WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_r2,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_at,
        (SELECT u.display_name FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_name,
        (SELECT u.name FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_real,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
         AND m.sender_id != ? AND m.created_at > COALESCE(cm.last_read_at, '')) AS unread
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY COALESCE(last_at, c.created_at) DESC
       LIMIT ${CONV_LIMIT}`
    )
      .bind(...binds)
      .all()
  ).results as any[];

  // Participants for every listed conversation (one query).
  const byConv = new Map<string, Participant[]>();
  if (rows.length) {
    const ids = rows.map((r) => r.id as string);
    const prows = (
      await DB.prepare(
        `SELECT cm.conversation_id AS cid, u.id, u.display_name, u.name, u.username, u.avatar_key,
                cm.role AS member_role
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id IN (${ids.map(() => "?").join(",")})
           AND u.status = 'active'
         ORDER BY cm.joined_at ASC`
      )
        .bind(...ids)
        .all()
    ).results as any[];
    for (const p of prows) {
      const list = byConv.get(p.cid) || [];
      list.push(participantCard(p));
      byConv.set(p.cid, list);
    }
  }

  const conversations = rows.map((r) => {
    const participants = byConv.get(r.id as string) || [];
    const others = participants.filter((p) => p.id !== me);
    const title =
      r.kind === "dm"
        ? others[0]?.display_name || "Conversation"
        : r.title || "Group chat";
    let preview = "No messages yet.";
    if (r.last_body) {
      preview =
        r.kind === "group" && r.last_sender_name
          ? `${r.last_sender_name || initialsFor(r.last_sender_real || "")}: ${r.last_body}`
          : String(r.last_body);
    } else if (r.last_r2) {
      preview = String(r.last_r2).endsWith(".mp4") ? "Sent a video." : "Sent a photo.";
    }
    return {
      id: r.id,
      kind: r.kind,
      title,
      participants,
      member_count: participants.length,
      last_message: r.last_at
        ? { body: r.last_body, r2_key: r.last_r2, created_at: r.last_at, preview }
        : null,
      unread: Number(r.unread || 0),
    };
  });

  return c.json({ ok: true, conversations });
});

/* --- Start a conversation --- */

app.post("/conversations", async (c) => {
  const no = await limited(c, "chatconv", 20, 3600);
  if (no) return no;
  const { DB } = c.env;
  const me = c.get("user").userId as string;

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  if (!isRecord(data)) return c.json({ ok: false }, 400);

  const kind = cleanStr(data.kind, 10);
  if (kind !== "dm" && kind !== "group") {
    return c.json({ ok: false, error: "Kind must be 'dm' or 'group'." }, 400);
  }

  // Accept user_id (single) or user_ids (array).
  let ids: string[] = [];
  if (typeof data.user_id === "string") ids = [cleanStr(data.user_id, 64)];
  else if (Array.isArray(data.user_ids))
    ids = data.user_ids.map((u) => cleanStr(u, 64)).filter(Boolean);
  ids = [...new Set(ids)].filter((id) => id && id !== me);

  if (kind === "dm") {
    if (ids.length !== 1) {
      return c.json(
        { ok: false, error: "A direct message needs exactly one other member." },
        400
      );
    }
    if (!(await activeUser(DB, ids[0]))) {
      return c.json({ ok: false, error: "That member is not available." }, 400);
    }
    // Idempotent: an existing DM between the two is returned, never duplicated.
    const existing = (await DB.prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
       WHERE c.kind = 'dm' LIMIT 1`
    )
      .bind(me, ids[0])
      .first()) as { id: string } | null;
    if (existing) return c.json({ ok: true, conversation: { id: existing.id }, existing: true });

    const id = crypto.randomUUID();
    await DB.prepare(
      "INSERT INTO conversations (id, kind, title, created_by) VALUES (?, 'dm', NULL, ?)"
    )
      .bind(id, me)
      .run();
    await DB.prepare(
      "INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member'), (?, ?, 'member')"
    )
      .bind(id, me, id, ids[0])
      .run();
    return c.json({ ok: true, conversation: { id, kind: "dm" } });
  }

  // Group chat: at least two others; creator becomes admin.
  if (ids.length < 2) {
    return c.json(
      { ok: false, error: "A group chat needs at least two other members." },
      400
    );
  }
  if (ids.length > 30) {
    return c.json({ ok: false, error: "Groups are limited to 31 members." }, 400);
  }
  const placeholders = ids.map(() => "?").join(",");
  const found = (
    await DB.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active'`
    )
      .bind(...ids)
      .all()
  ).results as { id: string }[];
  if (found.length !== ids.length) {
    return c.json({ ok: false, error: "One of those members is not available." }, 400);
  }
  const title = cleanStr(data.title, TITLE_MAX) || "Group chat";
  const id = crypto.randomUUID();
  await DB.prepare(
    "INSERT INTO conversations (id, kind, title, created_by) VALUES (?, 'group', ?, ?)"
  )
    .bind(id, title, me)
    .run();
  await DB.prepare(
    "INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'admin')"
  )
    .bind(id, me)
    .run();
  for (const uid of ids) {
    await DB.prepare(
      "INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')"
    )
      .bind(id, uid)
      .run();
  }
  return c.json({ ok: true, conversation: { id, kind: "group", title } });
});

/* --- Thread: messages with cursor pagination --- */

app.get("/conversations/:id/messages", async (c) => {
  const { DB } = c.env;
  const me = c.get("user").userId as string;
  const cid = cleanStr(c.req.param("id"), 64);
  if (!cid) return c.json({ ok: false }, 400);

  const mem = await membership(DB, cid, me);
  if (!mem) return c.json({ ok: false, error: "Conversation not found." }, 404);

  const cursor = cleanStr(c.req.query("cursor"), 64);
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || String(MSG_LIMIT), 10) || MSG_LIMIT, 1),
    MSG_MAX
  );

  let before = "";
  const binds: unknown[] = [cid];
  if (cursor) {
    const cur = (await DB.prepare(
      "SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?"
    )
      .bind(cursor, cid)
      .first()) as { created_at: string } | null;
    if (!cur) return c.json({ ok: false, error: "Invalid cursor." }, 400);
    before = "AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))";
    binds.push(cur.created_at, cur.created_at, cursor);
  }

  const rows = (
    await DB.prepare(
      `SELECT m.id, m.sender_id, m.body, m.r2_key, m.created_at,
              u.display_name, u.name, u.username, u.avatar_key
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ${before}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${limit + 1}`
    )
      .bind(...binds)
      .all()
  ).results as any[];

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    nextCursor = rows[limit - 1].id;
    rows.length = limit;
  }
  rows.reverse(); // chronological for rendering

  const messages = rows.map((m: any) => ({
    id: m.id,
    sender: participantCard(m),
    mine: m.sender_id === me,
    body: m.body,
    media_url: m.r2_key ? `/api/media/${m.r2_key}` : null,
    is_video: m.r2_key ? String(m.r2_key).endsWith(".mp4") : false,
    created_at: m.created_at,
  }));

  // Read receipts for the UI ("Seen" / "Seen by N").
  const receipts = (
    await DB.prepare(
      "SELECT user_id, last_read_at FROM conversation_members WHERE conversation_id = ?"
    )
      .bind(cid)
      .all()
  ).results as { user_id: string; last_read_at: string | null }[];
  const read_receipts: Record<string, string | null> = {};
  for (const r of receipts) read_receipts[r.user_id] = r.last_read_at;

  return c.json({
    ok: true,
    kind: mem.kind,
    title: mem.title,
    role: mem.role,
    messages,
    next_cursor: nextCursor,
    read_receipts,
  });
});

/* --- Send a message (text and/or media) --- */

app.post("/conversations/:id/messages", async (c) => {
  const no = await limited(c, "chatmsg", 60, 3600);
  if (no) return no;
  const { DB } = c.env;
  const me = c.get("user").userId as string;
  const cid = cleanStr(c.req.param("id"), 64);
  if (!cid) return c.json({ ok: false }, 400);

  const mem = await membership(DB, cid, me);
  if (!mem) return c.json({ ok: false, error: "Conversation not found." }, 404);

  let body = "";
  let file: File | null = null;
  const ct = c.req.header("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    body = cleanStr(form["body"], BODY_MAX);
    const f = form["file"];
    if (f instanceof File && f.size > 0) file = f;
  } else {
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ ok: false }, 400);
    }
    if (!isRecord(data)) return c.json({ ok: false }, 400);
    body = cleanStr(data.body, BODY_MAX);
  }
  if (!body && !file) {
    return c.json({ ok: false, error: "Write a message or attach a photo or video." }, 400);
  }

  let r2Key: string | null = null;
  if (file) {
    const ext = MEDIA_TYPES[file.type];
    if (!ext) {
      return c.json(
        { ok: false, error: "Photos (PNG, JPG, WEBP, GIF) and MP4 video only." },
        400
      );
    }
    if (file.size > MEDIA_MAX_BYTES) {
      return c.json({ ok: false, error: "Files must be 10 MB or smaller." }, 400);
    }
    r2Key = `chat-${crypto.randomUUID()}.${ext}`;
    await c.env.MEDIA.put(r2Key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });
  }

  const id = crypto.randomUUID();
  await DB.prepare(
    "INSERT INTO messages (id, conversation_id, sender_id, body, r2_key) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, cid, me, body, r2Key)
    .run();

  // Sending counts as reading: keep the sender's own unread count honest.
  await DB.prepare(
    "UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?"
  )
    .bind(new Date().toISOString(), cid, me)
    .run();

  return c.json({
    ok: true,
    message: {
      id,
      body,
      media_url: r2Key ? `/api/media/${r2Key}` : null,
      is_video: r2Key ? r2Key.endsWith(".mp4") : false,
    },
  });
});

/* --- Mark a conversation read --- */

app.post("/conversations/:id/read", async (c) => {
  const { DB } = c.env;
  const me = c.get("user").userId as string;
  const cid = cleanStr(c.req.param("id"), 64);
  if (!cid) return c.json({ ok: false }, 400);

  const mem = await membership(DB, cid, me);
  if (!mem) return c.json({ ok: false, error: "Conversation not found." }, 404);

  await DB.prepare(
    "UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?"
  )
    .bind(new Date().toISOString(), cid, me)
    .run();
  return c.json({ ok: true });
});

/* --- Group members: admins add/remove --- */

app.post("/conversations/:id/members", async (c) => {
  const { DB } = c.env;
  const me = c.get("user").userId as string;
  const cid = cleanStr(c.req.param("id"), 64);
  if (!cid) return c.json({ ok: false }, 400);

  const mem = await membership(DB, cid, me);
  if (!mem) return c.json({ ok: false, error: "Conversation not found." }, 404);
  if (mem.kind !== "group") {
    return c.json({ ok: false, error: "Members can only change in group chats." }, 400);
  }
  if (mem.role !== "admin") {
    return c.json({ ok: false, error: "Only group admins can manage members." }, 403);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  if (!isRecord(data)) return c.json({ ok: false }, 400);
  const action = cleanStr(data.action, 10);
  const target = cleanStr(data.user_id, 64);
  if (action !== "add" && action !== "remove") {
    return c.json({ ok: false, error: "Action must be 'add' or 'remove'." }, 400);
  }
  if (!target) return c.json({ ok: false, error: "Choose a member." }, 400);

  if (action === "remove") {
    if (target === me) {
      // Guarantees a group always keeps at least one admin.
      return c.json({ ok: false, error: "Admins cannot remove themselves." }, 400);
    }
    await DB.prepare(
      "DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?"
    )
      .bind(cid, target)
      .run();
    return c.json({ ok: true, removed: target });
  }

  if (target === me) {
    return c.json({ ok: false, error: "You are already in this group." }, 400);
  }
  if (!(await activeUser(DB, target))) {
    return c.json({ ok: false, error: "That member is not available." }, 400);
  }
  await DB.prepare(
    "INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')"
  )
    .bind(cid, target)
    .run();
  return c.json({ ok: true, added: target });
});

/* --- Member directory search (for starting chats) --- */

app.get("/people", async (c) => {
  const { DB } = c.env;
  const me = c.get("user").userId as string;
  const q = cleanStr(c.req.query("q"), 60);
  if (q.length < 2) return c.json({ ok: true, people: [] });

  const like = `%${q}%`;
  const rows = (
    await DB.prepare(
      `SELECT id, display_name, name, username, avatar_key FROM users
       WHERE status = 'active' AND id != ?
         AND (COALESCE(display_name, '') LIKE ? OR COALESCE(username, '') LIKE ? OR COALESCE(name, '') LIKE ?)
       ORDER BY COALESCE(display_name, name) ASC
       LIMIT 20`
    )
      .bind(me, like, like, like)
      .all()
  ).results as any[];

  return c.json({ ok: true, people: rows.map(participantCard) });
});

/* --- Story replies: surface replies to the caller's stories.
 *
 * Contract with the stories area (migration 0018, landed mid-task):
 *   stories(id, author_id, r2_key, kind, created_at, expires_at)
 *   story_replies(id, story_id, from_user_id, body, created_at)
 * Replies are NOT DMs themselves — this endpoint is the chat area's side of
 * the contract: every reply to one of the caller's stories shows up here.
 * The sqlite_master feature-detect stays as cheap insurance for checkouts
 * that predate 0018. */
app.get("/story-replies", async (c) => {
  const { DB } = c.env;
  const me = c.get("user").userId as string;

  const table = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'story_replies'"
  ).first();
  if (!table) {
    return c.json({
      ok: true,
      replies: [],
      feature: "unavailable",
      note: "Stories are not enabled yet.",
    });
  }

  try {
    const rows = (
      await DB.prepare(
        `SELECT sr.id, sr.story_id, sr.from_user_id, sr.body, sr.created_at,
                u.display_name, u.name, u.username, u.avatar_key
         FROM story_replies sr
         JOIN stories s ON s.id = sr.story_id AND s.author_id = ?
         JOIN users u ON u.id = sr.from_user_id AND u.status = 'active'
         ORDER BY sr.created_at DESC
         LIMIT 50`
      )
        .bind(me)
        .all()
    ).results as any[];
    return c.json({
      ok: true,
      feature: "available",
      replies: rows.map((r: any) => ({
        id: r.id,
        story_id: r.story_id,
        from: participantCard({
          id: r.from_user_id,
          display_name: r.display_name,
          name: r.name,
          username: r.username,
          avatar_key: r.avatar_key,
        }),
        body: r.body,
        created_at: r.created_at,
      })),
    });
  } catch {
    return c.json({
      ok: true,
      replies: [],
      feature: "degraded",
      note: "Story replies are temporarily unavailable.",
    });
  }
});

export default app;
