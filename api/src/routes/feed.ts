/* Feed, media posts, polls and reels (social area: feed agent).
 * Members-only; feed is chronological, never ranked. Calm by brand rule.
 *
 * Mounted at "/api" (same convention as routes/comments.ts and routes/media.ts):
 *   POST /api/media/upload        member upload of photo/video (multipart, field "file")
 *                                 → { key, url, kind: photo|video|reel, duration_s }
 *   POST /api/posts               member post: text + media refs + optional poll,
 *                                 plus the deck composer fields: intent (one of the
 *                                 four member intents) and audience (members,
 *                                 only_me, or group with group_id)
 *   GET  /api/groups/mine         the caller's active groups, for the composer
 *                                 audience picker
 *   GET  /api/feed?limit=&cursor= chronological feed, embeds media + poll state
 *   POST /api/polls/:id/vote      { option_id } - one vote per member, changeable
 *                                 until the poll closes
 *   GET  /api/polls/:id/results   counts always; voter list only when the poll's
 *                                 show_voters flag is on
 *
 * Reels are videos <= 90s, flagged kind="reel" at upload (R2 metadata check on
 * attach re-verifies). Uploads live in the shared brimwood-media bucket.
 * Member uploads may not be SVG (script risk); media.ts already forces SVG
 * downloads, but SVGs in a post must never render inline at all.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getUserId } from "../lib/auth";
import { cleanStr, clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { initialsFor } from "./profiles";
import { checkMagicBytes } from "../lib/upload";

const app = new Hono<{ Bindings: Bindings }>();

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB, same ceiling as admin media uploads
const REEL_MAX_S = 90; // <= 90s is a reel (matches Facebook/Instagram practice)
const VIDEO_MAX_S = 600; // member videos cap at 10 minutes
const MAX_MEDIA_PER_POST = 4;
const MAX_FEED_LIMIT = 50;

/** MIME → extension for member uploads. No SVG: never render member uploads inline. */
const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
};

const POLL_DURATIONS: Record<string, number> = {
  "1h": 3600,
  "1d": 86400,
  "3d": 3 * 86400,
  "7d": 7 * 86400,
};

/* Phase 3 slice 4, deck feed screen: the member composer offers exactly
 * these four intents (the deck's intent chips). Staff post types
 * (announcement, spotlight, ritual, event_recap, intro) are not member
 * composer values; they arrive through the Studio slice instead. */
const MEMBER_INTENTS = ["progress", "question", "feedback", "resource"] as const;

/** Require a signed-in member; returns the user id, or null. */
async function needUser(c: any): Promise<string | null> {
  return getUserId(c);
}

function hostOf(c: any): string {
  return c.req.header("host") || "brimwood-api.adamsayani.workers.dev";
}

function mediaUrl(c: any, key: string): string {
  return `https://${hostOf(c)}/api/media/${encodeURIComponent(key)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Public-safe member shape for feed authors/voters. Never email or real name.
 * is_staff marks admin authors, which the deck feed screen shows with a
 * Staff badge (the deck's "Brimwood team" staff posts). */
function publicAuthor(row: any, c: any) {
  const key = row.avatar_r2_key || row.avatar_key;
  const username = row.username || row.author_username || null;
  return {
    id: row.id,
    display: row.display_name || initialsFor(row.name || ""),
    username,
    profile_url: username ? `/@${username}` : `/u/${row.id}`,
    avatar_url: key ? mediaUrl(c, key) : null,
    is_staff: row.role === "admin" || row.author_role === "admin",
  };
}

function closedOf(closesAt: string): boolean {
  return closesAt <= nowIso();
}

/* Phase 1 item 1: feed reads run against feed_posts (0022) with the v5
 * visibility rule. Published and not deleted; the viewer may see the
 * audience (members, their own only_me posts, or groups they actively
 * belong to); and neither side has blocked the other (block_pairs is the
 * both-ways view from 0025). Binds the viewer id three times. */
const FEED_VISIBILITY = `
  AND p.status = 'published'
  AND p.deleted_at IS NULL
  AND (
    p.audience = 'members'
    OR (p.audience = 'only_me' AND p.author_id = ?)
    OR (p.audience = 'group' AND EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = p.group_id AND gm.user_id = ? AND gm.state = 'active'))
  )
  AND NOT EXISTS (SELECT 1 FROM block_pairs WHERE a = ? AND b = p.author_id)
