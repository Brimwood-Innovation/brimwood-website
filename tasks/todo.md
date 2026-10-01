# Task List: Brimwood Website Full-Stack Build

Index of `tasks/plan.md`. Checkboxes flip only when acceptance + verification both pass.
Legend — scope: XS ≤1 file, S 1–2, M 3–5, L 5–8.

## Phase 1 — foundations

### T1: Monorepo skeleton
**Description:** Create `site/`, `api/`, `admin/`, `docs/`; root README (monorepo map + commands); `.gitignore`; move framework report → `docs/`. No code yet.
**Acceptance:** dirs exist; report reachable at `docs/`; README documents layout.
**Verification:** `git status` clean except intended files; README renders on GitHub.
**Dependencies:** none. **Files:** README.md, .gitignore, docs/. **Scope:** S.

### T2: Wrangler project for brimwood-api
**Description:** `api/wrangler.toml` with staging + production environments, D1/KV/R2 bindings declared (ids filled in T3).
**Acceptance:** `wrangler whoami` succeeds; `wrangler dev` boots the empty worker.
**Verification:** local dev URL responds 200 on `/health`.
**Dependencies:** T1. **Files:** `api/wrangler.toml`, `api/src/index.ts`. **Scope:** S.

### T3: Provision D1 + KV + R2 (staging)
**Description:** Create staging D1 database, KV namespaces (sessions, rate-limit, cache), R2 bucket; record ids in wrangler.toml.
**Acceptance:** `wrangler d1 list` / kv / r2 show the resources.
**Verification:** write+read smoke test against staging D1.
**Dependencies:** T2 (wrangler auth — may need founder via browser). **Files:** `api/wrangler.toml`. **Scope:** XS.

### T4: Connect Pages project to GitHub
**Description:** `brimwood-coming-soon` → GitHub repo, production branch `main`, previews on branches.
**Acceptance:** Pages dashboard shows Git connected; a test branch gets a preview URL.
**Verification:** preview deployment succeeds and serves the site.
**Dependencies:** none (infra-side). **Blocked:** owner sign-in (`adamsayani@outlook.com`) — parked browser task. **Scope:** XS (browser work).

### T5: _headers, privacy + terms pages
**Description:** Security/headers file and `/privacy`, `/terms` pages on the current baseline.
**Acceptance:** headers served on staging; both pages render, brand-styled, Canadian spelling.
**Verification:** `curl -I` shows expected headers; manual page check.
**Dependencies:** T1. **Files:** `site/public/_headers`, `site/src/pages/privacy.astro`, `terms.astro` (or current-baseline equivalents). **Scope:** S.

### T6: GitHub Actions CI — Lighthouse CI on PRs
**Description:** Workflow asserting Core Web Vitals + page-weight budgets (§5) on every PR; red builds block merge.
**Acceptance:** a test PR triggers LHCI; a deliberately heavy page fails the check.
**Verification:** green run on the test PR; branch protection requires the check.
**Dependencies:** T1. **Files:** `.github/workflows/lighthouse.yml`, `lighthouserc.*`. **Scope:** M.

## Checkpoint CP1 — foundations
- [ ] Empty shells build; `wrangler whoami` works; staging D1/KV/R2 reachable
- [ ] CI runs on a test PR
- [ ] Review with founder before proceeding

## Phase 2a — content-site

### T7: Scaffold Astro site, migrate v7 page
**Description:** Astro in `site/`; migrate current `index.html` → Astro with vanilla JS only (no framework runtime).
**Acceptance:** `npm run build` outputs static HTML pixel-equivalent to v7.
**Verification:** visual diff vs production v7; Lighthouse CI green.
**Dependencies:** T1. **Files:** `site/astro.config.mjs`, `site/src/pages/index.astro`, `site/src/styles/brand.css`. **Scope:** M.

### T8: v7 hero as island
**Description:** Living dot-grid engine as `client:load` island on home only; never blocks first paint; `prefers-reduced-motion` → static frame.
**Acceptance:** hero animates on home, absent elsewhere; LCP is text/logo.
**Verification:** Lighthouse LCP ≤ 1.8s target; reduced-motion emulation shows static frame.
**Dependencies:** T7. **Files:** `site/src/components/Hero.*`. **Scope:** S.

### T9: /about page
**Description:** About page from the report §7 design; copy needs founder approval.
**Acceptance:** page renders, on-brand, no income promises / hype language.
**Verification:** founder approves copy at CP2a.
**Dependencies:** T7. **Files:** `site/src/pages/about.astro`. **Scope:** S.

