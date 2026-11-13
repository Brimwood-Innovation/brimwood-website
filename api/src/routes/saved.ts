/* Member saved posts (Phase 3 slice 10, deck section 07 Saved place).
 *
 * Mounted at "/api/saved". Every route is behind requireUser
 * (members only); a signed-out visitor gets 401, never a partial list.
 *
 * The table already exists: saved_posts from migration 0026, private
 * to the member, one row per (user_id, post_id), with a free-text
 * collection (1 to 40 chars, default 'Saved'). No migration in this
 * slice, and no collections table: a collection exists only because
 * at least one saved post names it, so the list response derives the
 * collection chips from the visible saved rows.
 *
 * Visibility, element by element (the same rule as the feed reads):
 *   - The saved post must still be published and not deleted. A post
 *     its author deleted, or staff unpublished, silently drops out of
 *     the list; the save row stays, so it returns if the post does.
 *   - Audience: members posts, the caller's own only_me posts, or
 *     group posts for groups the caller actively belongs to. A post
 *     saved while the caller belonged to a group drops out after they
 *     leave it, exactly as the feed hides it.
 *   - Neither side of a block appears: block_pairs is the both-ways
 *     view from 0025, so one NOT EXISTS covers both directions. Saving
 *     a post the viewer cannot see is a 404, the same answer the feed
 *     detail gives for an invisible post, never a leak about the post.
 *   - Saving is an upsert: saving a post already saved moves it to
 *     the given collection and refreshes saved_at, so the moved post
 *     surfaces at the top of the list. Unsaving is idempotent: removing
 *     a post that is not saved still answers ok.
 *   - Nothing about another member's saves ever leaves this route:
 *     every query is keyed on the caller's id, and no other member's
 *     saved list, count, or collections are readable.
 *
 * Not in this slice: creating a named collection without a post in
 * it. Collections are born when a post is saved into them, so the
 * saved page offers "New collection" on a post's move menu instead of
 * an empty-collection form.
 */
import { Hono } from "hono";
import { requireUser, type Session } from "../lib/auth";
import type { Bindings } from "../index";
import { cleanStr } from "../lib/validate";
import { avatarUrlOf, initialsFor } from "./profiles";

const app = new Hono<{ Bindings: Bindings; Variables: { user: Session } }>();

app.use(requireUser);

const DEFAULT_COLLECTION = "Saved";
const MAX_COLLECTION_LEN = 40;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/* Same visibility rule as the feed reads (routes/feed.ts): published,
 * not deleted, audience the viewer may see, neither side blocked.
 * Binds the viewer id three times, after any earlier binds. */
const POST_VISIBLE = `
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

interface SavedRow {
  post_id: string;
  collection: string;
  saved_at: string;
  id: string;
  body: string;
  intent: string | null;
  audience: string | null;
  group_id: string | null;
  created_at: string;
  author_id: string;
  author_name: string | null;
  display_name: string | null;
  author_username: string | null;
  avatar_key: string | null;
  avatar_r2_key: string | null;
  author_role: string | null;
  group_name: string | null;
  group_slug: string | null;
}

function savedItem(row: SavedRow) {
  const username = row.author_username || null;
  return {
    post_id: row.post_id,
    collection: row.collection,
    saved_at: row.saved_at,
    post: {
      id: row.id,
      body: row.body,
      intent: row.intent || "progress",
      audience: row.audience || "members",
      group: row.group_id
        ? { id: row.group_id, name: row.group_name || "", slug: row.group_slug || "" }
        : null,
      created_at: row.created_at,
      author: {
        id: row.author_id,
        display: row.display_name || initialsFor(row.author_name || ""),
        username,
        profile_url: username ? `/@${username}` : `/u/${row.author_id}`,
        avatar_url: avatarUrlOf(row),
        is_staff: row.author_role === "admin",
      },
    },
  };
}

/** Collection chips derived from the visible saved rows, with counts. */
function collectionsOf(items: ReturnType<typeof savedItem>[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.collection, (counts.get(item.collection) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([collection, count]) => ({ collection, count }))
    .sort((a, b) => a.collection.localeCompare(b.collection, "en-CA"));
}

app.get("/", async (c) => {
  const { DB } = c.env;
  const viewerId = c.get("user").userId as string;
  const collection = cleanStr(c.req.query("collection"), MAX_COLLECTION_LEN);
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const rows = (
    await DB.prepare(
      `SELECT sp.post_id, sp.collection, sp.saved_at,
              p.id, p.body, p.intent, p.audience, p.group_id, p.created_at,
              u.id AS author_id, u.name AS author_name, u.display_name,
              u.username AS author_username, u.avatar_key, u.avatar_r2_key,
              u.role AS author_role,
              g.name AS group_name, g.slug AS group_slug
       FROM saved_posts sp
       JOIN feed_posts p ON p.id = sp.post_id
       JOIN users u ON u.id = p.author_id
       LEFT JOIN groups g ON g.id = p.group_id
       WHERE sp.user_id = ?${POST_VISIBLE}
       ORDER BY sp.saved_at DESC LIMIT ?`,
    )
      .bind(viewerId, viewerId, viewerId, viewerId, limit)
      .all()
  ).results as unknown as SavedRow[];

  const items = (rows || []).map(savedItem);
  const collections = collectionsOf(items);
  const saved = collection ? items.filter((i) => i.collection === collection) : items;
  return c.json({ ok: true, saved, collections });
});

app.post("/", async (c) => {
  const { DB } = c.env;
  const viewerId = c.get("user").userId as string;
  let data: any = {};
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Send a post to save." }, 400);
  }
  const postId = cleanStr(data?.post_id, 40);
  if (!postId) {
    return c.json({ ok: false, error: "Send a post to save." }, 400);
  }
  const collection = cleanStr(data?.collection, MAX_COLLECTION_LEN) || DEFAULT_COLLECTION;

  const visible = await DB.prepare(
    `SELECT p.id FROM feed_posts p WHERE p.id = ?${POST_VISIBLE}`,
  )
    .bind(postId, viewerId, viewerId, viewerId)
    .first()
    .catch(() => null);
  if (!visible) {
    return c.json({ ok: false, error: "Not found." }, 404);
  }

  await DB.prepare(
    `INSERT INTO saved_posts (user_id, post_id, collection, saved_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id, post_id) DO UPDATE
       SET collection = excluded.collection,
           saved_at = excluded.saved_at`,
  )
    .bind(viewerId, postId, collection)
    .run();
  return c.json({ ok: true, saved: true, post_id: postId, collection });
});

app.delete("/:postId", async (c) => {
  const { DB } = c.env;
  const viewerId = c.get("user").userId as string;
  const postId = (c.req.param("postId") || "").slice(0, 40);
  if (!postId) {
    return c.json({ ok: false, error: "Send a post to remove." }, 400);
  }
  await DB.prepare("DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?")
    .bind(viewerId, postId)
    .run();
  return c.json({ ok: true, saved: false, post_id: postId });
});

export default app;
