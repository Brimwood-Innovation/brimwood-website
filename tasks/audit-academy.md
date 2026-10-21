# Academy audit (courses / lessons / enrolment / progress / video / dashboard / crons)

Worktree `~/workspace/wt-audit/academy`, branch `audit/academy`. Scope: `api/src/routes/{academy,enrolment,video,media}.ts`,
`api/src/cron.ts` (digest + scheduled publishing), `site/src/pages/academy/**`, `site/src/pages/dashboard.astro`.
Date: 2026-10-08.

## Errors found

### Critical

- **C1 — Members-only video bytes leak via public edge cache (video.ts).**
  `GET /api/video/:key` sets `Cache-Control: public, max-age=3600` for every
  response, including members-only lessons. The access check (session +
  enrolment) runs per request, but the edge cache key is the URL only — there is
  no cookie variation — so the first member's 200/206 can be served from cache to
  anonymous users. Fix: `private` for gated videos, `public` only for preview
  (and `visibility='public'`) lessons.
- **C2 — Range requests mishandled; no 416 (video.ts).**
  - Out-of-range request (`Range: bytes=999999-` past EOF) → R2 returns null →
    404 instead of `416 Range Not Satisfiable`.
  - `bytes=100-50` (start > end) → negative `length` passed to `MEDIA.get`.
  - Suffix ranges (`bytes=-500`) are mis-served as `bytes=0-500`.
  - The regex is unanchored (`/bytes=(\d*)-(\d*)/`), so `bytes=abc-` silently
    becomes a full 200 and multi-range headers are half-parsed.
  Fix: `HEAD` for size first, strict anchored parsing, 416 with
  `Content-Range: bytes */<size>` for anything unsatisfiable.

### Major

- **M1 — Weekly digest is not idempotent (cron.ts).**
  The send loop has no per-run/per-subscriber record. A cron retry or overlapping
  invocation after a partial send re-sends to subscribers who already got it.
  The only log is one summary `email_log` row. Fix: `digest_sends(digest_id,
  email)` table (PK), `INSERT OR IGNORE` per subscriber before sending, skip on
  `changes = 0`. Digest id = Monday date (`digest-YYYY-MM-DD`) so a given week's
  run can be safely retried.
- **M2 — N+1 query on course detail (academy.ts).**
  `GET /api/courses/:slug` runs one lesson query per module. Fix: single
  `WHERE module_id IN (...)` query, grouped in JS.
- **M3 — `done_lessons` counts unfinished and unpublished lessons (enrolment.ts).**
  `GET /api/progress` counts every `lesson_progress` row regardless of
  `status` (the column allows `'started'`) and regardless of whether the lesson
  is still published. Dashboard percentages can exceed 100% and count
  removed lessons. Fix: `lp.status = 'completed' AND l.status = 'published'`.
- **M4 — Dashboard "Completed ✓" is dead (enrolment.ts + dashboard.astro).**
  The dashboard keys off `enrollments.completed_at`, but nothing in the codebase
  ever writes that column (only `enrolled_at` is set). Fix: derive `completed`
  in the query (`total > 0 AND done >= total`) and have the dashboard use it.
- **M5 — Progress can be recorded for lessons in draft courses (enrolment.ts).**
  `POST /progress/:lessonId` checks `l.status = 'published'` but not the course.
  `GET /api/courses/lessons/:id` requires the course published, so a lesson in a
  draft course 404s there yet can still be marked complete (and auto-enrols the
  user). Fix: join `courses`, require `co.status = 'published'`.
- **M6 — Video serves lessons of unpublished courses (video.ts).**
  The video lesson lookup filters `l.status = 'published'` but not
  `co.status`, inconsistent with the lesson endpoint. Fix: same join as M5.
- **M7 — Course `visibility` is selected but never enforced (academy.ts, video.ts).**
  The column exists (`'public'|'members'`, default `'members'`) but no code reads
  it, so the access model is ambiguous. Decision: `'public'` courses have fully
  public lessons (no session/enrolment needed); `'members'` (default) keeps the
  current preview-open / enrolment-required gating. Documented here; enforced in
  both the lesson endpoint and the video endpoint.

