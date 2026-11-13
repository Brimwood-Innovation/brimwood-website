/* Site search (Phase 1 item 15): query search_documents (0036) with the
 * read rules, plus published blog posts.
 *
 * GET /api/search?q= → { ok: true, results: [{ type, title, excerpt, url }] }
 *
 * Read rules (0036 header, S12): visibility, group membership and
 * block_pairs are applied to every search_documents result.
 * - Anonymous: only visibility = 'public' rows.
 * - Signed-in member: visibility in ('public', 'members'), grouped rows
 *   only when the viewer is an active member of that group, and rows by an
 *   author on either side of a block are excluded (block_pairs is the
 *   both-ways view from 0025).
 * - Feed posts with audience 'only_me' never reach search_documents: the
 *   0036 trigger only indexes published, not deleted, non-only_me posts.
 * - People search is not part of this route: per the 0036 header it reads
 *   member_profiles and users directly, only for directory_opt_in = 1.
 *
 * Notes and limits:
 * - Auth is optional. Rate-limited per IP (30/min).
 * - Blog posts are NOT in search_documents (that table indexes feed posts,
 *   events, pages, courses and lessons), so the posts query stays.
 * - Matching is substring LIKE (case-insensitive in D1/SQLite by default
 *   for ASCII). Min query 2 chars, max 100.
 * - A document whose source row no longer resolves to a slug is skipped
 *   rather than linked to a dead URL.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { getUserId } from "../lib/auth";

const app = new Hono<{ Bindings: Bindings }>();

const MIN_LEN = 2;
const MAX_LEN = 100;
const LIMIT = 10;
const DOC_LIMIT = 20;

type SearchResult = {
  type: "post" | "feed_post" | "event" | "page" | "course" | "lesson";
  title: string;
  excerpt: string;
  url: string;
};

type DocRow = {
  doc_type: string;
  doc_id: string;
  title: string;
  body: string;
  visibility: string;
  group_id: string | null;
  author_id: string | null;
};

/** Escape LIKE wildcards so the query is matched literally. */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Plain-text excerpt from markdown-ish body. */
function excerptOf(body: string, max = 160): string {
  const plain = (body || "")
    .replace(/[#>*`\[\]()_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

/** Resolve ids to slugs with one IN query; returns id -> slug. */
async function slugMap(
  DB: D1Database,
  sql: string,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await DB.prepare(sql.replace("/*IDS*/", placeholders))
    .bind(...ids)
    .all();
  for (const r of ((rows.results as any[]) || [])) {
    const slug = r.slug || r.course_slug;
    if (r.id && slug) out.set(r.id, slug);
  }
  return out;
}

app.get("/", async (c) => {
  const { DB } = c.env;

  if (!(await checkRateLimitD1(DB, "search:" + clientIp(c.req.raw), 30, 60))) {
    return c.json({ ok: false, error: "Too many requests. Please try again shortly." }, 429);
  }

  const raw = (c.req.query("q") || "").trim();
  if (raw.length < MIN_LEN) {
    return c.json({ ok: true, results: [] });
  }
  const q = raw.slice(0, MAX_LEN);
  const like = "%" + escapeLike(q) + "%";

  // Optional auth: anonymous search is public-only, member search applies
  // the full read rules. A missing or invalid session just means anonymous.
  const viewerId = await getUserId(c);

  const results: SearchResult[] = [];

  // Blog posts (published only). Posts are not indexed in search_documents.
  const posts = await DB.prepare(
    `SELECT slug, title, excerpt FROM posts
     WHERE status = 'published'
       AND (title LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR body_md LIKE ? ESCAPE '\\')
     ORDER BY published_at DESC LIMIT ?`
  )
    .bind(like, like, like, LIMIT)
    .all();
  for (const p of ((posts.results as any[]) || [])) {
    results.push({
      type: "post",
      title: p.title,
      excerpt: p.excerpt || "",
      url: "/blog/" + p.slug,
    });
  }

  // search_documents with the read rules (Phase 1 item 15).
  let docs: DocRow[];
  if (viewerId) {
    const rows = await DB.prepare(
      `SELECT doc_type, doc_id, title, body, visibility, group_id, author_id
       FROM search_documents
       WHERE visibility IN ('public', 'members')
         AND (group_id IS NULL OR EXISTS (
           SELECT 1 FROM group_members gm
           WHERE gm.group_id = search_documents.group_id
             AND gm.user_id = ? AND gm.state = 'active'))
         AND (author_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM block_pairs
           WHERE a = ? AND b = search_documents.author_id))
         AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
       ORDER BY updated_at DESC LIMIT ?`
    )
      .bind(viewerId, viewerId, like, like, DOC_LIMIT)
      .all();
    docs = ((rows.results as any[]) || []) as DocRow[];
  } else {
    const rows = await DB.prepare(
      `SELECT doc_type, doc_id, title, body, visibility, group_id, author_id
       FROM search_documents
       WHERE visibility = 'public'
         AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
       ORDER BY updated_at DESC LIMIT ?`
    )
      .bind(like, like, DOC_LIMIT)
      .all();
    docs = ((rows.results as any[]) || []) as DocRow[];
  }

  // Resolve slugs for the document types that link by slug. One query per
  // type, each filtered to published sources so a stale index row never
  // links to an unpublished or deleted source.
  const idsByType = (type: string): string[] =>
    docs.filter((d) => d.doc_type === type).map((d) => d.doc_id);
  const eventSlugs = await slugMap(
    DB,
    `SELECT id, slug FROM events WHERE id IN (/*IDS*/) AND status = 'published'`,
    idsByType("event")
  );
  const pageSlugs = await slugMap(
    DB,
    `SELECT id, slug FROM pages WHERE id IN (/*IDS*/) AND status = 'published' AND trashed_at IS NULL AND noindex = 0`,
    idsByType("page")
  );
  const courseSlugs = await slugMap(
    DB,
    `SELECT id, slug FROM courses WHERE id IN (/*IDS*/) AND status = 'published'`,
    idsByType("course")
  );
  const lessonSlugs = await slugMap(
    DB,
    `SELECT l.id, co.slug AS course_slug FROM lessons l
     JOIN modules m ON m.id = l.module_id
     JOIN courses co ON co.id = m.course_id
     WHERE l.id IN (/*IDS*/) AND l.status = 'published' AND co.status = 'published'`,
    idsByType("lesson")
  );

  for (const d of docs) {
    if (d.doc_type === "feed_post") {
      // Feed posts carry no title in search_documents; the post text is
      // the title line, and there is no separate excerpt.
      results.push({
        type: "feed_post",
        title: excerptOf(d.body, 80) || "Feed post",
        excerpt: "",
        url: "/hub/post/?id=" + encodeURIComponent(d.doc_id),
      });
      continue;
    }
    let slug: string | undefined;
    let url: string | null = null;
    if (d.doc_type === "event") {
      slug = eventSlugs.get(d.doc_id);
      if (slug) url = "/events/" + slug;
    } else if (d.doc_type === "page") {
      slug = pageSlugs.get(d.doc_id);
      if (slug) url = "/" + slug;
    } else if (d.doc_type === "course") {
      slug = courseSlugs.get(d.doc_id);
      if (slug) url = "/academy/" + slug;
    } else if (d.doc_type === "lesson") {
      slug = lessonSlugs.get(d.doc_id);
      if (slug) url = "/academy/" + slug + "/" + d.doc_id;
    } else {
      // Unknown doc_type: the CHECK in 0036 forbids it, but never link
      // a type this route does not know how to render.
      continue;
    }
    if (!url) continue;
    results.push({
      type: d.doc_type as SearchResult["type"],
      title: d.title,
      excerpt: excerptOf(d.body),
      url,
    });
  }

  return c.json({ ok: true, results: results.slice(0, LIMIT * 2) });
});

export default app;