### T10: Blog collections + RSS + 3 seed posts
**Description:** Astro content collections for blog; RSS feed; 3 seed posts (draft copy clearly marked until founder approves).
**Acceptance:** `/blog`, `/blog/[slug]`, `/rss.xml` render; posts carry pillar tags.
**Verification:** RSS validates; 3 posts listed.
**Dependencies:** T7. **Files:** `site/src/content/blog/`, `site/src/pages/blog/`. **Scope:** M.

### T11: /newsletter page + archive
**Description:** Newsletter landing + past-letter archive (titles + excerpts; email-exclusive if founder says so).
**Acceptance:** page renders; archive lists letters or states email-exclusive.
**Verification:** manual check; double opt-in flow still works from the page.
**Dependencies:** T7. **Files:** `site/src/pages/newsletter.astro`. **Scope:** S.

### T12: Countdown retirement
**Description:** After 30 Oct 2026 the home hero becomes evergreen; countdown code removed, not repurposed.
**Acceptance:** post-cutover home has no countdown references.
**Verification:** grep finds no countdown code; page renders.
**Dependencies:** T8. **Scope:** XS. **Note:** scheduled — do not run before the date.

### T13: SEO/AEO/GEO layer
**Description:** Meta + OG/Twitter tags, `sitemap.xml`, `robots.txt`, `llms.txt`, JSON-LD (Organization, BlogPosting), canonical URLs.
**Acceptance:** every public page carries the tag set; sitemap lists all routes.
**Verification:** validator checks pass (rich results test, RSS/llms fetch).
**Dependencies:** T7–T11. **Files:** `site/src/layouts/`, `site/public/`. **Scope:** M.

## Checkpoint CP2a — content-site
- [ ] Staging renders home/about/blog/newsletter; Lighthouse CI green vs §5 budgets
- [ ] Founder approves About copy + seed posts

## Phase 2b — api-data

### T14: Scaffold Hono brimwood-api
**Description:** TypeScript Hono worker; absorb `worker-introduction.js` routes with behaviour parity; define the API contract both phases build against.
**Acceptance:** all four legacy endpoints respond identically to the live worker.
**Verification:** diff of responses live vs staging for each endpoint.
**Dependencies:** T2. **Files:** `api/src/`. **Scope:** M.

### T15: D1 migrations 0001–0004
**Description:** Apply the report §11.2 schema (users, invites, blog, academy, leads, media) to staging D1.
**Acceptance:** all tables exist with the specified constraints.
**Verification:** `wrangler d1 execute --command "SELECT name FROM sqlite_master"` lists them.
**Dependencies:** T3. **Files:** `api/migrations/`. **Scope:** S.

### T16: D1-backed introduction + newsletter
**Description:** Endpoints write to D1 (introduction_requests, newsletter_subscribers, email_log); Resend + branded templates unchanged.
**Acceptance:** form submit → D1 row + both emails, same as today.
**Verification:** end-to-end submit on staging; row present; emails received.
**Dependencies:** T14, T15. **Scope:** M.

### T17: KV→D1 newsletter migration (row-for-row verified)
**Description:** One-shot script migrating KV subscriber state to D1; counts and statuses match exactly before KV reads are retired.
**Acceptance:** `SELECT COUNT(*)` per status matches KV export; zero data loss.
**Verification:** dry-run diff report; founder-visible before/after counts.
**Dependencies:** T15, T16. **Scope:** S.

### T18: Magic-link auth
**Description:** 6-digit codes, 10-min expiry, sessions in KV; codes only to known addresses; rate-limited.
**Acceptance:** code request → email → code → session cookie; unknown emails get no code.
**Verification:** full login on staging; expired/used codes rejected; security review.
**Dependencies:** T14, T15. **Needs:** admin seed email from founder. **Scope:** M.

### T19: /members shell page
**Description:** Auth-gated shell page proving the session works; placeholder for dashboard.
**Acceptance:** signed-in member sees it; anonymous visitors are redirected.
**Verification:** manual login flow on staging.
**Dependencies:** T18. **Scope:** S.

### T20: API metrics endpoint
**Description:** Aggregate metrics endpoint feeding the analytics dashboard (replaces CLI scrape).
**Acceptance:** returns the dashboard's required series; admin-only.
**Verification:** dashboard renders from it on staging.
**Dependencies:** T14, T15. **Scope:** S.

## Checkpoint CP2b — api-data
- [ ] Auth reviewed; test member signs in on staging
- [ ] Introduction lands in D1 + admin inbox; migration counts match KV
- [ ] Review with founder before proceeding

