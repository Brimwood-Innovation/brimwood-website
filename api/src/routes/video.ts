/* R2 video serving with range-request support (T23).
 *
 * GET /api/video/:key → streams from R2 brimwood-media bucket.
 * Supports Range headers for seeking (206 Partial Content).
 * Access control: preview lessons' videos are public; members-only
 * lessons' videos require a session (checked via lesson lookup).
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();
const COOKIE = "brimwood_sess";

async function sessionUser(c: any): Promise<{ id: string; role: string } | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const raw = await c.env.SESSIONS_KV.get("sess:" + token);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s.userId ? { id: s.userId, role: s.role } : null;
  } catch {
    return null;
  }
}

app.get("/:key", async (c) => {
  const { DB, MEDIA } = c.env;
  const key = c.req.param("key");

  // Basic key sanity: no path traversal, reasonable charset.
  if (!key || !/^[a-zA-Z0-9._\-\/]+$/.test(key) || key.includes("..")) {
    return c.json({ ok: false, error: "Not found" }, 404);
  }

  // Find which lesson (if any) uses this video key, to enforce access.
  const lesson = await DB.prepare(
    `SELECT l.is_preview, m.course_id FROM lessons l
     JOIN modules m ON m.id = l.module_id
     WHERE l.video_r2_key = ? AND l.status = 'published' LIMIT 1`
  )
    .bind(key)
    .first<{ is_preview: number; course_id: string }>();

  if (lesson && !lesson.is_preview) {
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
  // No lesson references this key → 404 (don't leak bucket contents).
  if (!lesson) return c.json({ ok: false, error: "Not found" }, 404);

  // Range support for seeking.
  const range = c.req.header("range");
  let r2Obj;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      r2Obj = end !== undefined
        ? await MEDIA.get(key, { range: { offset: start, length: end - start + 1 } })
        : await MEDIA.get(key, { range: { offset: start } });
    } else {
      r2Obj = await MEDIA.get(key);
    }
  } else {
    r2Obj = await MEDIA.get(key);
  }

  if (!r2Obj) return c.json({ ok: false, error: "Not found" }, 404);

  const headers = new Headers();
  r2Obj.writeHttpMetadata(headers);
  headers.set("etag", r2Obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  // Cache videos at the edge for an hour (immutable content; keys are versioned).
  headers.set("cache-control", "public, max-age=3600");

  if (range && r2Obj.range && "offset" in r2Obj.range && r2Obj.range.offset !== undefined) {
    const total = r2Obj.size;
    const start: number = r2Obj.range.offset;
    const len: number = r2Obj.range.length ?? total - start;
    const end = start + len - 1;
    headers.set("content-range", `bytes ${start}-${end}/${total}`);
    headers.set("content-length", String(len));
    return new Response(r2Obj.body, { status: 206, headers });
  }

  return new Response(r2Obj.body, { headers });
});

export default app;