`;

/* --- Member: upload a photo or video for a post --- */

app.post("/media/upload", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);

  if (!(await checkRateLimitD1(c.env.DB, "feed:upload:" + clientIp(c.req.raw), 20, 3600))) {
    return c.json({ ok: false, error: "Too many uploads. Please try again later." }, 429);
  }

  let file: File | null = null;
  let durationS = 0;
  try {
    const body = await c.req.parseBody();
    const f = body["file"];
    if (f instanceof File) file = f;
    if (typeof body["duration_s"] === "string") {
      const n = Number(body["duration_s"]);
      if (Number.isFinite(n) && n > 0) durationS = n;
    }
  } catch {
    return c.json({ ok: false, error: "Invalid upload." }, 400);
  }

  if (!file || file.size === 0) {
    return c.json({ ok: false, error: "Choose a file to upload." }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ ok: false, error: "File is too large. Maximum 10 MB." }, 400);
  }
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return c.json(
      { ok: false, error: "File type not allowed. Use PNG, JPG, WEBP, GIF, or MP4." },
      400
    );
  }

  const isVideo = file.type === "video/mp4";
  // Client reports the duration from the <video> element; sanity-checked here.
  let kind: "photo" | "video" | "reel" = "photo";
  if (isVideo) {
    if (!(durationS > 0) || durationS > VIDEO_MAX_S) {
      return c.json(
        { ok: false, error: "Video needs a duration under 10 minutes." },
        400
      );
    }
    kind = durationS <= REEL_MAX_S ? "reel" : "video";
  } else if (durationS > 0) {
    durationS = 0; // photos have no duration; ignore the claim
  }

  const key = `feed-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  // Hardening (from PR #16): file.type is browser-supplied, so verify the
  // actual content bytes before storing.
  const bytes = await file.arrayBuffer();
  if (!checkMagicBytes(bytes, file.type)) {
    return c.json({ ok: false, error: "File content doesn't match its type." }, 400);
  }
  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: file.type },
  });

  return c.json({
    ok: true,
    key,
    url: mediaUrl(c, key),
    kind,
    duration_s: isVideo ? Math.round(durationS) : null,
  });
});

/* --- Member: their active groups, for the composer audience picker --- */

