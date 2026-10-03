/* CMS course sync (Phase 5 — CMS-to-D1 pipeline).
 *
 * POST /api/admin/sync/courses
 *
 * Accepts course content parsed from Decap CMS Markdown (site/src/content/courses/)
 * and upserts it into the D1 Academy tables (courses, modules, lessons).
 * Called automatically by the GitHub Action on every push that touches course
 * Markdown, so CMS edits go live without a developer.
 *
 * Auth: admin session cookie (same pattern as admin.ts) OR
 *   Authorization: Bearer <SYNC_SECRET> (used by the GitHub Action).
 *
 * Sync semantics, per course (keyed by slug):
 * - course row: upsert by slug (stable id)
 * - modules: reconciled by position (sort_order); extras deleted (their lessons
 *   are removed by ON DELETE CASCADE)
 * - lessons: reconciled by slug within the module, so lesson ids stay stable
 *   across re-syncs and member progress in lesson_progress is preserved;
 *   stale slugs deleted
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";
import { cleanStr } from "../lib/validate";

const app = new Hono<{ Bindings: Bindings }>();
const COOKIE = "brimwood_sess";

const LEVELS = ["foundations", "builder", "operator"];
const VISIBILITIES = ["public", "members"];
const COURSE_STATUSES = ["draft", "published", "archived"];
const LESSON_STATUSES = ["draft", "published"];

// Guardrails: CMS-scale content, not a bulk import API.
const MAX_COURSES = 50;
const MAX_MODULES = 50;
const MAX_LESSONS = 200;

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/** Manual constant-time string compare — see lib/safe-equal.ts. */
import { safeEqual } from "../lib/safe-equal";

async function authorized(
  c: any
): Promise<{ ok: boolean; actor: string; actorId: string | null }> {
  // 1. Admin session cookie (same pattern as admin.ts).
  const token = getCookie(c, COOKIE);
  if (token) {
    const raw = await c.env.SESSIONS_KV.get("sess:" + token);
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (s.role === "admin") {
          const u: any = await c.env.DB.prepare(
            "SELECT id, email FROM users WHERE id = ? AND status = 'active'"
          )
            .bind(s.userId)
            .first();
          if (u) return { ok: true, actor: u.email, actorId: u.id };
        }
      } catch {
        /* fall through to bearer check */
      }
    }
  }
  // 2. Bearer sync secret (GitHub Action; cannot do magic-link login).
  const secret = c.env.SYNC_SECRET;
  const header = c.req.header("authorization") || "";
  if (secret && header.startsWith("Bearer ")) {
    if (safeEqual(header.slice(7).trim(), secret)) {
      return { ok: true, actor: "sync-action", actorId: null };
    }
  }
  return { ok: false, actor: "", actorId: null };
}

