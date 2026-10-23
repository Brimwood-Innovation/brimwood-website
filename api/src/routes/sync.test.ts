/* Route tests: CMS course sync :  archive, never delete (Phase 1 items 10+19).
 * A lesson or module that leaves the CMS is archived (status/archived_at),
 * never deleted, so member reflections and progress survive (D6). Readers
 * skip archived rows; reconciliation skips them too. */
import { describe, it, expect } from "vitest";
import app from "./sync";
import { mockEnv, postJSON } from "../test/helpers";

const bearerFor = (env: { SYNC_SECRET?: string }) => ({
  Authorization: `Bearer ${env.SYNC_SECRET}`,
});

function syncBody(modules: any[]) {
  return {
    courses: [
      {
        slug: "foundations",
        title: "Foundations",
        status: "published",
        modules,
      },
    ],
  };
}

/** Mock DB: course exists; configurable existing modules and lessons. */
function syncEnv(mods: any[], lessonsByModule: Record<string, any[]>) {
  const env = mockEnv();
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM courses WHERE slug/.test(sql)) return { row: { id: "course-1" } };
    if (/FROM modules WHERE course_id/.test(sql)) return { results: mods };
    if (/FROM lessons WHERE module_id/.test(sql)) {
      return { results: lessonsByModule[params[0] as string] ?? [] };
    }
    return prev?.(sql, params);
  };
  return env;
}

describe("POST /api/admin/sync/courses (archive semantics)", () => {
  it("archives a lesson whose slug left the CMS instead of deleting it", async () => {
    const env = syncEnv([{ id: "m1" }], {
      m1: [{ id: "l-old", slug: "old-slug" }],
    });
    const res = await postJSON(
      app,
      "/courses",
      syncBody([{ title: "Module 1", lessons: [{ title: "Brand new lesson" }] }]),
      env,
      bearerFor(env)
    );
    expect(res.status).toBe(200);
    const calls = env.DB.calls;
    // No DELETE anywhere.
    expect(calls.some((c) => /^\s*delete\s+from\s+(lessons|modules)/i.test(c.sql))).toBe(false);
    // The stale lesson is archived.
    const archive = calls.find((c) => /UPDATE lessons SET status = 'archived'/.test(c.sql));
    expect(archive).toBeDefined();
    expect(archive!.params).toContain("l-old");
    // The new slug gets a fresh row.
    expect(
      calls.some((c) => /INSERT INTO lessons/.test(c.sql))
    ).toBe(true);
  });

  it("archives an extra module and its lessons instead of deleting them", async () => {
    const env = syncEnv([{ id: "m1" }, { id: "m2" }], {
      m1: [{ id: "l1", slug: "lesson-one" }],
      m2: [{ id: "l2", slug: "lesson-two" }],
    });
    const res = await postJSON(
      app,
      "/courses",
      syncBody([{ title: "Module 1", lessons: [{ title: "Lesson one" }] }]),
      env,
      bearerFor(env)
    );
    expect(res.status).toBe(200);
    const calls = env.DB.calls;
    expect(calls.some((c) => /^\s*delete\s+from\s+(lessons|modules)/i.test(c.sql))).toBe(false);
    const modArchive = calls.find((c) => /UPDATE modules SET archived_at/.test(c.sql));
    expect(modArchive).toBeDefined();
    expect(modArchive!.params).toContain("m2");
    // The archived module's lessons are archived too.
    const lessonArchive = calls.find(
      (c) =>
        /UPDATE lessons SET status = 'archived'/.test(c.sql) &&
        /WHERE module_id/.test(c.sql)
    );
    expect(lessonArchive).toBeDefined();
    expect(lessonArchive!.params).toContain("m2");
    // The surviving module keeps its row (title/sort update), not an archive.
    expect(
      calls.some(
        (c) => /UPDATE modules SET title/.test(c.sql) && c.params.includes("m1")
      )
    ).toBe(true);
  });

  it("reconciliation reads skip archived modules and lessons", async () => {
    const env = syncEnv([], {});
    await postJSON(
      app,
      "/courses",
      syncBody([{ title: "Module 1", lessons: [{ title: "Lesson one" }] }]),
      env,
      bearerFor(env)
    );
    const modSelect = env.DB.calls.find((c) => /FROM modules WHERE course_id/.test(c.sql))!;
    expect(modSelect.sql).toMatch(/archived_at IS NULL/);
    const lessonSelect = env.DB.calls.find((c) =>
      /FROM lessons WHERE module_id/.test(c.sql)
    )!;
    expect(lessonSelect.sql).toMatch(/status <> 'archived'/);
  });

  it("403s without the sync secret or an admin session", async () => {
    const env = syncEnv([], {});
    const res = await postJSON(app, "/courses", { courses: [] }, env);
    expect(res.status).toBe(403);
  });
});
