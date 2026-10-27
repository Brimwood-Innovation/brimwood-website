/* Route tests: enrolment :  idempotency, progress gating, progress math. */
import { describe, it, expect } from "vitest";
import app from "./enrolment";
import { mockEnv, memberSession, postJSON } from "../test/helpers";

function enrolEnv(courseRow: any, lessonRow: any, reflectionRow: any = null) {
  const env = mockEnv();
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM courses/.test(sql) && !/JOIN courses/.test(sql)) return { row: courseRow };
    if (/FROM lessons l/.test(sql)) return { row: lessonRow };
    if (/FROM lesson_reflections/.test(sql)) return { row: reflectionRow };
    return prev?.(sql, params);
  };
  return env;
}

const reflectionText =
  "This lesson changed how I think about shipping: small, verified, every day.";

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
    const res = await postJSON(app, "/progress/l1", { reflection: reflectionText }, env, h);
    expect(res.status).toBe(200);
    expect(env.DB.calls.some((c) => /INSERT OR IGNORE INTO enrollments/.test(c.sql))).toBe(true);
    expect(env.DB.calls.some((c) => /INSERT INTO lesson_progress/.test(c.sql))).toBe(true);
  });

  it("upserts on re-complete (no duplicate rows)", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson, { id: "r1" });
    const h = memberSession(env);
    // Existing reflection: re-complete needs no new text.
    await postJSON(app, "/progress/l1", {}, env, h);
    const res = await postJSON(app, "/progress/l1", { reflection: reflectionText }, env, h);
    expect(res.status).toBe(200);
    const writes = env.DB.calls.filter((c) => /lesson_progress/.test(c.sql) && c.op === "run");
    expect(writes.every((c) => /ON CONFLICT\(user_id, lesson_id\)/.test(c.sql))).toBe(true);
  });

  it("400s without a reflection on first completion (D6)", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", {}, env, h);
    expect(res.status).toBe(400);
    // No progress row written.
    expect(env.DB.calls.some((c) => /INSERT INTO lesson_progress/.test(c.sql))).toBe(false);
  });

  it("400s when the reflection is too short or too long", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const h = memberSession(env);
    const short = await postJSON(app, "/progress/l1", { reflection: "too short" }, env, h);
    expect(short.status).toBe(400);
    const long = await postJSON(
      app,
      "/progress/l1",
      { reflection: "x".repeat(2001) },
      env,
      h
    );
    expect(long.status).toBe(400);
    expect(env.DB.calls.some((c) => /INSERT INTO lesson_progress/.test(c.sql))).toBe(false);
  });

  it("inserts the reflection first, in one batch with the progress upsert", async () => {
    const env = enrolEnv({ id: "course-1" }, publishedLesson);
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", { reflection: reflectionText }, env, h);
    expect(res.status).toBe(200);
    const calls = env.DB.calls;
    const reflIdx = calls.findIndex((c) => /INSERT INTO lesson_reflections/.test(c.sql));
    const progIdx = calls.findIndex((c) => /INSERT INTO lesson_progress/.test(c.sql));
    expect(reflIdx).toBeGreaterThanOrEqual(0);
    expect(progIdx).toBeGreaterThanOrEqual(0);
    // Reflection insert runs before the progress upsert (one batch, in order).
    expect(reflIdx).toBeLessThan(progIdx);
    // Re-submitting edits the row, not a duplicate.
    expect(calls[reflIdx].sql).toMatch(/ON CONFLICT\(user_id, lesson_id\)/);
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
        total_lessons: 2, done_lessons: 2, reflected_lessons: 2,
      },
      {
        course_id: "c2", slug: "forge", title: "Forge",
        enrolled_at: "2026-01-01", completed_at: null,
        total_lessons: 3, done_lessons: 1, reflected_lessons: 1,
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
    // `completed` reads the stamp, with a reflection-count fallback for
    // enrolments completed before the stamp existed (Phase 4 slice 2).
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

/* Phase 4 slice 2: reflection-gated completion with automatic issue. */
describe("POST /api/progress/:lessonId automatic certificate issue", () => {
  function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s: string): Uint8Array {
    const norm = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  }
  async function makeKeypair() {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pubRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const privPkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    return { publicKey: pair.publicKey, publicB64: b64url(pubRaw), privateB64: b64url(privPkcs8) };
  }

  async function autoEnv(opts: {
    totals: any;
    routeEnrolment: any;
    libEnrolment: any;
    keys?: { publicB64: string; privateB64: string } | null;
    existing?: any;
  }) {
    const env = mockEnv(
      opts.keys
        ? ({ CERT_SIGNING_KEY: opts.keys.privateB64, CERT_SIGNING_KEY_ID: "key-1" } as any)
        : ({} as any),
    );
    const prev = env.DB.handler;
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/FROM signing_keys/i.test(sql)) {
        return { row: opts.keys ? { key_id: "key-1", public_key: opts.keys.publicB64 } : null };
      }
      if (/FROM enrollments e JOIN/i.test(sql)) return { row: opts.libEnrolment };
      if (/FROM enrollments WHERE user_id/i.test(sql)) return { row: opts.routeEnrolment };
      if (/reflected_lessons/i.test(sql)) return { row: opts.totals };
      if (/FROM certificates WHERE enrollment_id/i.test(sql)) return { row: opts.existing ?? null };
      if (/FROM lessons l/i.test(sql)) return { row: { id: "l1", course_id: "course-1" } };
      if (/FROM lesson_reflections/i.test(sql)) return { row: { id: "r1" } };
      return prev?.(sql, params);
    };
    return env;
  }

  const fullTotals = { total_lessons: 1, reflected_lessons: 1, total_minutes: 120 };
  const libEnrolment = {
    id: "enr-1", user_id: "member-1", course_id: "course-1",
    completed_at: "2026-10-27T10:00:00.000Z", course_title: "Foundations",
  };

  it("stamps completion and auto-issues when the last lesson is reflected-complete", async () => {
    const keys = await makeKeypair();
    const env = await autoEnv({
      totals: fullTotals,
      routeEnrolment: { id: "enr-1", completed_at: null },
      libEnrolment,
      keys,
    });
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", { reflection: reflectionText }, env, h);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.course_completed).toBe(true);
    expect(body.certificate_pending).toBe(false);
    expect(body.certificate.code).toMatch(/^BRIM-\d{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(body.certificate.verify_url).toBe(`/c/${body.certificate.code}`);
    expect(env.DB.calls.some((c) => /UPDATE enrollments SET completed_at/i.test(c.sql))).toBe(true);
    const certs = (env.DB as any).inserts.get("certificates") || [];
    expect(certs).toHaveLength(1);
    expect(certs[0].issue_source).toBe("auto");
    expect(certs[0].hours).toBe(2);
    expect(certs[0].canonical).toBe(
      `v1|${body.certificate.code}|member-1|course-1|${certs[0].issued_at}`,
    );
    const ok = await crypto.subtle.verify(
      "Ed25519",
      keys.publicKey,
      b64urlDecode(certs[0].signature),
      new TextEncoder().encode(certs[0].canonical),
    );
    expect(ok).toBe(true);
  });

  it("does not complete the course when a lesson has no reflection", async () => {
    const keys = await makeKeypair();
    const env = await autoEnv({
      totals: { total_lessons: 2, reflected_lessons: 1, total_minutes: 120 },
      routeEnrolment: { id: "enr-1", completed_at: null },
      libEnrolment: { ...libEnrolment, completed_at: null },
      keys,
    });
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", { reflection: reflectionText }, env, h);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.course_completed).toBe(false);
    expect(body.certificate).toBeNull();
    expect(body.certificate_pending).toBe(false);
    expect(env.DB.calls.some((c) => /UPDATE enrollments SET completed_at/i.test(c.sql))).toBe(false);
    expect((env.DB as any).inserts.get("certificates") || []).toHaveLength(0);
  });

  it("still completes when signing is not configured, and reports pending", async () => {
    const env = await autoEnv({
      totals: fullTotals,
      routeEnrolment: { id: "enr-1", completed_at: null },
      libEnrolment,
      keys: null,
    });
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", { reflection: reflectionText }, env, h);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.course_completed).toBe(true);
    expect(body.certificate).toBeNull();
    expect(body.certificate_pending).toBe(true);
    expect(env.DB.calls.some((c) => /UPDATE enrollments SET completed_at/i.test(c.sql))).toBe(true);
  });

  it("retries the automatic issue on re-completion when already stamped", async () => {
    const keys = await makeKeypair();
    const env = await autoEnv({
      totals: fullTotals,
      routeEnrolment: { id: "enr-1", completed_at: "2026-10-26T10:00:00.000Z" },
      libEnrolment,
      keys,
    });
    const h = memberSession(env);
    const res = await postJSON(app, "/progress/l1", { reflection: reflectionText }, env, h);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.course_completed).toBe(true);
    expect(body.certificate_pending).toBe(false);
    expect(body.certificate.code).toMatch(/^BRIM-\d{4}-/);
    expect(env.DB.calls.some((c) => /UPDATE enrollments SET completed_at/i.test(c.sql))).toBe(false);
  });
});