- **M8 — Video route 404s on keys containing `/` (video.ts).**
  The key charset explicitly allows `/` (and `sync.ts` can set such keys), but
  the Hono route `/:key` only matches a single path segment, so any
  `video_r2_key` with a slash 404'd. Fix: route `/:key{.+}` (verified it matches
  multi-segment keys); the existing charset + `..` sanity check still applies.

### Minor

- **m1** — `enrolment.ts` reads the session twice per request (`requireAuth`
  then `sessionUser`): two D1 session lookups. Collapse to one.
- **m2** — `GET /api/progress` returns enrolments for unpublished/archived
  courses (dashboard shows dead courses). Filter `co.status = 'published'`.
- **m3** — Digest lesson links point at the course page, not the lesson.
  Link `/academy/<course>/<lesson-id>` directly.
- **m4** — Digest "new lessons" uses `lessons.created_at`, so a lesson created
  long ago but published this week is missed. No `published_at` column exists;
  noted, not changed.
- **m5** — Admin bypass (`role !== 'admin'` skip) trusts the role stored in the
  session row, which goes stale if an admin is demoted mid-session. Cross-area
  (auth sessions, F9); noted, not changed — matches the codebase-wide pattern.
- **m6** — `dashboard.astro` `esc()` only escapes `<`. Titles are admin-authored;
  low risk, noted.
- **m7** — `readSession` does not check `users.status`; a suspended member's
  session keeps working. Cross-area (auth); noted, not changed.

## Verified OK (not bugs)

- Preview vs members-only gating **is** enforced server-side: `GET
  /api/courses/lessons/:id` returns 401/403 before any body is sent; the
  client-side "gated unlock" JS only renders after the API allows it with the
  session cookie. Nothing is UI-only.
- Enrolment is idempotent: `INSERT OR IGNORE` on `UNIQUE(user_id, course_id)` —
  double-POST is safe.
- No hotlinking of members-only video: every `GET /api/video/:key` re-checks
  session + enrolment against the lesson that owns the key, and keys with no
  lesson 404 (no bucket enumeration).
- Digest recipients are confirmed subscribers only: double opt-in moves
  `newsletter_subscribers` `pending → active` on token confirm, and the digest
  selects `status = 'active'`. ✓
- Scheduled publishing is idempotent (`UPDATE … SET status='published'`).

## Research notes (best practice applied)

- Workers R2: `bucket.head(key)` for size without body; ranged `get` with
  `{ range: { offset, length } }`. RFC 9110 §14: unsatisfiable range → 416 with
  `Content-Range: bytes */<complete-length>`.
- Cloudflare edge cache never varies on Cookie by default; `Cache-Control:
  private` is the correct signal to keep authenticated responses out of the
  shared cache (browsers may still cache).
- D1 idempotency idiom: `INSERT OR IGNORE` + `meta.changes` check, same as the
  enrolment path already uses.
- D1 has no `IN`-list binding expansion; build placeholders dynamically
  (`module_id IN (?,?,…)`) — safe because placeholders, not values, are
  interpolated.
- Cron retries on Workers are at-least-once: any send loop needs a durable
  dedupe key (here `digest_sends` PK on `(digest_id, email)`).

## Changes implemented (this branch)

1. `api/src/routes/video.ts` — HEAD-before-range, strict range parsing, 416s,
   suffix-range support, `private` cache for gated video, course-published +
   visibility checks, `/:key{.+}` route so keys with `/` resolve.
2. `api/src/routes/academy.ts` — single-query lesson fetch for course detail;
   `visibility='public'` courses serve lessons (and video) without login.
3. `api/src/routes/enrolment.ts` — one session lookup per request; progress
   requires published course; `done_lessons` counts completed + published only;
   enrolments limited to published courses; computed `completed` flag.
4. `api/migrations/0012_digest_sends.sql` — new `digest_sends` table.
5. `api/src/cron.ts` — digest dedupe via `digest_sends` (retry-safe); lesson
   links go straight to the lesson.
6. `site/src/pages/dashboard.astro` — uses the computed `completed` flag.
7. Tests: `api/src/routes/academy.test.ts` (academy + enrolment + video),
   `api/src/cron.test.ts` (digest idempotency).

## Verification

- `npx vitest run` in `api/` — green (236 pre-existing + new tests).
- `npx tsc --noEmit` in `api/` — clean.
- `npm run build` in `site/` — clean (dashboard.astro touched).
- Secret scan before commit — no secrets added.