app.get("/groups/mine", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT g.id, g.name, g.slug FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ? AND gm.state = 'active' AND g.status = 'active'
     ORDER BY g.name`
  )
    .bind(userId)
    .all();
  return c.json({
    ok: true,
    groups: (rows.results as any[]).map((g) => ({ id: g.id, name: g.name, slug: g.slug })),
  });
});

/* --- Member: create a post --- */

app.post("/posts", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);

  if (!(await checkRateLimitD1(c.env.DB, "feed:post:" + clientIp(c.req.raw), 30, 3600))) {
    return c.json({ ok: false, error: "Too many posts. Please try again later." }, 429);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid post." }, 400);
  }

  const body = cleanStr(data.body, 2000);
  const mediaIn = Array.isArray(data.media) ? data.media : [];
  const pollIn = data.poll as Record<string, unknown> | undefined;

  // Deck composer fields: intent chips and the audience picker. The column
  // defaults (intent progress, audience members) apply when omitted, so old
  // clients keep posting exactly as before.
  const intent = typeof data.intent === "string" && data.intent ? data.intent : "progress";
  if (!(MEMBER_INTENTS as readonly string[]).includes(intent)) {
    return c.json({ ok: false, error: "Pick one of the four post types: progress, question, feedback, or resource." }, 400);
  }
  const audience = typeof data.audience === "string" && data.audience ? data.audience : "members";
  if (!["members", "only_me", "group"].includes(audience)) {
    return c.json({ ok: false, error: "Pick who can see this post: members, only you, or a group." }, 400);
  }
  const groupId = typeof data.group_id === "string" ? data.group_id.slice(0, 40) : "";
  if ((audience === "group") !== (groupId !== "")) {
    return c.json({ ok: false, error: "Group posts need a group, and other posts must not name one." }, 400);
  }

  if (mediaIn.length > MAX_MEDIA_PER_POST) {
    return c.json({ ok: false, error: `Posts can carry at most ${MAX_MEDIA_PER_POST} photos or videos.` }, 400);
  }

  // A post is text, media, or a poll - never empty.
  if (!body && mediaIn.length === 0 && !pollIn) {
    return c.json({ ok: false, error: "Write something, add media, or add a poll." }, 400);
  }

  // Verify each media ref exists in R2 and re-derive kind from stored metadata
  // (client claims are hints, never trusted for the reel flag).
  const media: { key: string; kind: string; width: number | null; height: number | null; duration_s: number | null }[] = [];
  for (let i = 0; i < mediaIn.length; i++) {
    const m = mediaIn[i] as Record<string, unknown>;
    const key = typeof m.key === "string" ? m.key : "";
    if (!key || key.length > 200 || !/^[a-zA-Z0-9._-]+$/.test(key)) {
      return c.json({ ok: false, error: "Invalid media reference." }, 400);
    }
    const obj = await c.env.MEDIA.head(key);
    if (!obj) return c.json({ ok: false, error: "One of the attached files was not found." }, 400);
    const ct = obj.httpMetadata?.contentType || "";
    if (ct !== "video/mp4" && !Object.keys(ALLOWED_TYPES).some((t) => t === ct)) {
      return c.json({ ok: false, error: "One of the attached files is not an allowed type." }, 400);
    }
    if (ct === "image/svg+xml") {
      return c.json({ ok: false, error: "SVG uploads are not allowed in posts." }, 400);
    }
    const isVideo = ct === "video/mp4";
    const dur = isVideo ? Number((m as any).duration_s) : 0;
    const duration = isVideo && Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null;
    media.push({
      key,
      kind: isVideo ? (duration && duration <= REEL_MAX_S ? "reel" : "video") : "photo",
      width: Number.isFinite(Number(m.width)) && Number(m.width) > 0 ? Math.round(Number(m.width)) : null,
      height: Number.isFinite(Number(m.height)) && Number(m.height) > 0 ? Math.round(Number(m.height)) : null,
      duration_s: duration,
    });
  }

  // Optional poll: question + 2-4 options + duration picker (1h/1d/3d/7d).
  let poll: { question: string; options: string[]; closesAt: string; showVoters: number } | null = null;
  if (pollIn) {
    const question = cleanStr(pollIn.question, 140);
    const optsRaw = Array.isArray(pollIn.options) ? pollIn.options : [];
    const options = optsRaw
      .map((o) => cleanStr(o, 60))
      .filter((o) => o.length > 0);
    const durKey = typeof pollIn.duration === "string" ? pollIn.duration : "";
    const secs = POLL_DURATIONS[durKey];
    if (!question) return c.json({ ok: false, error: "Give your poll a question." }, 400);
    if (options.length < 2) return c.json({ ok: false, error: "Polls need at least two options." }, 400);
    if (options.length > 4) return c.json({ ok: false, error: "Polls can have at most four options." }, 400);
    if (!secs) return c.json({ ok: false, error: "Pick a poll length: 1 hour, 1 day, 3 days, or 7 days." }, 400);
    // Dedupe identical options (keep order).
    const seen = new Set<string>();
    const deduped = options.filter((o) => {
      const k = o.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (deduped.length < 2) return c.json({ ok: false, error: "Poll options need to be different from each other." }, 400);
    poll = {
      question,
      options: deduped,
      closesAt: new Date(Date.now() + secs * 1000).toISOString(),
      showVoters: pollIn.show_voters === 1 || pollIn.show_voters === true ? 1 : 0,
    };
  }

  const { DB } = c.env;
  const postId = crypto.randomUUID();
  const createdAt = nowIso();

  // Group posts need an active membership (the 0026 trigger enforces this
  // too, but a clean 403 beats a trigger error). The caller must be an
  // active member of the named group, and the group must be active.
  if (audience === "group") {
    const member: any = await DB.prepare(
      `SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id = ? AND gm.user_id = ? AND gm.state = 'active' AND g.status = 'active'`
    )
      .bind(groupId, userId)
      .first();
    if (!member) {
      return c.json({ ok: false, error: "You are not an active member of that group." }, 403);
    }
  }

  const stmts: any[] = [
    // Phase 1 item 1: the feed table is feed_posts (0022 fixed the P0
    // collision with the blog "posts" table from 0002).
    DB.prepare(
      "INSERT INTO feed_posts (id, author_id, body, intent, audience, group_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      postId,
      userId,
      body,
      intent,
      audience,
      audience === "group" ? groupId : null,
      createdAt
    ),
  ];
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    stmts.push(
      DB.prepare(
        "INSERT INTO post_media (id, post_id, r2_key, kind, width, height, duration_s, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), postId, m.key, m.kind, m.width, m.height, m.duration_s, i)
    );
  }
  let pollId: string | null = null;
  if (poll) {
    pollId = crypto.randomUUID();
    stmts.push(
      DB.prepare(
        "INSERT INTO polls (id, post_id, question, closes_at, show_voters, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(pollId, postId, poll.question, poll.closesAt, poll.showVoters, createdAt)
    );
    poll.options.forEach((label, i) => {
      stmts.push(
        DB.prepare("INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)").bind(
          crypto.randomUUID(),
          pollId,
          label,
          i
        )
      );
    });
  }
  await DB.batch(stmts);

  // @mention notifications (best-effort; never break posting).
  if (body) {
    try {
      const { parseMentions, resolveMentionedUsers, emitNotification } = await import("./notifications");
      const mentioned = await resolveMentionedUsers(DB, parseMentions(body));
      for (const u of mentioned) {
        if (u.id === userId) continue;
        await emitNotification(DB, {
          userId: u.id,
          kind: "mention",
          actorId: userId,
          targetType: "post",
          targetId: postId,
          preview: body.slice(0, 200),
        });
      }
    } catch {
      /* notifications must never break posting */
    }
  }

  return c.json({ ok: true, post_id: postId, poll_id: pollId, created_at: createdAt });
});

/* Batch-enrich raw post rows (media, polls, votes, reactions) and shape
 * the public post objects. Shared by the feed list and the permalink. */
async function enrichPosts(c: any, userId: string, page: any[]): Promise<any[]> {
  const { DB } = c.env;
    const postIds = page.map((p: any) => p.id);

    // Batch-fetch media, polls, options, counts, and the viewer's votes.
    let mediaRows: any[] = [];
    let pollRows: any[] = [];
    let optionRows: any[] = [];
    let countRows: any[] = [];
    let myVoteRows: any[] = [];
    if (postIds.length > 0) {
      const inList = postIds.map(() => "?").join(",");
      mediaRows = (
        await DB.prepare(
          `SELECT post_id, r2_key, kind, width, height, duration_s, position
           FROM post_media WHERE post_id IN (${inList}) ORDER BY post_id, position`
        )
          .bind(...postIds)
          .all()
      ).results;
      pollRows = (
        await DB.prepare(
          `SELECT id, post_id, question, closes_at, show_voters FROM polls WHERE post_id IN (${inList})`
        )
          .bind(...postIds)
          .all()
      ).results;
      const pollIds = pollRows.map((p: any) => p.id);
      if (pollIds.length > 0) {
        const pIn = pollIds.map(() => "?").join(",");
        optionRows = (
          await DB.prepare(
            `SELECT id, poll_id, label, position FROM poll_options WHERE poll_id IN (${pIn}) ORDER BY poll_id, position`
          )
            .bind(...pollIds)
            .all()
        ).results;
        countRows = (
          await DB.prepare(
            `SELECT option_id, COUNT(*) AS votes FROM poll_votes WHERE poll_id IN (${pIn}) GROUP BY option_id`
          )
            .bind(...pollIds)
            .all()
        ).results;
        myVoteRows = (
          await DB.prepare(
            `SELECT poll_id, option_id FROM poll_votes WHERE poll_id IN (${pIn}) AND voter_id = ?`
          )
            .bind(...pollIds, userId)
            .all()
        ).results;
      }
    }

    const counts: Record<string, number> = {};
    for (const r of countRows) counts[r.option_id] = r.votes;
    const myVotes: Record<string, string> = {};
    for (const r of myVoteRows) myVotes[r.poll_id] = r.option_id;

    // Reactions: counts per post per kind, plus the viewer's own reaction.
    const reactCounts: Record<string, Record<string, number>> = {};
    const myReacts: Record<string, string> = {};
    if (postIds.length > 0) {
      const inList = postIds.map(() => "?").join(",");
      const rc = await DB.prepare(
        `SELECT post_id,
                CASE WHEN kind = 'like' THEN 'thanks' ELSE kind END AS kind,
                COUNT(*) AS n FROM post_reactions
         WHERE post_id IN (${inList}) GROUP BY post_id, 2`
      )
        .bind(...postIds)
        .all();
      for (const r of rc.results as any[]) {
        (reactCounts[r.post_id] ||= {})[r.kind] = Number(r.n);
      }
      const mr = await DB.prepare(
        `SELECT post_id, kind FROM post_reactions WHERE post_id IN (${inList}) AND member_id = ?`
      )
        .bind(...postIds, userId)
        .all();
      for (const r of mr.results as any[]) myReacts[r.post_id] = normalizeReaction(r.kind);
    }

    const pollsByPost: Record<string, any> = {};
    for (const p of pollRows) {
      const opts = optionRows
        .filter((o) => o.poll_id === p.id)
        .map((o) => ({ id: o.id, label: o.label, votes: counts[o.id] || 0 }));
      const total = opts.reduce((s: number, o: any) => s + o.votes, 0);
      pollsByPost[p.post_id] = {
        id: p.id,
        question: p.question,
        closes_at: p.closes_at,
        closed: closedOf(p.closes_at),
        show_voters: p.show_voters === 1,
        total_votes: total,
        options: opts,
        my_vote: myVotes[p.id] || null,
      };
    }

    const posts = page.map((p: any) => ({
      id: p.id,
      body: p.body,
      intent: p.intent || "progress",
      audience: p.audience || "members",
      group: p.group_id
        ? { id: p.group_id, name: p.group_name || "", slug: p.group_slug || "" }
        : null,
      created_at: p.created_at,
      author: publicAuthor(
        { id: p.author_id, name: p.author_name, display_name: p.display_name, author_username: p.author_username, avatar_key: p.avatar_key, avatar_r2_key: p.avatar_r2_key, author_role: p.author_role },
        c
      ),
      media: mediaRows
        .filter((m) => m.post_id === p.id)
        .map((m) => ({
          url: mediaUrl(c, m.r2_key),
          kind: m.kind,
          width: m.width,
          height: m.height,
          duration_s: m.duration_s,
        })),
      poll: pollsByPost[p.id] || null,
      reactions: {
        counts: REACTIONS.reduce((o, k) => ({ ...o, [k]: (reactCounts[p.id] || {})[k] || 0 }), {}),
        my_reaction: myReacts[p.id] || null,
      },
    }));
  return posts;
}

/* --- Member: single post permalink (for notification deep links / shares) --- */

app.get("/posts/:id", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);
  const { DB } = c.env;
  const id = (c.req.param("id") || "").slice(0, 40);
  const row: any = await DB.prepare(
    `SELECT p.id, p.body, p.intent, p.audience, p.group_id, p.created_at,
            u.id AS author_id, u.name AS author_name, u.display_name, u.username AS author_username,
            u.avatar_key, u.avatar_r2_key, u.role AS author_role,
            g.name AS group_name, g.slug AS group_slug
     FROM feed_posts p JOIN users u ON u.id = p.author_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE p.id = ?${FEED_VISIBILITY}`
  )
    .bind(id, userId, userId, userId)
    .first();
  if (!row) return c.json({ ok: false, error: "Not found." }, 404);
  const posts = await enrichPosts(c, userId, [row]);
  return c.json({ ok: true, post: posts[0] });
});

/* --- Member: chronological feed --- */

app.get("/feed", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);

  const { DB } = c.env;
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), MAX_FEED_LIMIT);
  const cursor = (c.req.query("cursor") || "").slice(0, 40);

  const rows = await DB.prepare(
    `SELECT p.id, p.body, p.intent, p.audience, p.group_id, p.created_at,
            u.id AS author_id, u.name AS author_name, u.display_name, u.username AS author_username,
            u.avatar_key, u.avatar_r2_key, u.role AS author_role,
            g.name AS group_name, g.slug AS group_slug
     FROM feed_posts p
     JOIN users u ON u.id = p.author_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE (? = '' OR p.created_at < ?)${FEED_VISIBILITY}
     ORDER BY p.created_at DESC LIMIT ?`
  )
    .bind(cursor, cursor, userId, userId, userId, limit + 1)
    .all();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const posts = await enrichPosts(c, userId, page);


  return c.json({
    ok: true,
    posts,
    next_cursor: hasMore ? page[page.length - 1].created_at : null,
  });
});

/* --- Member: vote on a poll (changeable until it closes) --- */

app.post("/polls/:id/vote", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);

  if (!(await checkRateLimitD1(c.env.DB, "feed:vote:" + clientIp(c.req.raw), 120, 3600))) {
    return c.json({ ok: false, error: "Too many votes. Please try again later." }, 429);
  }

  const { DB } = c.env;
  const pollId = c.req.param("id");
  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid vote." }, 400);
  }
  const optionId = typeof data.option_id === "string" ? data.option_id : "";

  const poll: any = await DB.prepare(
    "SELECT id, question, closes_at, show_voters FROM polls WHERE id = ?"
  )
    .bind(pollId)
    .first();
  if (!poll) return c.json({ ok: false, error: "Poll not found." }, 404);
  if (closedOf(poll.closes_at)) return c.json({ ok: false, error: "This poll has closed." }, 400);

  const option: any = await DB.prepare(
    "SELECT id FROM poll_options WHERE id = ? AND poll_id = ?"
  )
    .bind(optionId, pollId)
    .first();
  if (!option) return c.json({ ok: false, error: "That is not an option on this poll." }, 400);

  // One vote per member per poll; re-voting changes the vote until close.
  await DB.prepare(
    `INSERT INTO poll_votes (id, poll_id, option_id, voter_id, voted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (poll_id, voter_id)
     DO UPDATE SET option_id = excluded.option_id, voted_at = excluded.voted_at`
  )
    .bind(crypto.randomUUID(), pollId, optionId, userId, nowIso())
    .run();

  return c.json({ ok: true, option_id: optionId });
});

const REACTIONS = ["thanks", "celebrate", "insightful", "support"] as const;

/* Legacy client alias: the first calm reaction shipped as "like" and is now
 * the brand-canon "Thanks" (program R4). Normalize on the way in and out so
 * old clients and old rows keep working with the canonical key. */
const REACTION_ALIASES: Record<string, string> = { like: "thanks" };
function normalizeReaction(kind: string): string {
  return REACTION_ALIASES[kind] ?? kind;
}

/* --- Member: toggle a calm reaction on a post --- */

app.post("/posts/:id/react", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);

  const { DB } = c.env;
  const postId = c.req.param("id");
  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid reaction." }, 400);
  }
  const rawKind = typeof data.kind === "string" ? data.kind : "";
  const kind = normalizeReaction(rawKind);
  if (!(REACTIONS as readonly string[]).includes(kind)) {
    return c.json({ ok: false, error: "Pick one of the four reactions." }, 400);
  }

  const post: any = await DB.prepare("SELECT id, author_id FROM feed_posts WHERE id = ?")
    .bind(postId)
    .first();
  if (!post) return c.json({ ok: false, error: "Post not found." }, 404);

  const existing: any = await DB.prepare(
    "SELECT kind FROM post_reactions WHERE post_id = ? AND member_id = ?"
  )
    .bind(postId, userId)
    .first();
  const existingKind = existing ? normalizeReaction(existing.kind) : null;

  if (existingKind === kind) {
    // Same reaction again removes it - the calm way to take it back.
    await DB.prepare("DELETE FROM post_reactions WHERE post_id = ? AND member_id = ?")
      .bind(postId, userId)
      .run();
    return c.json({ ok: true, my_reaction: null });
  }

  // A block between the reactor and the post author forbids new or changed
  // reactions (403; the trg_post_reactions_block triggers enforce this too).
  const blocked: any = await DB.prepare(
    "SELECT 1 FROM block_pairs WHERE a = ? AND b = ? LIMIT 1"
  )
    .bind(userId, post.author_id)
    .first();
  if (blocked) {
    return c.json({ ok: false, error: "You cannot react to this post." }, 403);
  }

  // Members whose posting is paused (an active write ban) may not react
  // (403; trg_gate_post_reactions enforces this at the write gate too).
  const paused: any = await DB.prepare(
    "SELECT 1 FROM active_write_bans WHERE user_id = ? LIMIT 1"
  )
    .bind(userId)
    .first();
  if (paused) {
    return c.json({ ok: false, error: "Posting is paused for your account." }, 403);
  }

  // Upsert: one reaction per member per post; re-reacting changes it.
  try {
    await DB.prepare(
      `INSERT INTO post_reactions (post_id, member_id, kind, reacted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (post_id, member_id)
       DO UPDATE SET kind = excluded.kind, reacted_at = excluded.reacted_at`
    )
      .bind(postId, userId, kind, nowIso())
      .run();
  } catch (err) {
    // The triggers stay the final guard for the race between the checks
    // above and the write; map their errors to 403 instead of 500.
    const msg = err instanceof Error ? err.message : String(err);
    if (/blocked/.test(msg)) {
      return c.json({ ok: false, error: "You cannot react to this post." }, 403);
    }
    if (/posting is paused/.test(msg)) {
      return c.json({ ok: false, error: "Posting is paused for your account." }, 403);
    }
    throw err;
  }
  return c.json({ ok: true, my_reaction: kind });
});

/* --- Member: poll results (voter list only for public polls) --- */

app.get("/polls/:id/results", async (c) => {
  const userId = await needUser(c);
  if (!userId) return c.json({ ok: false, error: "Sign in required." }, 401);

  const { DB } = c.env;
  const pollId = c.req.param("id");

  const poll: any = await DB.prepare(
    "SELECT id, question, closes_at, show_voters FROM polls WHERE id = ?"
  )
    .bind(pollId)
    .first();
  if (!poll) return c.json({ ok: false, error: "Poll not found." }, 404);

  const options = await DB.prepare(
    `SELECT o.id, o.label, COUNT(v.id) AS votes
     FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
     WHERE o.poll_id = ? GROUP BY o.id ORDER BY o.position`
  )
    .bind(pollId)
    .all();

  const total = options.results.reduce((s: number, o: any) => s + Number(o.votes), 0);
  const result: any = {
    ok: true,
    id: poll.id,
    question: poll.question,
    closes_at: poll.closes_at,
    closed: closedOf(poll.closes_at),
    show_voters: poll.show_voters === 1,
    total_votes: total,
    options: options.results.map((o: any) => ({
      id: o.id,
      label: o.label,
      votes: Number(o.votes),
    })),
  };

  // Voter identities are private unless the poll author enabled show_voters.
  if (poll.show_voters === 1) {
    const voters = await DB.prepare(
      `SELECT v.option_id, v.voter_id, u.display_name, u.name, u.username, u.avatar_key, u.avatar_r2_key
       FROM poll_votes v JOIN users u ON u.id = v.voter_id
       WHERE v.poll_id = ? ORDER BY v.voted_at`
    )
      .bind(pollId)
      .all();
    result.voters = voters.results.map((v: any) => ({
      option_id: v.option_id,
      voter: publicAuthor(
        { id: v.voter_id, name: v.name, display_name: v.display_name, avatar_key: v.avatar_key, avatar_r2_key: v.avatar_r2_key },
        c
      ),
    }));
  }

  return c.json(result);
});

export default app;
