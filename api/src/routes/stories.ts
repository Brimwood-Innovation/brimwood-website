/* Stories — 24h ephemeral member photos/videos (Instagram/Facebook model,
 * Brimwood-adapted: calm, anonymous-by-default, members-only).
 *
 * Mounted at "/api/stories". Every endpoint requires a member session
 * (401 without one): stories are community content, never public.
 * Author display follows profiles.ts — user-controlled display_name,
 * falling back to initials ("K."), never email or real name.
 *
 * - POST   /api/stories (multipart, field "file") → upload a story.
 *          Photos PNG/JPG/WEBP/GIF and video MP4 only; max 10 MB;
 *          rate-limited to 10 uploads per user per day.
 *          expires_at is written as created_at + 24h at insert time.
 * - GET    /api/stories/tray → unexpired stories grouped by author,
 *          newest stories first, the requester's own stories first.
 *          Each story carries a seen/unseen flag for the requester
 *          (emerald ring vs grey ring in the tray UI).
 * - GET    /api/stories/:id → one story; 404 when expired or unknown
 *          (no way to distinguish the two). Marks the story viewed by
 *          the requester (idempotent: one view per viewer). The viewer
 *          list is returned ONLY to the story's author — viewers stay
 *          anonymous to everyone else.
 * - POST   /api/stories/:id/reply {body} → store a text reply (1-500
 *          chars). Replies are conversation starters for the DM/chat
 *          system, which surfaces each new reply to the story author.
 *          Contract: tasks/social-stories.md.
 *
 * Expiry is enforced lazily: every read filters on
 * `expires_at > <now>`. Periodic hard-deletion of expired rows (and their
 * R2 objects) is a scheduled-job concern — see 0018_stories.sql; expiry
 * correctness never depends on that job running.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getUserId } from "../lib/auth";
import { cleanStr } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { initialsFor } from "./profiles";

const app = new Hono<{ Bindings: Bindings }>();

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const TRAY_LIMIT = 200;
const VIEWER_LIMIT = 200;
const REPLY_MAX = 500;
const UPLOADS_PER_DAY = 10;
const REPLIES_PER_DAY = 60;
const STORY_TTL_MS = 24 * 3600 * 1000; // 24 hours

/** MIME type → kind. SVG is deliberately excluded: an SVG story could
 *  carry scripts, and stories are meant to be photos or clips. */
const ALLOWED_TYPES: Record<string, { kind: "photo" | "video"; ext: string }> = {
  "image/png": { kind: "photo", ext: "png" },
  "image/jpeg": { kind: "photo", ext: "jpg" },
  "image/webp": { kind: "photo", ext: "webp" },
  "image/gif": { kind: "photo", ext: "gif" },
  "video/mp4": { kind: "video", ext: "mp4" },
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Anonymous-by-default author label: display_name, else initials. */
function displayOf(row: { display_name?: string | null; name?: string | null }): string {
  return row.display_name || initialsFor(row.name || "");
}

function needAuth(userId: string | null) {
  return userId
    ? null
    : { json: { ok: false, error: "Sign in required." }, status: 401 as const };
}

function mediaUrl(c: any, r2Key: string): string {
  const host = c.req.header("host") || "brimwood-api.adamsayani.workers.dev";
  return `https://${host}/api/media/${r2Key}`;
}

/* --- POST /api/stories — upload a story (member session, multipart) --- */

app.post("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);
  const { DB } = c.env;

  if (!(await checkRateLimitD1(DB, "story:" + userId, UPLOADS_PER_DAY, 86400))) {
    return c.json({ ok: false, error: "Story limit reached for today. Try again tomorrow." }, 429);
  }

  let file: File | null = null;
  try {
    const body = await c.req.parseBody();
    const f = body["file"];
    if (f instanceof File) file = f;
  } catch {
    return c.json({ ok: false, error: "Invalid upload." }, 400);
  }

  if (!file || file.size === 0) {
    return c.json({ ok: false, error: "Choose a photo or video to share." }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ ok: false, error: "File is too large. Maximum 10 MB." }, 400);
  }
  const type = ALLOWED_TYPES[file.type];
  if (!type) {
    return c.json(
      { ok: false, error: "File type not allowed. Use a photo (PNG, JPG, WEBP, GIF) or an MP4 video." },
      400
    );
  }

  // Server-generated flat key: unique per upload, no client input in the path.
  const key = `story-${crypto.randomUUID()}.${type.ext}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const created = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + STORY_TTL_MS).toISOString();
  await DB.prepare(
    `INSERT INTO stories (id, author_id, r2_key, kind, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, userId, key, type.kind, created, expires)
    .run();

  return c.json({ ok: true, id, kind: type.kind, url: mediaUrl(c, key), expires_at: expires });
});

/* --- GET /api/stories/tray — unexpired stories grouped by author --- */

