/* Route tests: academy — course reads (N+1 fix), lesson gating, visibility. */
import { describe, it, expect } from "vitest";
import app from "./academy";
import { mockEnv, memberSession, adminSession } from "../test/helpers";

const COURSE = {
  id: "course-1",
  slug: "foundations",
  title: "Foundations",
  tagline: "Start here.",
  description_md: "desc",
  level: "foundations",
  visibility: "members",
};

function courseEnv() {
  const env = mockEnv();
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM courses/.test(sql)) return { row: COURSE };
    if (/FROM modules/.test(sql))
      return {
        results: [
          { id: "m1", title: "M1", sort_order: 0 },
          { id: "m2", title: "M2", sort_order: 1 },
        ],
      };
    if (/module_id IN/.test(sql))
      return {
        results: [
          { id: "l1", module_id: "m1", slug: "a", title: "A", duration_minutes: 5, is_preview: 1, sort_order: 0 },
          { id: "l2", module_id: "m2", slug: "b", title: "B", duration_minutes: 5, is_preview: 0, sort_order: 1 },
        ],
      };
    return prev?.(sql, params);
  };
  return env;
}

const lessonRow = (over: any = {}) => ({
  id: "l1",
  slug: "a",
  title: "A",
  body_md: "body",
  body_html: null,
  video_r2_key: null,
  duration_minutes: 5,
  is_preview: 0,
  sort_order: 0,
  course_id: "course-1",
  course_slug: "foundations",
  course_title: "Foundations",
  course_visibility: "members",
  ...over,
});

function lessonEnv(lesson: any, opts: { enrolled?: boolean } = {}) {
  const env = mockEnv();
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM lessons l/.test(sql)) return { row: lesson };
    if (/FROM enrollments/.test(sql)) return { row: opts.enrolled ? { id: "e1" } : null };
    return prev?.(sql, params);
  };
  return env;
}

describe("GET /api/courses/:slug", () => {
  it("groups lessons under modules with a single lessons query (no N+1)", async () => {
    const env = courseEnv();
    const res = await app.request("/foundations", {}, env as any);
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.ok).toBe(true);
    expect(d.modules).toHaveLength(2);
    expect(d.modules[0].lessons.map((l: any) => l.id)).toEqual(["l1"]);
    expect(d.modules[1].lessons.map((l: any) => l.id)).toEqual(["l2"]);
    // Exactly one lessons query for both modules.
    const lessonQueries = env.DB.calls.filter((c) => /FROM lessons/.test(c.sql));
    expect(lessonQueries).toHaveLength(1);
    expect(lessonQueries[0].sql).toMatch(/module_id IN/);
    // module_id is stripped from the public payload.
    expect(d.modules[0].lessons[0].module_id).toBeUndefined();
  });

  it("404s on unknown course", async () => {
    const env = mockEnv();
    const res = await app.request("/nope", {}, env as any);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/courses/lessons/:id gating", () => {
  it("serves preview lessons to anonymous visitors", async () => {
    const env = lessonEnv(lessonRow({ is_preview: 1 }));
    const res = await app.request("/lessons/l1", {}, env as any);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).lesson.body_md).toBe("body");
  });

  it("401s anonymous visitors on members-only lessons", async () => {
    const env = lessonEnv(lessonRow());
    const res = await app.request("/lessons/l1", {}, env as any);
    expect(res.status).toBe(401);
  });

  it("403s signed-in members who are not enrolled", async () => {
    const env = lessonEnv(lessonRow());
    const h = memberSession(env);
    const res = await app.request("/lessons/l1", { headers: h }, env as any);
    expect(res.status).toBe(403);
  });

  it("serves enrolled members", async () => {
    const env = lessonEnv(lessonRow(), { enrolled: true });
    const h = memberSession(env);
    const res = await app.request("/lessons/l1", { headers: h }, env as any);
    expect(res.status).toBe(200);
  });

  it("lets admins bypass the enrolment check", async () => {
    const env = lessonEnv(lessonRow());
    const h = adminSession(env);
    const res = await app.request("/lessons/l1", { headers: h }, env as any);
    expect(res.status).toBe(200);
  });

  it("serves non-preview lessons of visibility='public' courses to anonymous visitors", async () => {
    const env = lessonEnv(lessonRow({ is_preview: 0, course_visibility: "public" }));
    const res = await app.request("/lessons/l1", {}, env as any);
    expect(res.status).toBe(200);
  });

  it("404s on unknown lesson", async () => {
    const env = lessonEnv(null);
    const res = await app.request("/lessons/nope", {}, env as any);
    expect(res.status).toBe(404);
  });
});
