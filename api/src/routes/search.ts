/* Site search (Phase B): public search across published blog posts and
 * preview academy lessons.
 *
 * GET /api/search?q= → { ok: true, results: [{ type, title, excerpt, url }] }
 *
 * Notes and limits:
 * - No auth required. Rate-limited per IP (30/min).
 * - Lessons: only preview lessons are searchable — members-only lesson
 *   titles/bodies are never exposed to anonymous search.
 * - CMS pages (site/src/content/pages/) are NOT covered: they live as
 *   Markdown files, not in D1. They will be included once pages are
 *   synced to D1.
 * - Matching is substring LIKE (case-insensitive in D1/SQLite by default
 *   for ASCII). Min query 2 chars, max 100.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

const app = new Hono<{ Bindings: Bindings }>();

const MIN_LEN = 2;
const MAX_LEN = 100;
const LIMIT = 10;

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

  const results: { type: "post" | "lesson"; title: string; excerpt: string; url: string }[] = [];

  // Blog posts (published only).
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

  // Academy lessons: preview-only so members-only content never leaks.
  const lessons = await DB.prepare(
    `SELECT l.id, l.title, l.body_md, co.slug AS course_slug
     FROM lessons l
     JOIN modules m ON m.id = l.module_id
     JOIN courses co ON co.id = m.course_id
     WHERE l.status = 'published' AND l.is_preview = 1 AND co.status = 'published'
       AND (l.title LIKE ? ESCAPE '\\' OR l.body_md LIKE ? ESCAPE '\\')
     ORDER BY l.title LIMIT ?`
  )
    .bind(like, like, LIMIT)
    .all();
  for (const l of ((lessons.results as any[]) || [])) {
    results.push({
      type: "lesson",
      title: l.title,
      excerpt: excerptOf(l.body_md),
      url: "/academy/" + l.course_slug + "/" + l.id,
    });
  }

  return c.json({ ok: true, results: results.slice(0, LIMIT * 2) });
});

export default app;
