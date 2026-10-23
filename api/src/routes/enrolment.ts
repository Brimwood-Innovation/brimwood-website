/* Enrolment + lesson progress (T22).
 *
 * POST /api/enrol/:courseSlug          → enrol the signed-in user (idempotent)
 * POST /api/progress/:lessonId        → mark lesson complete
 * GET  /api/progress                  → my enrolments + progress summary
 * GET  /api/progress/detail           → completed lesson IDs (drives checkmarks)
 */
import { Hono } from "hono";
import { readSession } from "../lib/auth";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();

type AuthedUser = { id: string; role: string };

/** Single session lookup per request (was: two D1 reads via requireAuth + sessionUser). */
async function authUser(c: any): Promise<AuthedUser | null> {
  const s = await readSession(c);
  return s && s.userId ? { id: s.userId, role: s.role } : null;
}

/** Enrol in a course. Idempotent (INSERT OR IGNORE on UNIQUE(user_id, course_id)). */
app.post("/enrol/:courseSlug", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ ok: false, error: "Sign in required" }, 401);
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

/** Mark a lesson complete. D6: a lesson is complete only when the member
 *  submits a reflection (private by default). The reflection is inserted
 *  first, in one batch with the progress upsert, so the
 *  trg_lesson_progress_needs_reflection trigger always sees it. */
app.post("/progress/:lessonId", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ ok: false, error: "Sign in required" }, 401);
  const { DB } = c.env;
  const lessonId = c.req.param("lessonId");

  // Verify the lesson exists, is published, AND its course is published;
  // matches the gating on GET /api/courses/lessons/:id (no completing
  // lessons from draft courses).
  const lesson = await DB.prepare(
    `SELECT l.id, m.course_id FROM lessons l
     JOIN modules m ON m.id = l.module_id
     JOIN courses co ON co.id = m.course_id
     WHERE l.id = ? AND l.status = 'published' AND co.status = 'published'`
  )
    .bind(lessonId)
    .first<{ id: string; course_id: string }>();
  if (!lesson) return c.json({ ok: false, error: "Not found" }, 404);

  // Parse the reflection. Re-completing a lesson with an existing reflection
  // needs no new text; sending one edits it (editing keeps the row).
  let reflection: string | null = null;
  try {
    const body = (await c.req.json()) as any;
    if (typeof body?.reflection === "string") reflection = body.reflection.trim();
  } catch {
    /* no JSON body */
  }
  if (reflection !== null && (reflection.length < 20 || reflection.length > 2000)) {
    return c.json(
      { ok: false, error: "A reflection of 20 to 2000 characters is required" },
      400
    );
  }

  const existing = await DB.prepare(
    "SELECT id FROM lesson_reflections WHERE user_id = ? AND lesson_id = ?"
  )
    .bind(user.id, lessonId)
    .first<{ id: string }>();
  if (!existing && reflection === null) {
    return c.json(
      {
        ok: false,
        error:
          "Submit a reflection (20 to 2000 characters) to complete a lesson",
      },
      400
    );
  }

  // Auto-enrol if not already (members can access previews; enrol to track).
  await DB.prepare(
    "INSERT OR IGNORE INTO enrollments (id, user_id, course_id) VALUES (?, ?, ?)"
  )
    .bind(crypto.randomUUID(), user.id, lesson.course_id)
    .run();

  // Reflection first, then the progress upsert, in one batch.
  const stmts = [];
  if (reflection !== null) {
    stmts.push(
      DB.prepare(
        `INSERT INTO lesson_reflections (id, user_id, lesson_id, body)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, lesson_id) DO UPDATE SET
           body = excluded.body,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).bind(crypto.randomUUID(), user.id, lessonId, reflection)
    );
  }
  stmts.push(
    DB.prepare(
      `INSERT INTO lesson_progress (id, user_id, lesson_id, status, completed_at)
       VALUES (?, ?, ?, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(user_id, lesson_id) DO UPDATE SET status='completed', completed_at=excluded.completed_at`
    ).bind(crypto.randomUUID(), user.id, lessonId)
  );
  await DB.batch(stmts);

  return c.json({ ok: true });
});

/** Completed lesson IDs for the signed-in user (drives checkmarks). */
app.get("/progress/detail", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ ok: false, error: "Sign in required" }, 401);
  const { DB } = c.env;
  const rows = await DB.prepare(
    "SELECT lesson_id FROM lesson_progress WHERE user_id = ? AND status = 'completed'"
  )
    .bind(user.id)
    .all();
  return c.json({ ok: true, done: (rows.results as any[]).map((r) => r.lesson_id) });
});

/** My enrolments + progress. done_lessons counts completed rows for lessons
 *  that are still published; `completed` is derived (enrollments.completed_at
 *  is never written, so the flag is computed, not read). */
app.get("/progress", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ ok: false, error: "Sign in required" }, 401);
  const { DB } = c.env;

  const enrolments = await DB.prepare(
    `SELECT e.course_id, co.slug, co.title, e.enrolled_at, e.completed_at,
            (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id
             WHERE m.course_id = e.course_id AND l.status = 'published') AS total_lessons,
            (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
             JOIN modules m ON m.id = l.module_id
             WHERE lp.user_id = e.user_id AND m.course_id = e.course_id
               AND lp.status = 'completed' AND l.status = 'published') AS done_lessons
     FROM enrollments e JOIN courses co ON co.id = e.course_id
     WHERE e.user_id = ? AND co.status = 'published'`
  )
    .bind(user.id)
    .all();

  const rows = (enrolments.results as any[]).map((e) => ({
    ...e,
    completed: e.total_lessons > 0 && e.done_lessons >= e.total_lessons,
  }));
  return c.json({ ok: true, enrolments: rows });
});

export default app;
