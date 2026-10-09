/* Route tests: enrolment — idempotency, progress gating, progress math. */
import { describe, it, expect } from "vitest";
import app from "./enrolment";
import { mockEnv, memberSession, postJSON } from "../test/helpers";

function enrolEnv(courseRow: any, lessonRow: any) {
  const env = mockEnv();
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM courses/.test(sql) && !/JOIN courses/.test(sql)) return { row: courseRow };
    if (/FROM lessons l/.test(sql)) return { row: lessonRow };
    return prev?.(sql, params);
  };
  return env;
}

const publishedLesson = { id: "l1", course_id: "course-1" };

describe("POST /api/enrol/:courseSlug", () => {
  it("401s without a session", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const res = await postJSON(app, "/enrol/foundations", {}, env);
    expect(res.status).toBe(401);
  });

  it("is idempotent: double-POST uses INSERT OR IGNORE", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const h = memberSession(env);
    const r1 = await postJSON(app, "/enrol/foundations", {}, env, h);
    const r2 = await postJSON(app, "/enrol/foundations", {}, env, h);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const inserts = env.DB.calls.filter((c) => /INSERT OR IGNORE INTO enrollments/.test(c.sql));
    expect(inserts.length).toBeGreaterThanOrEqual(2);
  });

  it("404s on unknown or unpublished course", async () => {
    const env = enrolEnv(null, publishedLesson);
    const h = memberSession(env);
    const res = await postJSON(app, "/enrol/nope", {}, env, h);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/progress/:lessonId", () => {
  it("401s without a session", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const res = await postJSON(app, "/progress/l1", {}, env);
    expect(res.status).toBe(401);
  });

  it("404s for lessons in unpublished courses (matches lesson gating)", async () => {
    // Lesson query requires co.status='published'; null row = draft course.
    const env = enrolEnv({ id: "course-1" }, null);
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", {}, env, h);
    expect(res.status).toBe(404);
    // No progress row written.
    expect(env.DB.calls.some((c) => /INSERT INTO lesson_progress/.test(c.sql))).toBe(false);
  });

  it("marks complete and auto-enrols on success", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", {}, env, h);
    expect(res.status).toBe(200);
    expect(env.DB.calls.some((c) => /INSERT OR IGNORE INTO enrollments/.test(c.sql))).toBe(true);
    expect(env.DB.calls.some((c) => /INSERT INTO lesson_progress/.test(c.sql))).toBe(true);
  });

  it("upserts on re-complete (no duplicate rows)", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const h = memberSession(env);
    await postJSON(app, "/progress/l1", {}, env, h);
    const res = await postJSON(app, "/progress/l1", {}, env, h);
    expect(res.status).toBe(200);
    const writes = env.DB.calls.filter((c) => /lesson_progress/.test(c.sql) && c.op === "run");
    expect(writes.every((c) => /ON CONFLICT\(user_id, lesson_id\)/.test(c.sql))).toBe(true);
  });
});

describe("GET /api/progress", () => {
  function progressEnv(rows: any[]) {
    const env = mockEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/FROM enrollments e/.test(sql)) return { results: rows };
      return prev?.(sql, params);
    };
    return env;
  }

  it("401s without a session", async () => {
    const env = progressEnv([]);
    const res = await app.request("/progress", {}, env as any);
    expect(res.status).toBe(401);
  });

  it("counts only completed, still-published lessons and derives `completed`", async () => {
    const env = progressEnv([
      {
        course_id: "c1", slug: "foundations", title: "Foundations",
        enrolled_at: "2026-01-01", completed_at: null,
        total_lessons: 2, done_lessons: 2,
      },
      {
        course_id: "c2", slug: "forge", title: "Forge",
        enrolled_at: "2026-01-01", completed_at: null,
        total_lessons: 3, done_lessons: 1,
      },
    ]);
    const h = memberSession(env);
    const res = await app.request("/progress", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    // done_lessons must count completed rows for published lessons only.
    const sql = env.DB.calls.find((c) => /FROM enrollments e/.test(c.sql))!.sql;
    expect(sql).toMatch(/lp\.status = 'completed'/);
    expect(sql).toMatch(/l\.status = 'published'/);
    // … and only published courses are listed.
    expect(sql).toMatch(/co\.status = 'published'/);
    // `completed` is derived, not read from the never-written column.
    expect(d.enrolments[0].completed).toBe(true);
    expect(d.enrolments[1].completed).toBe(false);
  });
});

describe("GET /api/progress/detail", () => {
  it("returns completed lesson ids", async () => {
    const env = mockEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/FROM lesson_progress/.test(sql)) return { results: [{ lesson_id: "l1" }] };
      return prev?.(sql, params);
    };
    const h = memberSession(env);
    const res = await app.request("/progress/detail", { headers: h }, env as any);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).done).toEqual(["l1"]);
  });
});