## Phase 3 — academy

### T21: Course/lesson reads
**Description:** Public previews statically rendered; member-only lessons served via API with auth check.
**Acceptance:** preview lesson opens anonymously; full lesson requires session.
**Verification:** anonymous vs member fetch on staging.
**Dependencies:** T13, T18. **Scope:** M.

### T22: Enrolment + progress
**Description:** Enrol + lesson-complete endpoints and UI; progress persisted per user.
**Acceptance:** enrol → progress saved → resume works across sessions.
**Verification:** two-session flow on staging.
**Dependencies:** T21. **Scope:** M.

### T23: R2 video + lesson player
**Description:** 720p uploads to R2, range requests, lightweight player (no heavy framework).
**Acceptance:** video plays, seeks; page stays within weight budget.
**Verification:** playback on mobile profile; Lighthouse still green.
**Dependencies:** T3, T21. **Scope:** M.

### T24: Member dashboard
**Description:** Enrolled courses, progress bars, continue-learning.
**Acceptance:** reflects D1 state accurately.
**Verification:** manual flow as test member.
**Dependencies:** T22. **Scope:** M.

### T25: Scheduled-post cron + weekly digest
**Description:** Cron publishes scheduled posts; weekly digest email via Resend templates.
**Acceptance:** scheduled post goes live on time; digest sends to active subscribers only.
**Verification:** staging cron trigger; test digest received.
**Dependencies:** T16, T20. **Scope:** M.

## Checkpoint CP3 — academy
- [ ] Founder completes a full course end-to-end as a test member on staging

## Phase 4 — admin-cms

### T26: Decap CMS at /admin
**Description:** Decap (MIT) configured for posts + academy tree + media library; GitHub OAuth via small worker.
**Acceptance:** login → edit post → merge → site rebuilds with the change.
**Verification:** full publish cycle on staging.
**Dependencies:** T4 (Git-connected deploys) or preview flow. **Scope:** M.

### T27: Editorial guardrails
**Description:** Pre-publish checks: Canadian spelling, banned phrases (hype/income promises), member-anonymity check, SEO/AEO/GEO checklist.
**Acceptance:** violating draft is blocked with a clear message.
**Verification:** test drafts for each rule.
**Dependencies:** T26. **Scope:** M.

### T28: Invites + subscriber management
**Description:** Admin screens: create invite codes, manage subscribers, triage introduction requests.
**Acceptance:** invite created → code works for the recipient; intro triage updates status.
**Verification:** end-to-end invite flow on staging.
**Dependencies:** T18. **Scope:** M.

### T29: Metrics + audit log
**Description:** Admin screens: traffic/API metrics, audit log of admin actions.
**Acceptance:** actions appear in the log; metrics match the API endpoint.
**Verification:** manual check on staging.
**Dependencies:** T20, T26. **Scope:** M.

## Checkpoint CP4 — admin-cms
- [ ] Founder publishes a blog post with zero developer help

## Phase 5 — launch-hardening

### T30: Turnstile on public forms
**Description:** Cloudflare Turnstile on introduction + newsletter forms.
**Acceptance:** bots blocked, humans unaffected.
**Verification:** simulated bot POST rejected (429/blocked).
**Dependencies:** T16. **Scope:** S.

### T31: Security headers audit
**Description:** Audit `_headers` + worker responses; fix gaps.
**Acceptance:** securityheaders-style scan clean.
**Verification:** scan report attached to the PR.
**Dependencies:** T5. **Scope:** S.

### T32: Backup/restore drill
**Description:** D1 export + restore rehearsal on staging; documented steps.
**Acceptance:** restored staging matches production snapshot.
**Verification:** drill log in `docs/`.
**Dependencies:** T15. **Scope:** S.

### T33: Monitoring, uptime, runbooks, handover
**Description:** Uptime checks, Web Analytics review cadence, runbooks in `docs/`, handover notes.
**Acceptance:** alerts reach the founder; runbooks cover deploy/rollback/restore.
**Verification:** test alert fires.
**Dependencies:** all. **Scope:** M.

### T34: Production cutover — FOUNDER APPROVAL GATE
**Description:** Point production at the new build; verify on brimwoodinnovation.com; retire the zip-upload workflow.
**Acceptance:** production serves the new site; old workflow documented as retired.
**Verification:** founder verifies live site and says go.
**Dependencies:** CP5 checklist. **Scope:** S. **Never runs without explicit founder approval.**

## Checkpoint CP5 — launch
- [ ] Checklist signed; production verified; zip workflow retired