function pick<T>(v: unknown, allowed: readonly string[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback;
}

app.post("/courses", async (c) => {
  const auth = await authorized(c);
  if (!auth.ok) return c.json({ ok: false, error: "Not authorized" }, 403);

  const { DB } = c.env;
  let data: any;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const courses = Array.isArray(data?.courses) ? data.courses : null;
  if (!courses) return c.json({ ok: false, error: "Expected { courses: [...] }" }, 400);
  if (courses.length > MAX_COURSES) {
    return c.json({ ok: false, error: `Too many courses (max ${MAX_COURSES})` }, 400);
  }

  let nModules = 0;
  let nLessons = 0;

  for (let ci = 0; ci < courses.length; ci++) {
    const course = courses[ci] ?? {};
    const slug = cleanStr(course.slug, 100).toLowerCase();
    const title = cleanStr(course.title, 200);
    if (!slug || !title) {
      return c.json({ ok: false, error: `Course #${ci + 1} needs a slug and title` }, 400);
    }
    const tagline = cleanStr(course.tagline, 300);
    const descriptionMd =
      typeof course.description_md === "string" ? course.description_md.slice(0, 50000) : "";
    const level = pick(course.level, LEVELS, "foundations");
    const visibility = pick(course.visibility, VISIBILITIES, "members");
    const status = pick(course.status, COURSE_STATUSES, "draft");
    const coverR2 = cleanStr(course.cover_r2_key, 300) || null;
    const modules = Array.isArray(course.modules) ? course.modules : [];
    if (modules.length > MAX_MODULES) {
      return c.json({ ok: false, error: `Too many modules in "${slug}"` }, 400);
    }

    // Upsert the course by slug (stable id across syncs).
    await DB.prepare(
      `INSERT INTO courses
         (id, slug, title, tagline, description_md, cover_r2_key, level, visibility, status, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title,
         tagline = excluded.tagline,
         description_md = excluded.description_md,
         cover_r2_key = excluded.cover_r2_key,
         level = excluded.level,
         visibility = excluded.visibility,
         status = excluded.status,
         sort_order = excluded.sort_order,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
      .bind(
        crypto.randomUUID(), slug, title, tagline, descriptionMd, coverR2,
        level, visibility, status, ci
      )
      .run();

    const courseRow = await DB.prepare("SELECT id FROM courses WHERE slug = ?")
      .bind(slug)
      .first<{ id: string }>();
    if (!courseRow) return c.json({ ok: false, error: "Sync failed (course)" }, 500);
    const courseId = courseRow.id;

    // Modules: reconcile by position.
    const existingMods = ((
      await DB.prepare("SELECT id FROM modules WHERE course_id = ? ORDER BY sort_order")
        .bind(courseId)
        .all()
    ).results ?? []) as { id: string }[];

    for (let mi = 0; mi < modules.length; mi++) {
      const m = modules[mi] ?? {};
      const mTitle = cleanStr(m.title, 200) || `Module ${mi + 1}`;
      let moduleId: string;
      if (mi < existingMods.length) {
        moduleId = existingMods[mi].id;
        await DB.prepare("UPDATE modules SET title = ?, sort_order = ? WHERE id = ?")
          .bind(mTitle, mi, moduleId)
          .run();
      } else {
        moduleId = crypto.randomUUID();
        await DB.prepare(
          "INSERT INTO modules (id, course_id, title, sort_order) VALUES (?, ?, ?, ?)"
        )
          .bind(moduleId, courseId, mTitle, mi)
          .run();
      }
      nModules++;

      // Lessons: reconcile by slug within the module (ids stay stable,
      // so lesson_progress rows keep working).
      const lessons = Array.isArray(m.lessons) ? m.lessons : [];
      if (lessons.length > MAX_LESSONS) {
        return c.json({ ok: false, error: `Too many lessons in "${mTitle}"` }, 400);
      }
      const existingLessons = ((
        await DB.prepare("SELECT id, slug FROM lessons WHERE module_id = ?")
          .bind(moduleId)
          .all()
      ).results ?? []) as { id: string; slug: string }[];
      const bySlug = new Map(existingLessons.map((l) => [l.slug, l.id]));
      const seen = new Set<string>();
      const usedSlugs = new Set<string>();

      for (let li = 0; li < lessons.length; li++) {
        const l = lessons[li] ?? {};
        const lTitle = cleanStr(l.title, 200);
        if (!lTitle) {
          return c.json(
            { ok: false, error: `Lesson #${li + 1} in module "${mTitle}" needs a title` },
            400
          );
        }
        let lSlug = slugify(lTitle);
        for (let n = 2; usedSlugs.has(lSlug); n++) lSlug = `${slugify(lTitle)}-${n}`;
        usedSlugs.add(lSlug);
        seen.add(lSlug);

        const bodyMd =
          typeof l.body_md === "string"
            ? l.body_md
            : typeof l.body === "string"
              ? l.body
              : "";
        const isPreview = l.is_preview === true ? 1 : 0;
        const lStatus = pick(l.status, LESSON_STATUSES, "published");
        const durRaw = Number(l.duration_minutes);
        const duration = Number.isFinite(durRaw) && durRaw > 0 ? Math.floor(durRaw) : null;
        const videoKey = cleanStr(l.video_r2_key, 300) || null;

        const existingId = bySlug.get(lSlug);
        if (existingId) {
          await DB.prepare(
            `UPDATE lessons SET title = ?, body_md = ?, is_preview = ?, status = ?,
               duration_minutes = ?, video_r2_key = ?, sort_order = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?`
          )
            .bind(
              lTitle, bodyMd.slice(0, 100000), isPreview, lStatus,
              duration, videoKey, li, existingId
            )
            .run();
        } else {
          await DB.prepare(
            `INSERT INTO lessons
               (id, module_id, slug, title, body_md, is_preview, status,
                duration_minutes, video_r2_key, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              crypto.randomUUID(), moduleId, lSlug, lTitle,
              bodyMd.slice(0, 100000), isPreview, lStatus, duration, videoKey, li
            )
            .run();
        }
        nLessons++;
      }

      // Delete lessons whose slugs disappeared from the CMS.
      for (const ex of existingLessons) {
        if (!seen.has(ex.slug)) {
          await DB.prepare("DELETE FROM lessons WHERE id = ?").bind(ex.id).run();
        }
      }
    }

    // Delete modules past the end of the CMS list (lessons cascade).
    for (let mi = modules.length; mi < existingMods.length; mi++) {
      await DB.prepare("DELETE FROM modules WHERE id = ?").bind(existingMods[mi].id).run();
    }
  }

  await DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(
      crypto.randomUUID(),
      auth.actorId,
      "courses.sync",
      `${auth.actor}: ${courses.length} courses, ${nModules} modules, ${nLessons} lessons`
    )
    .run();

  return c.json({ ok: true, courses: courses.length, modules: nModules, lessons: nLessons });
});

export default app;
