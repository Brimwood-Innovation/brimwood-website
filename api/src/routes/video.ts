/* R2 video serving with range-request support (T23).
 *
 * GET /api/video/:key → streams from R2 brimwood-media bucket.
 * Supports Range headers for seeking (206 Partial Content); unsatisfiable or
 * malformed ranges → 416 with `Content-Range: bytes * /<size>` (RFC 9110 §14).
 * Access control: preview lessons' videos (and visibility='public' courses'
 * videos) are public; members-only lessons' videos require a session +
 * enrolment, checked per request against the lesson that owns the key, so the
 * URL cannot be hotlinked by non-members.
 * Caching: gated responses use `Cache-Control: private` — the shared edge
 * cache never varies on Cookie, so `public` here would leak members-only bytes
 * to anonymous users. Preview videos are immutable content → `public`.
 */
import { Hono } from "hono";
import { readSession } from "../lib/auth";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();

async function sessionUser(c: any): Promise<{ id: string; role: string } | null> {
  const s = await readSession(c);
  return s && s.userId ? { id: s.userId, role: s.role } : null;
}

/** Strict single-range parse. Returns null for anything unsatisfiable,
 *  malformed, or multi-range (we don't do multipart/byteranges). */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  // bytes=N- or bytes=N-M
  let m = header.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = m[2] === "" ? size - 1 : parseInt(m[2], 10);
    if (start >= size || end < start) return null;
    return { start, end: Math.min(end, size - 1) };
  }
  // bytes=-S (suffix: last S bytes)
  m = header.match(/^bytes=-(\d+)$/);
  if (m) {
    const suffix = parseInt(m[1], 10);
    if (suffix === 0 || size === 0) return null;
    const len = Math.min(suffix, size);
    return { start: size - len, end: size - 1 };
  }
  return null;
}

app.get("/:key{.+}", async (c) => {
  const { DB, MEDIA } = c.env;
  const key = c.req.param("key");

  // Basic key sanity: no path traversal, reasonable charset.
  if (!key || !/^[a-zA-Z0-9._\-\/]+$/.test(key) || key.includes("..")) {
    return c.json({ ok: false, error: "Not found" }, 404);
  }

  // Find which lesson (if any) uses this video key, to enforce access.
  // Course must be published — matches GET /api/courses/lessons/:id.
  const lesson = await DB.prepare(
    `SELECT l.is_preview, m.course_id, co.visibility AS course_visibility
     FROM lessons l
     JOIN modules m ON m.id = l.module_id
     JOIN courses co ON co.id = m.course_id
     WHERE l.video_r2_key = ? AND l.status = 'published'
       AND co.status = 'published' LIMIT 1`
  )
    .bind(key)
    .first<{ is_preview: number; course_id: string; course_visibility: string }>();

  // No lesson references this key → 404 (don't leak bucket contents).
  if (!lesson) return c.json({ ok: false, error: "Not found" }, 404);

  // visibility='public' courses are fully open; otherwise non-preview lessons
  // need a session + enrolment (admins bypass the enrolment check).
  const gated = !lesson.is_preview && lesson.course_visibility !== "public";
  if (gated) {
    const user = await sessionUser(c);
    if (!user) return c.json({ ok: false, error: "Members only" }, 401);
    if (user.role !== "admin") {
      const enr = await DB.prepare(
        "SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?"
      )
        .bind(user.id, lesson.course_id)
        .first();
      if (!enr) return c.json({ ok: false, error: "Enrolment required" }, 403);
    }
  }

  // Size first (HEAD = no body), so ranges can be validated before the GET.
  const head = await MEDIA.head(key);
  if (!head) return c.json({ ok: false, error: "Not found" }, 404);
  const size = head.size;

  const rangeHeader = c.req.header("range");
  let range: { start: number; end: number } | null = null;
  if (rangeHeader) {
    range = parseRange(rangeHeader.trim(), size);
    if (!range) {
      return c.json({ ok: false, error: "Range not satisfiable" }, 416, {
        "content-range": `bytes */${size}`,
      });
    }
  }

  const r2Obj = range
    ? await MEDIA.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } })
    : await MEDIA.get(key);
  if (!r2Obj) return c.json({ ok: false, error: "Not found" }, 404);

  const headers = new Headers();
  r2Obj.writeHttpMetadata(headers);
  headers.set("etag", r2Obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  // Gated video must never sit in the shared edge cache (no cookie variation
  // on the cache key) → private. Preview video is immutable → public.
  headers.set("cache-control", gated ? "private, max-age=3600" : "public, max-age=3600");

  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(r2Obj.body, { status: 206, headers });
  }

  return new Response(r2Obj.body, { headers });
});

export default app;
