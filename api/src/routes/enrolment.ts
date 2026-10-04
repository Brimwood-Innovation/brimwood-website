/* Enrolment + lesson progress (T22).
 *
 * POST /api/enrol/:courseSlug          → enrol the signed-in user (idempotent)
 * POST /api/progress/:lessonId        → mark lesson complete
 * GET  /api/progress                  → my enrolments + progress summary
 */
import { Hono } from "hono";
import { readSession } from "../lib/auth";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();

async function sessionUser(c: any): Promise<{ id: string; role: string } | null> {
  const s = await readSession(c);
  return s && s.userId ? { id: s.userId, role: s.role } : null;
}

function requireAuth(c: any) {
  return sessionUser(c).then((u) => {
    if (!u) return c.json({ ok: false, error: "Sign in required" }, 401);
    return null;
  });
}

/** Enrol in a course. Idempotent. */
app.post("/enrol/:courseSlug", async (c) => {
  const no = await requireAuth(c);
  if (no) return no;
  const user = (await sessionUser(c))!;
  const { DB } = c.env;
  const slug = c.req.param("courseSlug");

  const course = await DB.prepare(
    "SELECT id FROM courses WHERE slug = ? AND status = 'published'"
  )
    .bind(slug)
    .first<{ id: string }>();
  if (!course) return c.json({ ok: false, error: "Not found" }, 404);

  await DB.prepare(
    "INSERT OR IGNORE INTO enrollments (id, user_id, course_id) VALUES (?, ?, ?)"
  )
    .bind(crypto.randomUUID(), user.id, course.id)
    .run();

  return c.json({ ok: true });
});

/** Mark a lesson complete. */
app.post("/progress/:lessonId", async (c) => {
  const no = await requireAuth(c);
  if (no) return no;
  const user = (await sessionUser(c))!;
  const { DB } = c.env;
  const lessonId = c.req.param("lessonId");

  // Verify the lesson exists and the user can access it.
  const lesson = await DB.prepare(
    `SELECT l.id, m.course_id FROM lessons l
     JOIN modules m ON m.id = l.module_id
     WHERE l.id = ? AND l.status = 'published'`
  )
    .bind(lessonId)
    .first<{ id: string; course_id: string }>();
  if (!lesson) return c.json({ ok: false, error: "Not found" }, 404);

  // Auto-enrol if not already (members can access previews; enrol to track).
  await DB.prepare(
    "INSERT OR IGNORE INTO enrollments (id, user_id, course_id) VALUES (?, ?, ?)"
  )
    .bind(crypto.randomUUID(), user.id, lesson.course_id)
    .run();

  await DB.prepare(
    `INSERT INTO lesson_progress (id, user_id, lesson_id, status, completed_at)
     VALUES (?, ?, ?, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id, lesson_id) DO UPDATE SET status='completed', completed_at=excluded.completed_at`
  )
    .bind(crypto.randomUUID(), user.id, lessonId)
    .run();

  return c.json({ ok: true });
});

/** Completed lesson IDs for the signed-in user (drives checkmarks). */
app.get("/progress/detail", async (c) => {
  const no = await requireAuth(c);
  if (no) return no;
  const user = (await sessionUser(c))!;
  const { DB } = c.env;
  const rows = await DB.prepare(
    "SELECT lesson_id FROM lesson_progress WHERE user_id = ? AND status = 'completed'"
  )
    .bind(user.id)
    .all();
  return c.json({ ok: true, done: (rows.results as any[]).map((r) => r.lesson_id) });
});

/** My enrolments + progress. */
app.get("/progress", async (c) => {
  const no = await requireAuth(c);
  if (no) return no;
  const user = (await sessionUser(c))!;
  const { DB } = c.env;

  const enrolments = await DB.prepare(
    `SELECT e.course_id, co.slug, co.title, e.enrolled_at, e.completed_at,
            (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id
             WHERE m.course_id = e.course_id AND l.status = 'published') AS total_lessons,
            (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
             JOIN modules m ON m.id = l.module_id
             WHERE lp.user_id = e.user_id AND m.course_id = e.course_id) AS done_lessons
     FROM enrollments e JOIN courses co ON co.id = e.course_id
     WHERE e.user_id = ?`
  )
    .bind(user.id)
    .all();

  return c.json({ ok: true, enrolments: enrolments.results });
});

export default app;
