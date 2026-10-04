/* Academy course/lesson reads (T21).
 *
 * GET /api/courses                     → published courses (public)
 * GET /api/courses/:slug               → course + modules + lesson list (public;
 *                                         lesson bodies gated — previews show excerpt)
 * GET /api/lessons/:id                 → full lesson; preview lessons are public,
 *                                         full lessons require a session
 */
import { Hono } from "hono";
import { readSession } from "../lib/auth";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();


/** Return the session's user, or null. */
async function sessionUser(c: any): Promise<{ id: string; role: string } | null> {
  const s = await readSession(c);
  return s && s.userId ? { id: s.userId, role: s.role } : null;
}

/** List published courses. Public. */
app.get("/", async (c) => {
  const { DB } = c.env;
  const courses = await DB.prepare(
    `SELECT slug, title, tagline, level, visibility, sort_order
     FROM courses WHERE status = 'published' ORDER BY sort_order, title`
  ).all();
  return c.json({ ok: true, courses: courses.results });
});

/** Course detail with modules and lesson index. Public; bodies are gated per-lesson. */
app.get("/:slug", async (c) => {
  const { DB } = c.env;
  const slug = c.req.param("slug");
  const course = await DB.prepare(
    `SELECT id, slug, title, tagline, description_md, level, visibility
     FROM courses WHERE slug = ? AND status = 'published'`
  )
    .bind(slug)
    .first();
  if (!course) return c.json({ ok: false, error: "Not found" }, 404);

  const modules = await DB.prepare(
    `SELECT id, title, sort_order FROM modules WHERE course_id = ? ORDER BY sort_order`
  )
    .bind((course as any).id)
    .all();

  const out: any[] = [];
  for (const m of (modules.results as any[])) {
    const lessons = await DB.prepare(
      `SELECT id, slug, title, duration_minutes, is_preview, sort_order
       FROM lessons WHERE module_id = ? AND status = 'published' ORDER BY sort_order`
    )
      .bind(m.id)
      .all();
    out.push({ ...m, lessons: lessons.results });
  }

  return c.json({ ok: true, course, modules: out });
});

/** Single lesson. Preview lessons are public; full lessons need a session. */
app.get("/lessons/:id", async (c) => {
  const { DB } = c.env;
  const id = c.req.param("id");
  const lesson = await DB.prepare(
    `SELECT l.id, l.slug, l.title, l.body_md, l.body_html, l.video_r2_key,
            l.duration_minutes, l.is_preview, l.sort_order,
            m.course_id, co.slug AS course_slug, co.title AS course_title
     FROM lessons l
     JOIN modules m ON m.id = l.module_id
     JOIN courses co ON co.id = m.course_id
     WHERE l.id = ? AND l.status = 'published' AND co.status = 'published'`
  )
    .bind(id)
    .first<any>();
  if (!lesson) return c.json({ ok: false, error: "Not found" }, 404);

  if (!lesson.is_preview) {
    const user = await sessionUser(c);
    if (!user) return c.json({ ok: false, error: "Members only" }, 401);
    // Members-only course: must be enrolled (or admin).
    if (user.role !== "admin") {
      const enr = await DB.prepare(
        "SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?"
      )
        .bind(user.id, lesson.course_id)
        .first();
      if (!enr) return c.json({ ok: false, error: "Enrolment required" }, 403);
    }
  }

  return c.json({ ok: true, lesson });
});

export default app;