app.get("/tray", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);
  const { DB } = c.env;

  const rows = await DB.prepare(
    `SELECT s.id, s.r2_key, s.kind, s.created_at, s.expires_at, s.author_id,
            u.display_name, u.name,
            EXISTS (SELECT 1 FROM story_views v
                    WHERE v.story_id = s.id AND v.viewer_id = ?) AS seen
     FROM stories s
     JOIN users u ON u.id = s.author_id
     WHERE s.expires_at > ? AND u.status = 'active'
     ORDER BY s.created_at DESC
     LIMIT ?`
  )
    .bind(userId, nowIso(), TRAY_LIMIT)
    .all();

  const authors = new Map<string, any>();
  for (const r of rows.results as any[]) {
    let a = authors.get(r.author_id);
    if (!a) {
      a = {
        author_id: r.author_id,
        display: displayOf(r),
        is_self: r.author_id === userId,
        stories: [],
      };
      authors.set(r.author_id, a);
    }
    a.stories.push({
      id: r.id,
      kind: r.kind,
      url: mediaUrl(c, r.r2_key),
      created_at: r.created_at,
      expires_at: r.expires_at,
      seen: !!r.seen,
    });
  }

  // Own stories first (the "You" tile), then authors by newest story.
  const groups = [...authors.values()].sort((x, y) => {
    if (x.is_self !== y.is_self) return x.is_self ? -1 : 1;
    return y.stories[0].created_at.localeCompare(x.stories[0].created_at);
  });
  for (const g of groups) {
    g.has_unseen = g.stories.some((s: any) => !s.seen);
  }

  return c.json({ ok: true, authors: groups });
});

/* --- GET /api/stories/:id — one story; marks viewed; author sees viewers --- */

app.get("/:id", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);
  const { DB } = c.env;

  const id = cleanStr(c.req.param("id"), 100);
  const story: any = await DB.prepare(
    `SELECT s.id, s.r2_key, s.kind, s.created_at, s.expires_at, s.author_id,
            u.display_name, u.name
     FROM stories s
     JOIN users u ON u.id = s.author_id
     WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'`
  )
    .bind(id, nowIso())
    .first();

  // Expired and unknown are indistinguishable on purpose: no oracle for
  // whether a story id ever existed.
  if (!story) return c.json({ ok: false, error: "Not found." }, 404);

  // Idempotent view mark: one row per (story, viewer).
  await DB.prepare(
    "INSERT OR IGNORE INTO story_views (story_id, viewer_id) VALUES (?, ?)"
  )
    .bind(story.id, userId)
    .run();

  const out: any = {
    ok: true,
    story: {
      id: story.id,
      kind: story.kind,
      url: mediaUrl(c, story.r2_key),
      author: displayOf(story),
      author_id: story.author_id,
      created_at: story.created_at,
      expires_at: story.expires_at,
    },
  };

  // Viewer list is author-only. Chronological (most recent first) — no
  // engagement ranking; calm over "who's watching me" folklore.
  if (story.author_id === userId) {
    const viewers = await DB.prepare(
      `SELECT v.viewed_at, u.display_name, u.name
       FROM story_views v
       JOIN users u ON u.id = v.viewer_id
       WHERE v.story_id = ? AND v.viewer_id != ?
       ORDER BY v.viewed_at DESC
       LIMIT ?`
    )
      .bind(story.id, userId, VIEWER_LIMIT)
      .all();
    out.viewers = (viewers.results as any[]).map((v) => ({
      display: displayOf(v),
      viewed_at: v.viewed_at,
    }));
  }

  return c.json(out);
});

/* --- POST /api/stories/:id/reply — reply to a story (stored for DM surfacing) --- */

app.post("/:id/reply", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);
  const { DB } = c.env;

  if (!(await checkRateLimitD1(DB, "story-reply:" + userId, REPLIES_PER_DAY, 86400))) {
    return c.json({ ok: false, error: "Too many replies. Please slow down." }, 429);
  }

  const id = cleanStr(c.req.param("id"), 100);
  const story: any = await DB.prepare(
    "SELECT id FROM stories WHERE id = ? AND expires_at > ?"
  )
    .bind(id, nowIso())
    .first();
  if (!story) return c.json({ ok: false, error: "Not found." }, 404);

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  const raw = String(data.body ?? "").trim();
  if (!raw) return c.json({ ok: false, error: "Write a reply first." }, 400);
  if (raw.length > REPLY_MAX) {
    return c.json({ ok: false, error: "Replies are limited to 500 characters." }, 400);
  }
  const body = raw;

  const replyId = crypto.randomUUID();
  await DB.prepare(
    `INSERT INTO story_replies (id, story_id, from_user_id, body)
     VALUES (?, ?, ?, ?)`
  )
    .bind(replyId, story.id, userId, body)
    .run();

  // The DM/chat system surfaces this row to the story author; the reply is
  // not shown anywhere else (stories have no public comment thread).
  return c.json({ ok: true, id: replyId });
});

export default app;