describe("GET /api/progress certificate surface", () => {
  it("surfaces the valid certificate code and the reflection-gated completed flag", async () => {
    const env = mockEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/FROM enrollments e/.test(sql)) {
        return {
          results: [
            {
              course_id: "c1", slug: "foundations", title: "Foundations",
              enrolled_at: "2026-01-01", completed_at: null,
              total_lessons: 2, done_lessons: 2, reflected_lessons: 2,
              certificate_code: "BRIM-2026-8F3K7Q",
            },
            {
              course_id: "c2", slug: "forge", title: "Forge",
              enrolled_at: "2026-01-01", completed_at: null,
              total_lessons: 2, done_lessons: 2, reflected_lessons: 1,
              certificate_code: null,
            },
          ],
        };
      }
      return prev?.(sql, params);
    };
    const h = memberSession(env);
    const res = await app.request("/progress", { headers: h }, env as any);
    const d: any = await res.json();
    expect(res.status).toBe(200);
    expect(d.enrolments[0].completed).toBe(true);
    expect(d.enrolments[0].certificate_code).toBe("BRIM-2026-8F3K7Q");
    // Two lessons done but only one reflected: not complete, by design.
    expect(d.enrolments[1].completed).toBe(false);
    const sql = env.DB.calls.find((c) => /FROM enrollments e/.test(c.sql))!.sql;
    expect(sql).toMatch(/certificate_code/);
    expect(sql).toMatch(/reflected_lessons/);
  });
});
