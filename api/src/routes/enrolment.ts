/* Enrolment + lesson progress (T22, Phase 4 slice 2).
 *
 * POST /api/enrol/:courseSlug          → enrol the signed-in user (idempotent)
 * POST /api/progress/:lessonId        → mark lesson complete; when that
 *                                      lesson is the last reflected-complete
 *                                      lesson of its course, the enrolment
 *                                      completes and a certificate is issued
 *                                      automatically (see below)
 * GET  /api/progress                  → my enrolments + progress summary
 * GET  /api/progress/detail           → completed lesson IDs (drives checkmarks)
 *
 * Reflection-gated completion (D6, Phase 4 slice 2): a course is complete
 * only when every still-published lesson has a completed progress row AND
 * a reflection row. Progress rows written before 0031 can be completed
 * without a reflection, so the count here joins reflections; the trigger
 * already stops new reflection-less completions. On completion the
 * enrolment's completed_at is stamped (the column Phase 1 never wrote,
 * which is why manual certificate issue could never succeed on a
 * reflection-only completion), and the shared issuance path in
 * api/src/lib/certificates.ts issues one certificate with
 * issue_source 'auto'. Course hours are the published lessons'
 * duration_minutes total, at least 1 hour when a course records no
 * durations, capped at the 0031 limit of 500. If signing is not
 * configured, or signing fails, the lesson still completes and the
 * enrolment still stamps: the response reports certificate_pending,
 * the admin manual issue remains available, and re-completing any
 * lesson in the course retries the automatic issue. Issuance never
 * blocks learning, and it never leaks a lesson or a reflection.
 */
import { Hono } from "hono";
import { issueCertificate } from "../lib/certificates";
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

  /* Reflection-gated course completion, then automatic issue. */
  let courseCompleted = false;
  let certificate: { code: string; verify_url: string } | null = null;
  let certificatePending = false;
  try {
    const enrolment: any = await DB.prepare(
      "SELECT id, completed_at FROM enrollments WHERE user_id = ? AND course_id = ?",
    )
      .bind(user.id, lesson.course_id)
      .first();
    if (enrolment) {
      const totals: any = await DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id
            WHERE m.course_id = ? AND l.status = 'published') AS total_lessons,
           (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
            JOIN modules m ON m.id = l.module_id
            WHERE lp.user_id = ? AND m.course_id = ? AND lp.status = 'completed'
              AND l.status = 'published'
              AND EXISTS (SELECT 1 FROM lesson_reflections r
                          WHERE r.user_id = lp.user_id AND r.lesson_id = lp.lesson_id)) AS reflected_lessons,
           (SELECT COALESCE(SUM(l.duration_minutes), 0) FROM lessons l
            JOIN modules m ON m.id = l.module_id
            WHERE m.course_id = ? AND l.status = 'published') AS total_minutes`,
      )
        .bind(lesson.course_id, user.id, lesson.course_id, lesson.course_id)
        .first();
      const total = totals?.total_lessons ?? 0;
      const reflected = totals?.reflected_lessons ?? 0;
      if (total > 0 && reflected >= total) {
        if (!enrolment.completed_at) {
          await DB.prepare(
            "UPDATE enrollments SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
          )
            .bind(new Date().toISOString(), enrolment.id)
            .run();
        }
        courseCompleted = true;
        const minutes = totals?.total_minutes ?? 0;
        const hours = Math.min(500, Math.max(1, Math.round((minutes / 60) * 100) / 100));
        const issued = await issueCertificate(c.env as any, {
          enrollmentId: enrolment.id,
          hours,
          issueSource: "auto",
        });
        if (issued.ok) {
          certificate = { code: issued.certificate.code, verify_url: issued.certificate.verify_url };
        } else if (issued.reason === "already_exists" && issued.code) {
          certificate = { code: issued.code, verify_url: `/c/${issued.code}` };
        } else {
          /* Not configured, or signing failed: completion stands, and a
           * later re-completion or the admin manual issue finishes it. */
          certificatePending = true;
        }
      }
    }
  } catch {
    /* Completion and issuance are best effort after the lesson itself
     * saved: a failure here must never un-complete the lesson. When
     * the enrolment was stamped above, the next re-completion retries
     * the issue; when it was not, the course simply is not complete
     * yet and the next lesson completion retries the whole step. */
    if (courseCompleted) certificatePending = true;
  }

  return c.json({ ok: true, course_completed: courseCompleted, certificate, certificate_pending: certificatePending });
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
 *  that are still published; `completed` reads the stamped completed_at
 *  (Phase 4 slice 2) with a reflection-count fallback for enrolments
 *  completed before the stamp existed. certificate_code is the valid
 *  certificate for the enrolment, or null. */
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
               AND lp.status = 'completed' AND l.status = 'published') AS done_lessons,
            (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
             JOIN modules m ON m.id = l.module_id
             WHERE lp.user_id = e.user_id AND m.course_id = e.course_id
               AND lp.status = 'completed' AND l.status = 'published'
               AND EXISTS (SELECT 1 FROM lesson_reflections r
                           WHERE r.user_id = lp.user_id AND r.lesson_id = lp.lesson_id)) AS reflected_lessons,
            (SELECT code FROM certificates WHERE enrollment_id = e.id AND status = 'valid' LIMIT 1) AS certificate_code
     FROM enrollments e JOIN courses co ON co.id = e.course_id
     WHERE e.user_id = ? AND co.status = 'published'`
  )
    .bind(user.id)
    .all();

  /* completed_at is now stamped by the progress route, but enrolments
   * completed before this slice never got a stamp: the reflection
   * count covers them, so an old completed course still reads
   * complete and still surfaces its certificate code. */
  const rows = (enrolments.results as any[]).map((e) => ({
    ...e,
    completed: e.completed_at != null ||
      (e.total_lessons > 0 && e.reflected_lessons >= e.total_lessons),
  }));
  return c.json({ ok: true, enrolments: rows });
});

export default app;
