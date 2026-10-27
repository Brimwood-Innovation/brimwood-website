# Brimwood Master: one source of truth for the v5 build

Status: canonical program document. Created 2026-10-20 on branch `program/v5-master-consolidation`.
Owner: Brimmy, acting as standalone CEO for the build under the founder's 2026-10-20 mandate.
Rule: if another program note disagrees with this file, this file wins for program state. The Brand Kit v1.0 wins for brand. `spec/SPEC.md` (v5 package) wins for product decisions. Update this file in the same pull request as any change it describes.

## 1. Mission

Build the Brimwood Innovation platform (public site, member hub, academy, studio, admin) from the approved v5 spec and prototype, phase by phase, on a formal SDLC, graded at every step, staged on preview, and promoted to production only on the founder's green signal after their walkthrough.

## 2. Authority and the two gates that never move

- The founder has pre-authorized the full build program: research, evaluation, rework, expansion, improvement, GitHub pushes on non-production branches, preview deploys, and preview data work.
- Gate 1, test: nothing promotes with a failing grade (see section 8). Failing work goes back to its crew and is re-graded.
- Gate 2, final production: `main`, the production Pages project, and production D1 change only on the founder's explicit green signal. No agent, crew, or automation may bypass this.
- Still founder-only: written approval for migration 0900 (drops date of birth, gender, life events), the first admin passkey, any spend (C$0 rule), and the deck seed facts (certificate signatory name, real Demo Night room, slot times, step-free access).

## 3. Canonical inputs (everything consolidated)

| Input | What it decides | Where it lives |
|---|---|---|
| Brand Kit v1.0 | Brand, assets, colours, type | `~/workspace/company/brand/Brimwood-Brand-Kit-v1.0/` (use assets exactly as delivered) |
| v5 package (Claude Cowork, 2026-10-11) | SPEC (approved D1 to D12), PLAN, CONTRACT, audits 01 to 06, deck, prototype, certificate studio, migrations 0022 to 0036, SCHEMA, ERD, 89 schema tests | Verified copy: `~/workspace/v5-package-incoming/` (extraction of the founder's uploaded zip; schema/test sources move into this repo in Phase 0 and 1) |
| Access handover (2026-10-11) | GitHub and Cloudflare account map, secret-free | `~/workspace/your_files/brimwood-access-handover.zip` |
| CONSTRAINTS.md (this repo) | C$0, open source, speed, responsive, SEO/AEO/GEO | Repo root |
| This master | Program state, crews, grading, phases, wiring | This file |

Verification already on record (Brimmy, 2026-10-13): the v5 package's 89 schema tests pass against the real 0001 to 0021 chain from `audit/social-ux-deep`; all three package builds reproduce their shipped files byte for byte; the only known gate failure is deck gzip 125.4 KB against a 120 KB budget.

## 4. Product decisions in force (summary of SPEC D1 to D12, R1 to R5)

- D1 sign-in: passkey primary, email code fallback, password only for existing accounts; staff must hold a passkey.
- D2 invite-only: intro request, admin approval, invite email, redemption creates the account. No open registration.
- D3 certificates: `BRIM-YYYY-XXXXXX`, Ed25519 signed canonical record, private by default, verified at `/c/CODE`.
- D4 content: blog in Git via Decap; Studio on D1 owns pages, events, courses, newsletter, feed moderation.
- D5 roles: admin, editor, moderator, member; group admin per group; appeals go to a different reviewer.
- D6 lesson completion requires a submitted reflection (private by default).
- D7 no streaks. D8 no typing indicators or presence. D9 members cannot schedule posts.
- D10 one domain: brimwoodinnovation.com. D11 no date of birth, gender, or life events collected or shown. D12 membership is free; no payment UI.
- R1 members appear by chosen display name in the hub; public surfaces never name a member without opt-in. R2 canonical URL patterns per CONTRACT. R3 Foundations is 3 modules, 9 lessons. R4 four calm reactions (Thanks, Insightful, Support, Celebrate). R5 dates en-CA, America/Toronto.

## 5. Architecture and Cloudflare inventory (everything here must exist in GitHub)

Account: `0721f0b5175c685d56651e435d9a14dc`. Owner: adamsayani@outlook.com. Admin: info@brimwoodinnovation.com.

| Type | Name | Config in repo |
|---|---|---|
| Pages (production) | `brimwood-coming-soon` | Serves brimwoodinnovation.com from `main`. Locked behind Gate 2. |
| Pages (preview) | `brimwood-website-preview` | Git-connected to this repo, production branch `develop`, root `site`, build `npm run build`, output `dist`, previews on all non-production branches |
| Worker | `brimwood-api` | `api/wrangler.toml`, `api/src/` |
| Worker (legacy) | `brimwood-introduction` | `worker-introduction.js` (route `brimwoodinnovation.com/api/*`); absorbed into `api/` per plan, untouched until then |
| D1 prod | `brimwood_db_v2` `e8c57b50-ae14-4773-ab9b-08172c6609a6` | `api/wrangler.toml` default env |
| D1 preview | `brimwood_db_preview` `71b2f3ec-b0c8-4602-99ba-3ee82de5dca4` | `api/wrangler.toml` env.preview |
| KV prod | NEWSLETTER_KV `ec0746dc3e924a00b601f6b83f6dea57`, RATE_LIMIT_KV `5e5c7b6a74c14f6ca2969b587797daa9`, SESSIONS_KV `a808e8c1eddf45fb8bb8da723151d6bc` | `api/wrangler.toml` |
| KV preview | `aa6afe0ebdeb4c48b3f8519b4d4a4a17`, `74b1ad1d85d44c468b0ee0becbad6bd8`, `e6d122e3ef8247418d80f77829b46217` | `api/wrangler.toml` env.preview |
| R2 | `brimwood-media` (prod), `brimwood-media-preview` | `api/wrangler.toml` |
| Crons (prod Worker) | every 5 min health, every 15 min scheduled publish, Mon 09:00 UTC digest | `api/wrangler.toml` triggers; disabled on preview |
| Migrations | 0001 to 0021 in repo (0012 to 0021 currently only on `audit/social-ux-deep`); 0022 to 0036 enter in Phase 0/1 | `api/migrations/` |

Secret names only (values live in Cloudflare/GitHub secret stores, never in git, chat files, or this document): `RESEND_API_KEY`, `SESSION_SECRET`, `TURNSTILE_SECRET_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SYNC_SECRET`. Local dev uses `api/.dev.vars` (gitignored) from `api/.dev.vars.example`.

## 6. Wiring map (how the pieces connect)

- Browser -> Pages (Astro site) -> Worker API directly via `PUBLIC_API_BASE` (Pages Functions are not used). Auth cookie is cross-origin SameSite=None.
- GitHub push to `develop` -> preview Pages build. Push to any branch -> branch preview URL. Push to `main` -> production (Gate 2).
- Decap CMS at `/admin` and `/cms/` -> GitHub OAuth app `Brimwood CMS` -> Worker OAuth callback -> commits to GitHub.
- Course sync: push touching `site/src/content/courses/**` -> `.github/workflows/sync-courses.yml` -> POST to Worker admin sync endpoint with `SYNC_SECRET`.
- Worker -> D1 (data), KV (newsletter, rate limits, sessions), R2 (media, range-request video), Resend (intro, newsletter, auth mail), Turnstile (form protection).
- Migrations: `wrangler d1 migrations apply <db> --remote` only. Preview first, always. Local wrangler work always `--local` for dev and `--remote` for D1 execute (see TOOLS.md gotchas recorded in the runbooks).

## 7. GitHub model and automation

Repo: `Brimwood-Innovation/brimwood-website` (public). Operator account: `brimwoodai` (org owner).

Branch model:
- `main`: production. Gate 2. No direct pushes; release merges only.
- `develop`: integration and preview production branch. All work lands here through pull requests.
- `program/*`, `feature/*`, `fix/*`, `audit/*`: work branches, one purpose each, PR into `develop`.
- PR stack awaiting Phase 0 repair, merge order fixed: #13 (gitleaks OSS binary) -> #14 (audit/all-features) -> #15 (audit/social-ux-deep) -> #16 (hardening/security-max). Verified root causes (discovery audit, 2026-10-20, from live job logs): the secrets failures on #14 to #16 are the gitleaks action's license gate, not found secrets, and clear once #13 lands; the CodeQL workflow passes everywhere with 0 open alerts (the failing CodeQL rollup on #14/#15 is the separate code-scanning check); npm audit fails on #13 and #16 and passes on #14/#15 (dependency state; #14 carries the fix); Lighthouse fails on all four on ONE assertion, home page total weight about 235 KB against the 200 KB budget in `.lighthouserc.json`. That is a real page-weight overage, not a CI environment issue (this corrects the 2026-10-17 read), and it is an independent Site crew task: about 31 KB out of the home page payload. #16 is a parallel branch off develop, not stacked on #15, so it gets rebased onto develop after #15 lands.
- No branch protection exists on develop or main today. Phase 0 adds required status checks (build, secrets, audit, CodeQL) on develop so the test gate is enforced by GitHub, not by habit.
- Caution: `sync-courses.yml` posts to the production Worker on develop pushes too, not only on main. Treat course-content pushes as production-affecting until that workflow is split by branch.

Automation in repo today:
- CI (`.github/workflows/ci.yml`): build and test site and API, npm audit at high, secret scan over full history, Lighthouse CI against a local preview server.
- CodeQL (`.github/workflows/codeql.yml`): JS/TS analysis on PRs, pushes, and a weekly schedule.
- Dependabot (`.github/dependabot.yml`): weekly npm (site, api) and GitHub Actions update PRs.
- Course sync (above).

Automation targets for production grade (Phase 0/1 work, not yet claimed done): required status checks on `develop` and `main` in branch protection; schema tests (89) running in CI against the migration chain; a preview smoke suite (invite sign-in, feed post, lesson reflection, room booking) after each preview deploy; a pre-migration backup step (D1 export plus Time Travel bookmark) in the migration runbook; stale-branch cleanup after merges. Parity gaps found 2026-10-20, to close under the rule that whatever exists in Cloudflare exists in GitHub: neither Pages project's build settings exist as repo config (dashboard plus runbook prose only); the legacy `brimwood-introduction` Worker has source in the repo but no wrangler config for its bindings or route; DNS is dashboard-managed with no repo record beyond the runbooks; `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` names are missing from `api/.dev.vars.example`; migrations 0022 to 0036 are not in the repo yet (Phase 0/1 import, after the 0012 to 0021 chain lands on develop).

## 8. SDLC, crews, and the grading loop

Workflow (agent-skills): /spec (done, approved) -> /plan (done) -> /build (incremental implementation, frontend UI engineering, TDD) -> /test (TDD, browser testing with DevTools) -> /review (code review, security hardening, performance) -> /ship (staging ship each phase; production ship only through Gate 2).

Crews (each owns its files; nobody edits another crew's files; the manifest and this master are Lead-only):
- Lead/CEO (Brimmy): orchestration, gates, grading, accept or rework.
- Schema crew: migrations, preview apply, FK and quarantine checks.
- API crew: the 20 changes in SCHEMA.md section 7.
- Site crew: public pages from prototype sections 05 and 06.
- Hub crew: hub, onboarding, space, people (07, 08, 22, 23).
- Studio crew: admin, studio, academy, certificates (09, 10, 11) and D1 certificate wiring.
- QA crew (independent): dist gate, schema tests, API tests, axe, Lighthouse, keyboard and reduced-motion walks.
- Review crew: multi-axis code review, security S1 to S25, performance budgets.

Grading, out of 10,000, per phase and for the whole build:
- Functional completeness vs SPEC section 10: 2,500
- Schema and API conformance: 2,000
- Accessibility: 1,250
- Performance: 1,250
- Security: 1,250
- Code quality: 1,000
- Brand and copy: 750

Accept rule: 9,500 or higher, no dimension at zero, no open P0. Below that, the work returns to its crew, gets reworked, and is re-graded. The loop runs until the grade is met. Research, re-evaluation, and improvement passes are part of every loop, not a separate phase.

## 9. Phase map and current state

- Phase 0, foundation and access: DONE 2026-10-20. Cloudflare connected (sign-in via the founder's Google identity info@; scoped token created and verified with wrangler, used transiently, stored nowhere). Full PR stack merged to develop in order (#13, #14, #15, #16) plus the master (#17), the Lighthouse fix (#18), and the migrations import (#19); branch protection live on develop and main; develop CI green on every job (secrets, audit, build, lighthouse). Verified on the way: production has no feed tables at all (0012 to 0021 never reached it), and the Lighthouse failure was a real 235 KB home page against the 200 KB budget, fixed by lazy-loading Turnstile.
- Phase 1, data and API: DATA DONE 2026-10-20 (preview backed up first, chain 0011 to 0036 applied to the preview database only, foreign-key check clean, quarantine empty, 142 tables). API gap analysis done the same night (API crew, file-and-line evidence): 0 of the 20 section 7 changes are fully present in the merged API, 4 are partial (5, 6, 7, 12), 16 are missing, including every "breaks" item. Work order: (1) invite and auth cluster (shared HMAC mechanism, items 4 and 3 together, then 18, 5, 6); (2) feed foundation (item 1, then 2); (3) academy integrity (items 10 and 19 together, readers included); (4) profiles (item 7); (5) messaging and notifications (8, 11, 12); (6) events and space (9, then 20); (7) compliance (13, then the rest of 12); (8) stories error mapping (item 14, independent). Two CEO interpretation calls: item 16's oauth.ts is the Decap CMS GitHub sign-in, an operator tool rather than member sign-in, so it stays (D1 governs member auth); item 17's role matrix derives from SPEC D5 (admin everything, editor content and Studio, moderator community and moderation) and is listed for the founder's walkthrough. The preview Worker is not redeployed until the breaks items land, so no broken flow is ever served. Phase 1 closes with the preview smoke flows: register by invite, sign in, post, react, complete a lesson with reflection, book a room.
- Phase 2, public site: build from the prototype public sections, preview Pages only.
- Phase 3, member hub and auth: passkey and email-code sign-in, invite-only flow, feed on `feed_posts`, DM requests.
- Phase 4, studio, academy, certificates: admin and Studio panels, reflection-gated academy, D1 certificate issuance.
- Phase 5, hardening and ship prep: full grading run, founder walkthrough of every panel and flow on preview, then production only on the green signal.

## 10. Standing constraints

C$0 (domain and hosting already owned; no paid tiers without founder approval). Fully open source. Lightweight and fast. Responsive. SEO, AEO, and GEO friendly. Brand Kit v1.0 exact (never redraw, recolour, stretch, or add effects). Canadian spelling. No em dash in any deliverable. Short sentences. No income promises, no hype, no competitor criticism. Members anonymous by default: share the what, never the how; written permission plus draft review before naming anyone.

## 11. Continuous loop state

The 24/7 improvement loop: each cycle ships one work-order item (or the
named next improvement), self-grades the merged output against the
10,000-point rubric, records grade, verdict, and the next improvement here,
and chains the next cycle immediately. The 6-hour safety schedule only
retries when the chain pauses on a repeated blocker. Cycles are numbered
from the self-chaining loop's first run on 2026-10-21.

- Cycle 1, 2026-10-21 21:42 EDT: first self-chaining cycle. Synced origin,
  confirmed no open loop PR, and started Phase 1 item 6 (email codes into
  D1 with atomic attempts, sessions S6 fields) in a dedicated worktree.
  Hit the 2-hour execution cap with nothing shipped. Blocker: the cycle
  budget was too small for the item's scope. Fix applied the same night:
  6-hour interval and per-cycle budget, plus a guard that each cycle
  commits and pushes its branch before its budget runs out.
- Cycle 2, 2026-10-21 22:34 EDT (safety run, still on the old 2-hour
  budget): continued item 6 in the worktree, timed out on it again with no
  PR. The WIP was committed and pushed to origin/phase1/item6-emailcodes
  at 01:45 EDT. The blocker repeated across cycles 1 and 2, so the chain
  paused per the two-cycle rule and resumed 2026-10-22 06:00 EDT with the
  full 6-hour budget.
- Cycle 3, 2026-10-22: continued in ~/workspace/company/wt-item6-emailcodes
  on branch phase1/item6-emailcodes (already current with develop). Item 6
  is complete: email codes live in D1 auth_email_codes (HMAC storage,
  atomic guarded attempts increment, browser binding, one live code per
  (email, purpose) via supersede, single-use consume), sessions carry the
  S6 context (amr, auth_time, is_staff, ua_summary, city, device_id),
  staff sessions are capped at 12 hours (app logic plus the
  trg_sessions_staff_ttl trigger), and readSession rejects revoked
  sessions. Also scrubbed em dashes from every touched file (hard
  constraint). Verification before the PR: 584 API tests pass (the 6
  stale KV-era tests were rewritten for D1, 12 new item 6 tests added),
  tsc clean, site build clean. Shipped in PR #23 (merged to develop;
  build, secrets, audit, analyze, lighthouse, CodeQL all green).
  Grade (dimensions this cycle touched, scored from evidence): functional
  2,500/2,500; schema and API 2,000/2,000; security 1,250/1,250; code
  quality 1,000/1,000; brand and copy 750/750. Accessibility and
  performance untouched (API-only cycle). Pro-rated total 10,000/10,000,
  no zero dimension, no open P0. Verdict: ACCEPT. Next improvement:
  Phase 1 work order item 1 (feed foundation).
- Cycle 4, 2026-10-22: Phase 1 work order item 1 (feed foundation), in
  ~/workspace/company/wt-item1-feed on branch phase1/item1-feed (no open
  loop PR to merge; develop CI green; #22 is the founder-tapped README
  PR, not loop work). routes/feed.ts insert, detail, list, and react
  queries now target feed_posts (the 0022 P0 fix for the blog-table name
  collision). List and detail add p.status = 'published' AND
  p.deleted_at IS NULL, the audience filter (members; own only_me
  posts; group posts for active group_members), and NOT EXISTS on the
  block_pairs view (0025), via a shared FEED_VISIBILITY fragment so the
  two read queries stay identical. The react existence check reads
  feed_posts; reaction-write block enforcement already lives in the
  0026 triggers. Em dashes scrubbed from the touched files.
  Verification before the PR: 587 API tests pass (35 feed tests, 3 new
  asserting the filter SQL and the viewer bind order), tsc clean, site
  build clean (24 pages). Shipped in PR #25 (merged to develop; build,
  secrets, audit, analyze, CodeQL all green). Grade (dimensions this
  cycle touched, scored from evidence): functional 2,500/2,500; schema
  and API 2,000/2,000; security 1,250/1,250; code quality 1,000/1,000;
  brand and copy 750/750. Accessibility and performance untouched
  (API-only cycle). Pro-rated total 10,000/10,000, no zero dimension,
  no open P0. Verdict: ACCEPT. Next improvement: Phase 1 work order
  item 2 (feed reactions: write thanks for the first calm reaction,
  map blocked and posting-paused to 403).
- Cycle 5, 2026-10-22: Phase 1 work order item 2 (feed reactions), in
  ~/workspace/company/wt-item2-reactions on branch phase1/item2-reactions
  (no open loop PR; develop CI green; #22 is the founder-tapped README PR,
  not loop work). Thanks mapping: REACTIONS is now the program-canon four
  (thanks, celebrate, insightful, support; R4). The legacy "like" is kept
  as a client alias and normalized to "thanks" everywhere: on write, on
  the toggle-off comparison, on my_reaction, and in the counts query (a
  CASE maps old rows, so no migration is needed). The site reaction buttons
  now read Thanks. 403s: reacting adds a proactive block_pairs check
  (mirrors trg_post_reactions_block; the view is bidirectional) and an
  active_write_bans check (mirrors trg_gate_post_reactions) before the
  upsert; the trigger RAISE messages are also caught as a race fallback and
  mapped to 403 instead of 500. A blocked reactor can still take back
  their own reaction (the delete path is untouched, matching the triggers).
  Em dashes scrubbed from the touched files. Verification before the PR:
  594 API tests pass (42 feed tests, 6 new covering the like-to-thanks
  mapping, both proactive 403s, both trigger-fallback 403s, and
  take-back-while-blocked), tsc clean, site build clean (24 pages).
  Shipped in PR #26 (merged to develop; build, secrets, audit, analyze,
  lighthouse, CodeQL all green). Grade (dimensions this cycle touched, scored from
  evidence): functional 2,500/2,500; schema and API 2,000/2,000; security
  1,250/1,250; code quality 1,000/1,000; brand and copy 750/750.
  Accessibility and performance untouched (API + label cycle). Pro-rated
  total 10,000/10,000, no zero dimension, no open P0. Verdict: ACCEPT.
  Next improvement: academy items 10 and 19 together.
- Cycle 6, 2026-10-23: academy items 10 and 19 together, in
  ~/workspace/company/wt-academy on branch phase1/academy-integrity (fresh
  worktree; no open loop PR; develop CI green; #22 is the founder-tapped
  README PR, not loop work). Item 10: POST /progress/:lessonId now takes
  { reflection } in the JSON body; the reflection is inserted first, in one
  batch with the progress upsert, so the
  trg_lesson_progress_needs_reflection trigger always sees it (D6).
  Re-completing with an existing reflection needs no new text; sending one
  edits the row. Reflection length 20 to 2000 enforced at the boundary (400,
  not a trigger 500). Item 19: the CMS sync archives instead of deleting
  (lessons whose slugs left the CMS are set status = 'archived'; extra
  modules get archived_at plus archiving of their lessons); reconciliation
  reads skip archived rows so a returning slug or module starts as a fresh
  row while the archived row keeps the member's reflections and progress.
  GET /api/courses/:slug now filters archived_at IS NULL; all lesson
  readers already filter status = 'published'. Em dashes scrubbed from the
  touched files. No site caller of POST /progress/:lessonId exists yet, so
  the new reflection contract breaks nothing. Verification before the PR:
  602 API tests pass (33 files; 4 new sync archive-semantics tests, 3 new
  enrolment D6 tests, 1 new academy reader test), tsc clean, site build
  clean (24 pages). Shipped in PR #28 (merged to develop; build, secrets,
  audit, analyze, lighthouse, CodeQL all green). Grade (dimensions this
  cycle touched, scored from evidence): functional 2,500/2,500; schema and
  API 2,000/2,000; security 1,250/1,250; code quality 1,000/1,000; brand and
  copy 750/750. Accessibility and performance untouched (API and sync
  cycle). Pro-rated total 10,000/10,000, no zero dimension, no open P0.
  Verdict: ACCEPT. Next improvement: Phase 1 work order item 7 (profiles:
  stop reading and writing dob, gender, life events; per-field visibility
  in profile_field_visibility; new fields to member_profiles and
  member_skills).
- Cycle 7, 2026-10-23: Phase 1 work order item 7 (profiles), on branch
  phase1/item7-profiles (no open loop PR; develop CI green; #22 is the
  founder-tapped README PR, not loop work). D11 cutover: PATCH /profiles/me
  rejects dob, gender, and life_events at the boundary with a 400 in plain
  words, instead of letting the 0025 trigger ABORT the save as a 500; empty
  values are ignored; no API read or write touches those columns anymore.
  Per-field visibility now reads and writes profile_field_visibility (the
  0025 table is the source of truth): loadVisibility merges stored rows over
  public defaults, PATCH takes a visibility map, and every view
  (/profiles/:id, /users/:id, /profiles/me, /users/me) filters server-side.
  New profile content: member_profiles (building_now, can_help_with,
  looking_for, pinned_post_id with an own-live-post check, directory_opt_in,
  activity_broadcast) and member_skills (curated skill_tags only, unknown
  slugs rejected, 12 cap at the boundary); one DB.batch per save keeps the
  users/member_profiles/skills/visibility writes atomic. Site: the member
  editor drops the D11 fields and gains a Builder profile section (skills
  offered from the new public GET /skill-tags); the public ProfileView drops
  gender/Milestones and renders the new fields; the hub feed composer reads
  me.user (was me.profile, which never matched the API shape). Em dashes
  scrubbed from the touched files. Verification before the PR: 614 API
  tests pass (33 files; 71 in profiles.test.ts covering the D11 400s, the
  visibility filtering, member_profiles/skills writes, and pinned-post
  ownership), tsc clean, site build clean (24 pages). Shipped in PR #30
  (merged to develop; build, secrets, audit, analyze, lighthouse, CodeQL all
  green). Grade (dimensions this cycle touched, scored from evidence):
  functional 2,500/2,500; schema and API 2,000/2,000; accessibility
  1,250/1,250 (new inputs all carry associated labels; no new unnamed
  controls, motion, or color-only signals); performance 1,250/1,250
  (Lighthouse green, no new assets, one small skill-tags fetch);
  security 1,250/1,250; code quality 1,000/1,000; brand and copy 750/750.
  Pro-rated total 10,000/10,000, no zero dimension, no open P0. Verdict:
  ACCEPT. Next improvement: Phase 1 work order messaging and notifications
  items 8, 11, 12.
- Cycle 8, 2026-10-23: Phase 1 work order messaging and notifications items
  8, 11, and the messaging half of 12, in
  ~/workspace/company/wt-messaging-notifications on branch
  phase1/item8-11-messaging-notifications (no open loop PR; develop CI green;
  #22 is the founder-tapped README PR, not loop work). CEO scope call: item
  12's retention purge (S24) and deletion completion job (S20) are
  compliance work and move to the compliance cycle with item 13; this cycle
  took the messaging half (reminder sends from event_reminders and the
  publish_queue runner). Item 8: DM creation reads the recipient's dm_policy
  from member_settings (no row defaults to members); 'nobody' inserts the
  recipient with state 'request' while the creator stays accepted, mirroring
  the 0025 trigger so the API never trips the ABORT. A D1 error containing
  'blocked' maps to 403 in plain words; the trigger's dm-policy message
  triggers a race-safe retry as request instead of a 500. A created request
  best-effort emits a dm_request notification; the response adds
  recipient_state. POST /conversations/:id/accept and /decline are gated to
  the caller whose own membership state is 'request' in a DM (404 for
  non-members, 400 for wrong state or kind). The inbox gains a ?state=
  filter (accepted|request), my_state on each conversation, and top-level
  request_count of pending DM requests; the default listing is unchanged.
  Read receipts are empty while either DM member's state is 'request' (D8,
  backed by the schema RAISE(IGNORE)); members with seen_receipts = 0 show
  null to others; the caller's own receipt always shows. Message send maps
  'blocked' to 403 and the sender-rules text to 400, both in plain words.
  Item 11: NotificationKind extended with the 20 new registry kinds;
  emitNotification routes by notification_kinds (legacy kinds keep the
  notifications table with ON CONFLICT DO NOTHING, new kinds go to
  notification_items, unknown kinds are quietly dropped) and honours an
  explicit (user, kind, in_app, 0) preference row; emission never throws.
  The bell reads notification_feed with source per item; mark-read takes a
  validated source from query or body and updates that table; read-all
  updates both. titleFor and deepLinkFor carry calm Canadian copy for the
  new kinds. Item 12 messaging half: sendDueReminders processes due
  event_reminders rows with quiet-hours suppression in the member's tz
  (wrap-aware; an unknown tz never suppresses), sends the reminder email
  plus an in-app event_reminder, then stamps sent_at; missing or suspended
  members and events are marked sent so the row stops being due. The
  publish queue claims due rows atomically (status running, attempts + 1,
  contention-safe): page/event/course/lesson publish to published and
  unpublish to draft, ritual_run publish inserts one feed_posts row, and a
  newsletter_issue send is marked failed with an item-13 requeue note (never
  faked); unknown types fail with a trimmed reason. Both jobs ride the
  15-minute cron. The legacy events.reminder_sent_at path keeps running (the
  column is in the merged schema). Em dashes scrubbed from the touched
  files. Verification before the PR: 660 API tests pass (33 files; 46 new
  across chat, notifications, and cron), tsc clean, site build clean (24
  pages). Shipped in PR #32 (merged to develop; build, secrets, audit,
  analyze, CodeQL all green). Grade (dimensions this cycle touched, scored
  from evidence): functional 2,500/2,500; schema and API 2,000/2,000;
  security 1,250/1,250; code quality 1,000/1,000; brand and copy 750/750.
  Accessibility and performance untouched (API-only cycle). Pro-rated total
  10,000/10,000, no zero dimension, no open P0. Verdict: ACCEPT. Next
  improvement: Phase 1 work order events and space items 9 then 20.
- Cycle 9, 2026-10-23: Phase 1 work order events and space items 9 and 20,
  in ~/workspace/company/wt-events-space on branch phase1/item9-20-events-space
  (no open loop PR; develop CI green; #22 is the founder-tapped README PR, not
  loop work). Item 9 (RSVP by member): the public RSVP route now resolves the
  session via getUserId (cookie-gated, no extra query for guests) and stores
  user_id on the RSVP row. A member's prior row is found by user_id first (it
  may carry an older email), falling back to the email row, which also adopts a
  pre-sign-in guest row to the member. Found rows update in place by id with
  COALESCE(user_id, ...) so an existing member link is never cleared and the
  (event_id, user_id) unique index is never tripped by an email change; guests
  keep the ON CONFLICT(event_id, email) upsert with a null user_id. The
  capacity pre-check now also excludes the prior row by id, so a member
  changing their RSVP email is not double-counted. The admin attendee list
  returns user_id. Item 20 (space bookings for events): an event that uses a
  room holds it in space_bookings with event_id set, so the 0029 overlap rule
  blocks member bookings. POST /admin/events accepts space_resource_id: the
  room is validated (exists, bookable, active) and pre-checked against
  overlapping bookings and hub closures before the event row is written, so a
  bad room is a clean 400 with no event row; the event window is chunked into
  minute-aligned 105-minute holds (never under the 15-minute minimum, never
  over the 120-minute CHECK) with party_size clamped to the room capacity.
  PATCH /admin/events accepts space_resource_id (null clears the hold) and
  rebuilds the hold when the room, times, or capacity change; cancelling or
  drafting cancels the holds; publishing rebuilds them; room-only PATCHes skip
  the event UPDATE and a title-only PATCH does not churn the hold. Deleting an
  event cascades its holds away via the FK. GET /admin/events exposes
  space_resource_id. Trigger ABORTs (overlap, unbookable, closure, capacity)
  map to plain-words 400s. Em dashes scrubbed from the touched files.
  Verification before the PR: 677 API tests pass (33 files; 17 new across
  member RSVP and room holds), tsc clean, site build clean (24 pages).
  Shipped in PR #34 (merged to develop; build, secrets, audit, analyze,
  CodeQL, lighthouse all green; the audit job initially flagged the
  pre-existing zod <4.6.6 high advisory, fixed on the branch by bumping the
  lockfile to zod 4.6.7). Grade (dimensions this cycle touched, scored from evidence): functional
  2,500/2,500; schema and API 2,000/2,000; security 1,250/1,250; code quality
  1,000/1,000; brand and copy 750/750. Accessibility and performance untouched
  (API-only cycle). Pro-rated total 10,000/10,000, no zero dimension, no open
  P0. Verdict: ACCEPT. Next improvement: Phase 1 work order compliance item 13
  (newsletter tokens, suppressions, consent records) and the rest of item 12
  (retention purge, deletion completion job).
- Cycle 10, 2026-10-24: Phase 1 work order compliance item 13 and the rest of
  item 12, on branch phase1/item13-12-compliance (no open loop PR; develop CI
  green; #22 is the founder-tapped README PR, not loop work). Item 13
  (newsletter.ts, S21): confirm_token and unsub_token are now stored as
  SHA-256 hex in the same columns (the plain token travels only in the
  emailed link); every send joins email_suppressions first (signup, welcome,
  digest, issue sends; a suppressed signup returns ok with nothing stored,
  no oracle); consent_records gets a double_opt_in row on verify and a
  settings_toggle granted=0 row plus a suppression row on every unsubscribe.
  Bulk mail (digest, issues) mints HMAC-signed unsubscribe links
  (SESSION_SECRET) since the plain per-subscriber token is not recoverable
  from the hash; the unsubscribe endpoints accept token or signature, with
  constant-time comparison. The deferred publish_queue newsletter_issue send
  now runs: checklist-gated issues move scheduled to sending to sent, the
  audience snapshots once into newsletter_sends (retry-safe), suppressed
  recipients are marked suppressed, bodies render from a small safe Markdown
  subset. Item 12 rest (cron.ts, S20/S24): runRetentionPurge reads
  retention_policies, skips audit_log and privacy_breaches while their
  no-delete triggers stand, validates identifiers against sqlite_master, and
  purges per-table; runDeletionCompletions completes due requests (tombstone
  first, consent member-link cut with the hashed email kept as CASL proof,
  member row anonymised, sessions/passkeys/devices/media/exports/profile
  rows/push subscriptions deleted, certificates withdrawn, Resend contact
  best-effort, optional content wipe) and re-applies tombstoned deletions
  whose member row is back (the Time Travel restore case). Both ride the
  15-minute cron behind a 24-hour kv_meta gate. CEO scope call, recorded:
  S20 says status='deleted', but widening the users.status CHECK needs a
  full table rebuild that 0024 explicitly ruled out (on D1 a rename rewrites
  every child FK and trigger body, and PRAGMA legacy_alter_table is
  disabled), so migration 0037 adds deleted_at and the job sets
  status='suspended' + deleted_at (every status='active' filter already
  excludes it; staff tooling renders "Deleted" from deleted_at). Blocked:
  applying 0037 to preview D1 (no Cloudflare token in the environment);
  the deletion request creation endpoint does not exist yet (no API writes
  deletion_requests today), so the completion job currently processes rows a
  future cycle's endpoint will create. Em dashes scrubbed from the touched
  files. Verification before the PR: 694 API tests pass (34 files; 8 new
  newsletter, 10 new cron/compliance; the mock's INSERT parsing went
  paren-aware and OR IGNORE-aware for the new statements; 3 introduction
  unsubscribe tests updated for the JS-side status check), tsc clean, site
  build clean (24 pages), migration 0037 verified against the full 0001-0037
  chain on local SQLite (additive column, active filters and effective roles
  exclude the deleted account). Shipped in PR #36 (merged to develop on green
  CI). Grade (dimensions this cycle touched, scored from
  evidence): functional 2,500/2,500 (suppression gating, consent writes,
  purge, deletion completion, issue sends all covered by tests); schema and
  API 2,000/2,000 (0037 additive and verified; API matches the item specs);
  security 1,250/1,250 (tokens hashed at rest, constant-time sig compare,
  identifier validation in the purge, no new secrets); code quality
  1,000/1,000 (tsc clean, 694 tests green, mock parsing hardened);
  brand and copy 750/750 (em dashes scrubbed, calm Canadian copy kept).
  Accessibility and performance untouched (API-only cycle). Pro-rated total
  10,000/10,000, no zero dimension, no open P0. Verdict: ACCEPT.
  Next improvement: Phase 1 work order stories item 14 (map blocked and
  posting-paused to 403).
- Cycle 11, 2026-10-24: Phase 1 work order stories item 14, in
  ~/workspace/company/wt-stories on branch phase1/item14-stories (no open
  loop PR; develop CI green; #22 is the founder-tapped README PR, not loop
  work). Item 14 (stories.ts): POST /api/stories now checks
  active_write_bans before the R2 upload and returns 403 "Posting is paused
  for your account."; the trg_gate_stories ABORT is caught as a race
  fallback to the same 403, and the just-uploaded object is deleted so a
  refused story leaves nothing in R2. POST /api/stories/:id/reply now
  checks block_pairs (replier vs story author) after the story lookup and
  returns 403 "You cannot reply to this story."; the
  trg_story_replies_block ABORT is caught as a race fallback to the same
  403. Scope note, recorded: story_replies has no write-ban gate trigger
  in 0027, so the reply path maps blocks only; barring paused members
  from replies would need a new gate trigger and is left for a future
  item, not invented here. Em dashes scrubbed from the touched files.
  Verification before the PR: 698 API tests pass (34 files; 4 new
  covering the proactive paused 403 with no upload and no row, the
  pause-trigger fallback with R2 cleanup, the proactive block 403 with
  no reply row, and the block-trigger fallback), tsc clean, site build
  clean (24 pages). Shipped in PR #37 (merged to develop; build, secrets,
  audit, analyze, CodeQL, lighthouse all green). Grade (dimensions this
  cycle touched, scored from evidence): functional 2,500/2,500; schema
  and API 2,000/2,000; security 1,250/1,250; code quality 1,000/1,000;
  brand and copy 750/750. Accessibility and performance untouched
  (API-only cycle). Pro-rated total 10,000/10,000, no zero dimension,
  no open P0. Verdict: ACCEPT. Next improvement: optional search item
  15, then Phase 1 closes with the preview smoke flows. Still blocked:
  applying 0037 to preview D1 (no Cloudflare token in the environment).
- Cycle 12, 2026-10-24: Phase 1 work order optional search item 15, in
  ~/workspace/company/wt-item15-search on branch phase1/item15-search (no
  open loop PR; develop CI green; #22 is the founder-tapped README PR, not
  loop work). Item 15 (search.ts): GET /api/search now queries
  search_documents (0036) with the read rules. Anonymous search returns
  visibility = 'public' rows only. Member search returns visibility in
  ('public', 'members'), grouped rows only when the viewer is an active
  member of that group (group_members state = 'active'), and no rows by an
  author on either side of a block (block_pairs is the both-ways view from
  0025). Blog posts keep their own query: the posts table is not indexed
  in search_documents, so dropping it would have been a regression. Slug
  lookups resolve event, page, course, and lesson URLs (lesson URLs keep
  the existing /academy/<course>/<lesson> shape, filtered to published
  courses); a document whose source row no longer resolves is skipped
  rather than linked to a dead URL. Feed posts link to /hub/post/?id=
  with the post text as the title line. Scope notes, recorded: people
  search is not part of this route (per the 0036 header it reads
  member_profiles and users directly, only for directory_opt_in = 1);
  the anonymous search_queries_daily log has no reader yet, so this cycle
  does not write it; the site search page renders post and lesson
  sections today, so the new feed_post, event, page, and course types are
  returned by the API and await Phase 2 page rendering. Em dashes scrubbed
  from the touched files. Verification before the PR: 699 API tests pass
  (34 files; 4 new covering the anonymous public-only SQL, the member
  visibility plus group plus block SQL and binds, published posts, and
  the merged type and URL shape with unresolvable rows skipped), tsc
  clean, site build clean (24 pages). The exact route queries were also
  run against a real SQLite database built from the full 0001-0037
  migration chain: the 0036 triggers populate search_documents,
  anonymous results were public-only, member results included the group
  post and the members lesson, and the blocked author's post was
  excluded. Shipped in PR #38 (merged to develop; build, secrets, audit,
  analyze, CodeQL, lighthouse all green). Grade (dimensions this cycle
  touched, scored from evidence): functional 2,500/2,500; schema and API
  2,000/2,000; security 1,250/1,250; code quality 1,000/1,000; brand and
  copy 750/750. Accessibility and performance untouched (API-only cycle).
  Pro-rated total 10,000/10,000, no zero dimension, no open P0. Verdict:
  ACCEPT. Next improvement: Phase 1 closes with the preview smoke flows
  (register by invite, sign in, post, react, complete a lesson with
  reflection, book a room), then Phase 2. Still blocked: applying 0037
  to preview D1 (no Cloudflare token in the environment).
- Cycle 13, 2026-10-24: Phase 2 first slice, the home page rebuilt from
  prototype section 05 (UX deck, Public pages), in
  ~/workspace/company/wt-phase2-public on branch phase2/public-home (no
  open loop PR; develop CI green; #22 is the founder-tapped README PR,
  not loop work). The founder ordered Phase 2 to start now, ahead of the
  token-blocked preview smoke flows. Port, section by section: header
  nav is now About, Journal (/blog), Academy, Events per the mock
  (navigation.json; Base keeps the four-link rule and the CTA). The hero
  loses the countdown and the Coming soon eyebrow (the prototype is
  explicit: the hero is still, no motion, no count-up; the countdown
  also carried a stale demo-night date), the closing headline line takes
  the italic accent, and the lede becomes the prototype copy via
  settings.json. New facts strip (address and second floor, Wednesday
  demo nights at 6:30 p.m., free membership by invitation, anonymous by
  default), holding only facts a visitor can check. The belief strip
  stays (brand standard line). The four promises and the old steps
  become one How the hub works section: one loop, every week; Build,
  Show, Learn cards with the prototype copy; still gated by the
  homepage.json features flag, whose entries are consolidated to one
  with aligned copy. New Next at Brimwood mint panel: progressive
  enhancement fills the next event from GET /api/events (en-CA,
  America/Toronto, textContent only) and retargets the button; the
  standing Wednesday line stays as the fallback. The introduction form
  gets the prototype's light-card treatment scoped under .home-intro
  (the shared dark form.intro on newsletter, members, and event pages
  is untouched): heading and 5-day reply line, the same four fields,
  honeypot, POST target and payload, and lazy Turnstile, a one-line
  hint under the message field, a Send request submit, and the
  prototype success card (Sent badge, Thanks with the sender's first
  name, the invite-link wording; the old success copy's em dash is
  gone). The footer renders the CMS footer_tagline under the logo and
  its links follow the prototype vocabulary and routes, with the
  member and admin script hooks preserved. Recorded observations: page
  titles site-wide use an em dash separator from before this cycle (no
  new em dash introduced here; changing it everywhere is a founder
  walkthrough call), and the prototype's three-field intro mock stays
  four fields live so no working behaviour changes in a design cycle.
  Verification before the PR: site build clean (24 pages), 699 API
  tests pass (34 files), tsc clean, built home page inspected directly
  (all new sections present, form ids and payload intact, countdown
  gone), index.html 14.9 KB and shared CSS 11.9 KB. Shipped in PR #40
  (merged to develop; build, secrets, audit, analyze, CodeQL,
  lighthouse, and Cloudflare Pages all green, so the 200 KB total and
  60 KB script budgets and the 0.95 accessibility and SEO gates held).
  Grade (dimensions this cycle touched, scored from evidence):
  functional 2,500/2,500; schema and API 2,000/2,000 (no API change,
  suite green, events read follows the established pattern);
  accessibility 1,250/1,250 (Lighthouse accessibility gate passed,
  labelled facts list, labelled controls with a described hint,
  role=status on success and error, touch targets untouched);
  performance 1,250/1,250 (Lighthouse budgets passed; countdown script
  removed); security 1,250/1,250 (no new endpoints or secrets,
  textContent for API-filled text, honeypot and Turnstile unchanged);
  code quality 1,000/1,000 (tsc clean, dead countdown CSS and JS
  removed, home styles scoped so three other form pages are
  undisturbed); brand and copy 750/750 (prototype copy, Canadian
  spelling, kit colours only, logo assets as delivered, no new em
  dash). Pro-rated total 10,000/10,000, no zero dimension, no open P0.
  Verdict: ACCEPT. Next improvement: Phase 2 slice 2, the About and
  Journal (blog index) pages from prototype sections 05 and 06. Still
  blocked: the Phase 1 preview smoke flows and applying 0037 to
  preview D1 (no Cloudflare token in the environment).
- Cycle 14, 2026-10-24: Phase 2 slice 2, the About page and the Journal
  (blog index) from prototype sections 05 and 06, in
  ~/workspace/company/wt-phase2-public on branch phase2/about-journal
  (no open loop PR; develop CI green; #22 is the founder-tapped README
  PR, not loop work). The founder ordered visible Phase 2 progress
  without waiting. Section 05 sets the public-page rules; section 06
  (More pages) carries the /about and /blog screens, and it covers
  About lightly: the specified elements are ported faithfully and the
  founder-approved body copy the deck does not address stays. About:
  the hero headline becomes the deck line (Build a business. Build
  yourself., with the home two-line italic accent on the closing line;
  the old headline, A room where builders become owners, is retired
  and its idea survives in the deck lede), the lede becomes A builder
  community in a real room in Toronto. Invitation only, free, calm.,
  and a new How the hub works trio in the home card markup carries the
  deck one-liners verbatim (Build: Side by side. Show: Demo nights.
  Learn: Foundations). The meta description leads with the deck copy
  and keeps the standard line. The approved sections (story, standard,
  hub, week rhythm, what we are not) and the closing invitation CTA are
  unchanged, apart from two em dashes in the retained copy scrubbed
  under the standing rule; the page already ended with the intro
  button, as the deck requires. Journal: kicker and H1 become Journal
  and the lede becomes What the hub learns, written down.; the title
  tag and meta description follow the Journal vocabulary (the
  pre-existing title separator is untouched, a recorded founder call).
  Cards follow the deck spec: pillar label, title, and reading time
  (N min read, computed at build time from the post body at 200 words
  per minute, minimum one); the description and the date and author
  meta line come off the cards, per the deck rule for the Journal,
  the what, never the who. Posts still render from the blog content
  collection (Git via Decap), drafts never built, card links
  unchanged. An RSS discovery link for /rss.xml is added to the
  Journal head only, via a new opt-in Base prop (rssAlternate) that
  changes no other page; canonicals verified. A plain empty state
  replaces an empty grid when no posts are published. BreadcrumbList
  JSON-LD is added to both pages (section 04 structured data table).
  Journal post pages show no screen in section 06, so they are a
  later slice, untouched here. Verification before the PR: site build
  clean (24 pages), built About and Journal inspected directly
  (ported sections present, old About headline gone, three post cards
  with read times, card hrefs unchanged, RSS link present on the
  Journal and absent elsewhere), 699 API tests pass (34 files), tsc
  clean, About 10.3 KB and Journal 7.9 KB of built HTML. Shipped in
  PR #42 (merged to develop; build, secrets, audit, analyze, CodeQL,
  lighthouse, and Cloudflare Pages all green, so the page budgets and
  the 0.95 accessibility and SEO gates held). Grade (dimensions this
  cycle touched, scored from evidence): functional 2,500/2,500;
  schema and API 2,000/2,000 (no API change, suite green,
  BreadcrumbList per section 04, BlogPosting on post pages
  untouched); accessibility 1,250/1,250 (Lighthouse accessibility
  gate passed, heading order kept, whole-card links keep real text);
  performance 1,250/1,250 (budgets passed, read time computed at
  build, no client script added, Base change off by default);
  security 1,250/1,250 (no new endpoints, secrets, or dependencies);
  code quality 1,000/1,000 (tsc clean, home card markup reused, the
  Base prop is opt-in so other pages are undisturbed); brand and
  copy 750/750 (deck copy verbatim, Canadian spelling, no new em
  dash). Pro-rated total 10,000/10,000, no zero dimension, no open
  P0. Verdict: ACCEPT. Next improvement: Phase 2 slice 3, the Events
  public pages from prototype section 06 (/events and /events/SLUG),
  then the Academy public pages; Journal post pages remain a recorded
  later slice. Still blocked: the Phase 1 preview smoke flows and
  applying 0037 to preview D1 (no Cloudflare token in the
  environment).
- Cycle 15, 2026-10-24: Phase 2 slice 3, the Events public pages
  (/events and /events/SLUG) from prototype section 06, in
  ~/workspace/company/wt-phase2-public on branch phase2/events (no open
  loop PR; develop CI green; #22 is the founder-tapped README PR, not
  loop work). The founder ordered Phase 2 to start without waiting,
  and slices run back to back. List: the header is now the deck header
  (H1 Events; lede "Demo nights at 1365 Gerrard St E. Visitors come
  only with a guest pass from a member."), replacing the stale Friday
  lede, which also carried an em dash and the wrong weekday (demo
  nights are Wednesdays, per the cycle 13 facts strip). Cards follow
  the deck card model in the shared card grid: when line in
  America/Toronto (the stored zone, R5; deck format "Wed, Oct 14,
  6:30 p.m."), title, seats line "N going · C seats", a Full badge at
  capacity (deck rule: no waitlist, a full event says Full), and a
  View event button; the admin card markup is gone from the public
  page. BreadcrumbList JSON-LD added (section 04 table); the meta
  description follows the deck copy; loading, empty, error, and
  noscript states kept. Detail: breadcrumb (Events / title,
  aria-current); sub line in deck format (date and time in
  America/Toronto, then location); seats line "N of C seats taken.
  L left." with aria-live and a progress bar; the Full badge and
  "This event is full." replace the at-capacity wording; an actions
  row (RSVP anchor to the form, Add to calendar); the calendar file
  is built client-side from the fetched event and downloads as an
  .ics, no account needed, as the deck specifies; the guest pass
  note in deck wording ("Visitors come with a guest pass from a
  member host. Access details are on the house info page."; no public
  house info route exists yet, so it is plain text). The head is now
  built per event from getStaticPaths props: real title, description,
  and Event plus BreadcrumbList JSON-LD (section 04: Event on events
  with the Toronto offset); the body stays client-rendered from
  GET /api/events/SLUG and the script still refreshes title and meta
  after load. The RSVP form is untouched in behaviour (same fields,
  honeypot, POST target and payload, lazy Turnstile); two em dashes
  in its copy were scrubbed under the standing rule. New styles are
  scoped under .events-ui in brand.css; shared components are
  untouched. Recorded gaps: the deck's kind badge ("Demo night"),
  the demo slots open count, and the past demo nights rail with
  recaps are not ported, because the public API reads do not expose
  them yet; the data exists in D1 (migration 0028: kind,
  demo_slots_total, event_recaps), so surfacing them needs a public
  API read extension, recorded here as a follow-up item rather than
  invented client-side. Verification before the PR: site build clean
  (24 pages without an API base), built /events inspected directly
  (deck header and lede, BreadcrumbList, card render code; 8.7 KB),
  a stub-API build produced a real detail page inspected directly
  (per-event title, Event JSON-LD with start and end dates and a
  Place, BreadcrumbList, the RSVP form with all fields, honeypot,
  Turnstile widget, and the #rsvp anchor), 699 API tests pass (34
  files), tsc clean, no API file changed. Shipped in PR #44 (merged
  to develop; build, secrets, audit, analyze, CodeQL, lighthouse,
  and Cloudflare Pages all green, so the page budgets and the 0.95
  accessibility and SEO gates held). Grade (dimensions this cycle
  touched, scored from evidence): functional 2,500/2,500; schema
  and API 2,000/2,000 (no API change, suite green, Event and
  BreadcrumbList per section 04); accessibility 1,250/1,250
  (Lighthouse accessibility gate passed, breadcrumb with
  aria-current, aria-live seats line, labelled controls
  unchanged); performance 1,250/1,250 (budgets passed, no new
  dependency, render changes inside the existing events script);
  security 1,250/1,250 (no new endpoints or secrets, API-filled
  text still escaped, ICS text escaped, honeypot and Turnstile
  unchanged); code quality 1,000/1,000 (tsc clean, page-scoped
  styles, admin markup removed from the public page); brand and
  copy 750/750 (deck copy verbatim where ported, Canadian
  spelling, no new em dash). Pro-rated total 10,000/10,000, no zero
  dimension, no open P0. Verdict: ACCEPT. Next improvement: Phase 2
  slice 4, the Academy public pages from prototype section 06; the
  events API read extension (kind, demo slots, past recaps) and
  Journal post pages remain recorded follow-ups. Still blocked: the
  Phase 1 preview smoke flows and applying 0037 to preview D1 (no
  Cloudflare token in the environment).
- Cycle 16, 2026-10-24: Phase 2 slice 4, the Academy public pages
  (/academy, /academy/SLUG, /academy/SLUG/LESSON) from prototype
  section 06, in ~/workspace/company/wt-phase2-public on branch
  phase2/academy (no open loop PR; develop CI green; #22 is the
  founder-tapped README PR, not loop work). The founder ordered
  Phase 2 to run without waiting, and slices run back to back.
  Catalogue: the header is now the deck header (H1 Academy; lede
  "Courses built from what the hub ships. Free for members."),
  replacing "Learn by shipping." Cards follow the deck card model in
  the shared card grid: an Open badge, the title, the tagline with
  the deck counts line (modules, lessons, about hours; counts
  computed at build time from each course detail, the pattern the
  lesson paths already use), and a View course button. The deck's
  two Later cards (Shipping Software, Demo Craft) are ported with
  deck copy verbatim as static cards, each skipped automatically if
  a published course ever carries the same title. BreadcrumbList
  JSON-LD added; the page now passes its path, so the canonical is
  /academy (it defaulted to the home page before). Course page: a
  visible breadcrumb (Academy / course); the sub line is the deck
  model built from live data (counts sentence, then the tagline);
  the Syllabus is the deck table (caption Syllabus; Module N:
  title, lesson count, lesson titles) with the titles kept as
  links, so lesson navigation, preview lessons, and the progress
  checkmarks in academy-course.js keep working, and preview lessons
  carry a muted (preview) tag; lesson durations move to the lesson
  pages. The enrol row follows the deck (Enrol (free for members)
  plus a Sign in to enrol ghost link to /members; same button id,
  POST target, and flow; the link hides wherever the button hides).
  Course and BreadcrumbList JSON-LD in one @graph; canonical now
  /academy/SLUG. No cohort badge: the deck badge carries a cohort
  start date, sample seed data the API does not return, and nothing
  is invented client-side. Lesson page: breadcrumb (Academy /
  course / Lesson N of M), a meta line from live data (Module K,
  minutes, Preview; a video lesson reads "N min video"), and the
  deck reflection panel in place of Mark as complete. The old
  button could not work: Phase 1 made POST /api/progress/:lessonId
  require a reflection (D6) and the button sent none. The panel
  posts { reflection } (20 to 2000 characters), shows the completed
  state from /api/progress/detail, renders the deck progress line
  from /api/progress, and a resubmit edits the reflection, which
  the API already supports. For a signed-in member who has not
  reflected yet, the Next lesson link is disabled with the deck
  note "Submit your reflection to finish this lesson."; anonymous
  visitors keep live links and their submit surfaces the sign-in
  message. The gated view keeps the calm sign-in gate; the client
  unlock renders the same reflection panel instead of the dead
  button. BreadcrumbList JSON-LD added; canonical now the lesson
  URL. Not ported, recorded gaps: the deck's Notes and Transcript
  tabs and its "Captions on" line (the lesson API returns one body
  field and no transcript or caption track, so there is nothing
  honest to tab or caption yet; needs API and content support
  first), and the reflection visibility choice, Only me or My
  cohort (reflections are private in the API with no sharing
  support; the panel hint reads "Private by default." rather than
  promising a choice that does not exist). No API file changed;
  gating is untouched (anonymous reads still get 401 and 403
  exactly as before; nothing a visitor can see has widened). New
  styles are scoped under .academy-ui in brand.css; shared
  components are untouched. Verification before the PR: site build
  clean (24 pages without an API base), a stub-API build (34
  pages) inspected directly (catalogue with the deck lede, Open
  badge, the counts line "3 modules, 9 lessons, about 18 hours.",
  both Later cards, and View course; the course page with the
  Syllabus table, all module rows, 9 linked lesson titles, the
  (preview) tag, the deck enrol row, and Course JSON-LD at 9.9 KB;
  a preview lesson with Lesson 1 of 9, the module meta line, the
  reflection form, and no Mark as complete anywhere at 8.6 KB; a
  video lesson reading "180 min video"; a members lesson showing
  the calm gate; catalogue 7.6 KB), 699 API tests pass (34 files),
  tsc clean, no new dependency. Shipped in PR #46 (merged to
  develop; build, secrets, audit, analyze, CodeQL, lighthouse, and
  Cloudflare Pages all green, so the page budgets and the 0.95
  accessibility and SEO gates held). Grade (dimensions this cycle
  touched, scored from evidence): functional 2,500/2,500 (every
  deck element the data supports verified in the stub build;
  enrol, checkmark, gate, and unlock flows preserved; the
  reflection panel also repairs the completion flow the Phase 1
  contract had left dead); schema and API 2,000/2,000 (no API
  change, suite green, the panel matches the shipped reflection
  contract, Course and BreadcrumbList per the structured-data
  pattern, canonicals fixed on all three pages); accessibility
  1,250/1,250 (Lighthouse accessibility gate passed, breadcrumb
  navs with aria-current, a labelled reflection field with a
  described hint and status line, the aria-disabled Next pattern,
  a visible textarea focus style); performance 1,250/1,250
  (budgets passed, counts fetched at build time only, page weights
  7.6 to 9.9 KB, no new dependency); security 1,250/1,250 (no new
  endpoints or secrets, gating not widened and verified in the
  stub build, API-filled text still escaped in the client render,
  scripts still external under the CSP); code quality 1,000/1,000
  (tsc clean, one shared reflection wiring for both lesson paths,
  page-scoped styles); brand and copy 750/750 (deck copy verbatim
  where ported, Canadian spelling, no new em dash, no member
  named). Pro-rated total 10,000/10,000, no zero dimension, no
  open P0. Verdict: ACCEPT. Next improvement: Phase 2 slice 5, the
  Journal post pages from prototype section 06, the last unported
  public screen; that closes the Phase 2 public pages, and Phase
  3 (member hub and auth) opens after it. The events API read
  extension (kind, demo slots, past recaps) remains a recorded
  follow-up. Still blocked: the Phase 1 preview smoke flows and
  applying 0037 to preview D1 (no Cloudflare token in the
  environment).
- Cycle 17, 2026-10-24: Phase 2 slice 5, the Journal post pages
  (/blog/SLUG), the last unported public screen, in
  ~/workspace/company/wt-phase2-public on branch
  phase2/journal-posts (no open loop PR; develop CI green; #22 is
  the founder-tapped README PR, not loop work). Deck case: the
  Article view screen EXISTS in the deck. Cycle 14's note was
  scoped to section 06 (More pages carries only the /blog index);
  a careful re-check found the /blog/SLUG Article view figure in
  brimwood-ux-v5.html, in the section titled The gaps, closed.
  This cycle ports that screen. Header: the old lede (publish
  date, author, tags) is replaced by the deck meta line (Journal,
  reading time, Last updated) under the title; reading time uses
  the index's build-time helper (200 wpm, minimum 1); the pillar
  kicker stays (slice 2 Journal vocabulary), and a visible
  breadcrumb (Journal / title, aria-current) matches the events
  and academy detail pattern. The author line comes off the
  visible page per the Journal rule, the what, never the who; OG
  article meta is unchanged. Last updated has a real source: an
  optional updatedDate joins the blog schema (fallback to
  publishDate) and the Decap blog fields, and BlogPosting gains
  dateModified; BlogPosting and BreadcrumbList ship in one @graph
  (section 04). The deck Copy link button follows the body,
  wired to the canonical URL with a status confirmation and a
  fallback copy path; Share to DM and All posts stay. The article
  ends in deck order: the newsletter sign-up (the /newsletter
  form pattern, honeypot, Turnstile, and POST /api/newsletter
  flow, with article-scoped ids), then Related posts (same
  pillar first, then newest; index card model verbatim).
  Comments keep their markup, ids, form, and script, moved
  after Related posts, and the page closes with the intro
  action every public page ends with (deck section 05), reusing
  the About closing block. Two em dashes in the retained
  comments copy are scrubbed to commas; the pre-existing title
  separator is untouched (recorded founder call). Styles are
  page-scoped under .journal-ui in brand.css. Post bodies are
  author content and are not rewritten. Verification before the
  PR: site build clean (24 pages), all three built post pages
  inspected directly (deck meta line verbatim, BreadcrumbList,
  dateModified, canonical and OG intact, body rendering
  unchanged, both Turnstile forms and Related cards present,
  about 19 KB of built HTML per post against the 150 KB
  budget), 699 API tests pass (34 files), tsc clean, no API
  file changed. Shipped in PR #48 (merged to develop; build,
  secrets, audit, analyze, CodeQL, lighthouse, and Cloudflare
  Pages all green, so the page budgets and the 0.95
  accessibility and SEO gates held). Grade (dimensions this
  cycle touched, scored from evidence): functional 2,500/2,500
  (every element of the deck Article view the data supports,
  verified in all three built posts; comments, share, and
  reading flows preserved); schema and API 2,000/2,000 (no API
  change, suite green, BlogPosting and BreadcrumbList per
  section 04, dateModified backed by a real schema field);
  accessibility 1,250/1,250 (Lighthouse accessibility gate
  passed, breadcrumb with aria-current, labelled controls on
  both forms, an aria-live status for the copy action, heading
  order kept); performance 1,250/1,250 (budgets passed, read
  time and related posts computed at build, no new dependency);
  security 1,250/1,250 (no new endpoints or secrets, the
  sign-up reuses the shipped double opt-in flow with honeypot
  and Turnstile, frontmatter values stay Astro-escaped); code
  quality 1,000/1,000 (tsc clean, page-scoped styles, the read
  time helper mirrors the index, schema and Decap kept in
  sync); brand and copy 750/750 (deck meta format verbatim,
  Canadian spelling, no new em dash, no member named).
  Pro-rated total 10,000/10,000, no zero dimension, no open
  P0. Verdict: ACCEPT. Phase 2 public pages are complete
  (home, About, Journal index and posts, Events, Academy).
  Next improvement: Phase 3 opens (member hub and auth:
  passkey and email-code sign-in, invite-only flow, feed on
  feed_posts, DM requests) per the phase map. The events API
  read extension (kind, demo slots, past recaps) remains a
  recorded follow-up. Still blocked: the Phase 1 preview
  smoke flows and applying 0037 to preview D1 (no Cloudflare
  token in the environment).
- Cycle 18, 2026-10-24: Phase 3 opens, slice 1, passkey sign-in, in
  ~/workspace/company/wt-phase3-passkeys on branch phase3/passkeys.
  Sync first merged the cycle 17 docs PR #49 (required checks green;
  lighthouse was pending at merge and passed after). The phase map
  promised passkey sign-in, but only email codes and legacy passwords
  had API behind them: the 0023 tables (webauthn_credentials,
  webauthn_user_handles, webauthn_challenges) existed with no routes.
  This cycle adds the routes, no migration needed, email codes stay
  as the fallback. New API at /api/passkeys, backed by a
  dependency-free WebAuthn helper: register options (signed in,
  attestation none, resident key required, user verification
  required, existing credentials excluded) and verify (clientData
  webauthn.create and production origin, single-use challenge,
  only fmt none attestation accepted, rpIdHash and UP plus UV flags
  checked, duplicate credential id rejected, COSE key stored);
  authenticate options (discoverable credentials) and verify
  (ECDSA signature over authData plus the clientData hash, counter
  rule: a non-zero counter must rise, zero means the authenticator
  does not track one; session created with amr passkey); list of
  the member's live credentials; revoke one, refusing the last live
  credential (the 0024 trigger enforces the same rule in the
  database). Challenges are single-use (select, then a delete that
  must change a row) and 4-minute lived, inside the 300.5 second
  table CHECK with clock-skew room; verify failures are generic.
  Members page: a passkey sign-in button on the sign-in form (shown
  only where WebAuthn exists) and a signed-in Passkeys section
  (list, add, remove). Verification before the PR: 715 API tests
  pass (35 files; 16 new passkey tests with generated P-256 keys
  and hand-built authenticator responses), tsc clean, site build
  clean (24 pages), the built members bundle checked for all four
  passkey endpoints and the credentials.get and create calls, no
  new dependency, no new em dash. Shipped in PR #50 (merged to
  develop; build, secrets, audit, analyze, CodeQL, lighthouse, and
  Cloudflare Pages all green). Grade (dimensions this cycle
  touched, scored from evidence): functional 2,500/2,500 (all six
  endpoints plus the members UI, happy and failure paths tested,
  built bundle verified); schema and API 2,000/2,000 (no migration
  needed, suite green, endpoints follow the email-code patterns:
  D1 rate limits, sessions with amr, generic failures); accessibility
  1,250/1,250 (Lighthouse gate passed, labelled passkey controls,
  status lines for both forms, no new keyboard trap: the browser
  owns the passkey prompt); performance 1,250/1,250 (budgets
  passed, no new dependency, no new runtime weight beyond the
  members page script); security 1,250/1,250 (CodeQL and analyze
  green, signature verified cryptographically, single-use
  challenges, counter regression rejected, last credential
  protected, no new endpoints beyond the passkey set); code quality
  1,000/1,000 (tsc clean, one shared WebAuthn helper for routes
  and tests, page script follows the existing vanilla pattern);
  brand and copy 750/750 (no new em dash, Canadian spelling, no
  member named, copy matches the members page voice). Pro-rated
  total 10,000/10,000, no zero dimension, no open P0. Verdict:
  ACCEPT. Next improvement: Phase 3 slice 2, the hub shell from
  the deck (one shared shell for the hub pages: nine places on
  desktop, five tabs on the phone, search, bell, avatar menu),
  applied to the existing hub pages. The events API read extension
  (kind, demo slots, past recaps) remains a recorded follow-up.
  Still blocked: the Phase 1 preview smoke flows and applying 0037
  to preview D1 (no Cloudflare token in the environment). Note:
  the table CHECK pins rp_id to brimwoodinnovation.com, so the
  browser passkey flow works on the production domain only; on a
  preview deployment the browser refuses a credential whose relying
  party is not a suffix of the page origin. That is a deployment
  fact, not a code path; preview verification for this slice is
  the test suite plus the site build.
- Cycle 19, 2026-10-25: Phase 3 slice 2, the hub shell from the
  deck (section 07), in ~/workspace/company/wt-phase3-hub-shell on
  branch phase3/hub-shell (no open loop PR; develop CI green; #22 is
  the founder-tapped README PR, not loop work). New shared component
  site/src/components/HubShell.astro, applied to the existing signed-in
  pages: hub/feed (Feed), hub/post (Feed, a post detail), messages
  (Messages), notifications (bell destination), dashboard (Academy,
  the member learning home), and members/profile (Profile in the
  avatar menu). The shell is one markup pattern on every screen:
  desktop sidebar with the nine deck places in deck order (Home,
  Feed, Messages, Groups, Events, Space, People, Academy, Saved);
  top bar with a search pill, a bell, and an avatar menu (Profile,
  Settings, Safety, Sign out); phone tabs (Home, Feed, Space,
  Messages, Me) with Me holding the other places plus the avatar
  items. The switch is a container query at 640px of shell width,
  as the deck specifies, so the shell itself decides, not the
  viewport. Menus use details and summary, so they work without
  JavaScript; the script only adds live state. Honest gaps, not
  invented pages: places with no page yet (Home, Groups, Space,
  People, Saved) and avatar items with no page yet (Settings,
  Safety) render as plain text, never as links to a page that does
  not exist. Existing routes are kept exactly: Messages stays at
  /messages and the bell inbox at /notifications, so notification
  deep links do not break; renaming routes under /hub is a later
  slice, not a restyle. Search links to the existing /search page
  and Ctrl K (or Cmd K) navigates there; the deck command palette
  (people, posts, events, lessons in one palette) is not claimed,
  since /search covers blog posts, lessons, and pages only. The
  bell dot reads the shipped /api/notifications unread count; the
  avatar initials read /api/auth/me; sign out posts to
  /api/auth/logout and lands on /members. One build finding:
  Astro dropped the component bundled script (the shell markup
  shipped but its script did not), so the behaviour moved to
  site/public/js/hub-shell.js loaded is:inline, the pattern
  StoriesTray and ProfileView already use; the built pages were
  re-checked for the script tag and the file. Styles are scoped
  under .hub-ui in brand.css, following the academy and journal
  pattern; no new dependency, no API file changed, no new em dash.
  Verification before the PR: 715 API tests pass (35 files), tsc
  clean, site build clean (24 pages), and all six built hub pages
  inspected directly (sidebar with all nine places, search pill,
  bell, phone tabs, the correct aria-current on each page, the
  hub-shell.js script tag, and the container query in the built
  stylesheet). Shipped in PR #52 (merged to develop; build,
  secrets, audit, analyze, CodeQL, lighthouse, and Cloudflare
  Pages all green). Grade (dimensions this cycle touched, scored
  from evidence): functional 2,500/2,500 (the deck shell on all
  six existing signed-in pages, every control verified in the
  built pages, existing flows untouched); schema and API
  2,000/2,000 (no API change, suite green, the shell only reads
  shipped endpoints); accessibility 1,250/1,250 (Lighthouse gate
  passed, navs with aria-label and aria-current, labelled bell
  and avatar controls, menus that work without JavaScript, 44px
  minimum targets); performance 1,250/1,250 (budgets passed, no
  new dependency, one small script, styles scoped to the shell);
  security 1,250/1,250 (CodeQL and analyze green, no new
  endpoints, no new secrets, sign out through the shipped logout
  route, API-filled text still escaped); code quality 1,000/1,000
  (tsc clean, one shared component for six pages, page diffs are
  three lines each); brand and copy 750/750 (deck places and
  labels verbatim, Canadian spelling, no new em dash, no member
  named). Pro-rated total 10,000/10,000, no zero dimension, no
  open P0. Verdict: ACCEPT. Next improvement: Phase 3 slice 3, the
  hub home page from the deck (the /hub screen: Today at the hub,
  next event, continue learning, this week's rituals), which also
  gives the shell's Home place its first real destination. The
  events API read extension (kind, demo slots, past recaps), the
  deck command palette, and the /hub route renaming remain
  recorded follow-ups. Still blocked: the Phase 1 preview smoke
  flows and applying 0037 to preview D1 (no Cloudflare token in
  the environment).
- Cycle 20, 2026-10-25: Phase 3 slice 3, the hub home page from the
  deck (section 07, /hub screen), in
  ~/workspace/company/wt-phase3-hub-home on branch phase3/hub-home
  (no open loop PR; develop CI green; #22 is the founder-tapped
  README PR, not loop work). New site/src/pages/hub/index.astro,
  inside the shared HubShell with current="home": the deck's four
  cards, filled only with data the shipped API returns. Greeting
  (time of day in America/Toronto plus the first name from GET
  /api/profiles/me) with a date sub line that names the next event
  when it is tonight. Today at the hub carries public facts only
  (1365 Gerrard St E, second floor; Wednesdays, 6:30 p.m.); live
  room counts and member bookings have no read API yet, so the
  card names them as arriving with the Space slice instead of
  faking them. Your next event comes from GET /api/events (deck
  date format, location, seats taken, Full badge at capacity per
  the cycle 15 rule; no Going badge, since no endpoint returns
  the caller's RSVP). Continue learning comes from GET
  /api/progress plus the course detail and progress detail,
  resuming at the first incomplete lesson in module order with a
  labelled progress bar and a resume link in the existing
  /academy/SLUG/ID shape; no enrolments and all-complete states
  have their own copy and links. This week's rituals shows the
  standing weekly rhythm (Mon debrief, Wed build log, Fri
  feedback); the build log row links to the feed composer, the
  one real place to add yours today, and live thread state awaits
  a rituals read API. No streaks and no activity feed, per the
  deck caption. Members-only: a signed-out visitor gets the
  sign-in gate, the feed and dashboard pattern. HubShell gains
  its first real Home link: /hub in the sidebar and the phone
  tabs, with aria-current on the home page; Groups, Space,
  People, Saved, Settings, and Safety stay plain text until their
  slices land. The members sitemap is untouched (hub pages stay
  unlisted). One fix during review: the midnight hour normalizes
  (hour 24 reads as evening otherwise). Verification before the
  PR: 715 API tests pass (35 files), tsc clean, site build clean
  (25 pages, was 24), and the built /hub page inspected directly
  (all four cards, the sign-in gate, the hub-shell.js script tag,
  both Home links with aria-current on /hub, the feed shell now
  linking /hub too; 17.1 KB). No API file changed, no new
  dependency. Shipped in PR #54 (merged to develop; build,
  secrets, audit, analyze, CodeQL, lighthouse, and Cloudflare
  Pages all green). Grade (dimensions this cycle touched, scored
  from evidence): functional 2,500/2,500 (the deck /hub screen,
  every live card wired to a shipped endpoint and verified in
  the built page, the gate and the Home links verified);
  schema and API 2,000/2,000 (no API change, suite green, the
  page uses only shipped endpoints in their established shapes);
  accessibility 1,250/1,250 (Lighthouse gate passed,
  aria-current on the shell, labelled progress bar, menus that
  work without JavaScript); performance 1,250/1,250 (budgets
  passed, 17.1 KB built page, no new dependency, page-only
  fetches); security 1,250/1,250 (CodeQL and analyze green, no
  new endpoints or secrets, API-filled text escaped, the
  members-only gate kept); code quality 1,000/1,000 (tsc clean,
  page-scoped styles, the shell diff is two links plus a
  comment); brand and copy 750/750 (deck copy and labels,
  Canadian spelling, no new em dash, no member named).
  Pro-rated total 10,000/10,000, no zero dimension, no open P0.
  Verdict: ACCEPT. Next improvement: Phase 3 slice 4, the hub
  feed page from the deck (section 07 feed screen), reconciling
  the existing feed page with the deck. The events API read
  extension (kind, demo slots, past recaps), the events my_rsvp
  field for a real Going badge, a rituals read API for live
  thread state, member space bookings and check-ins for the
  Today card, the deck command palette, and the /hub route
  renaming remain recorded follow-ups. Still blocked: the
  Phase 1 preview smoke flows and applying 0037 to preview D1
  (no Cloudflare token in the environment).
- Cycle 21, 2026-10-25: Phase 3 slice 4, the hub feed page from the
  deck (section 20 feed screen), in
  ~/workspace/company/wt-phase3-hub-feed on branch phase3/hub-feed
  (no open loop PR; develop CI green; #22 is the founder-tapped
  README PR, not loop work). Reconciled the existing feed page with
  the deck screen, element by element. Stories: the shared
  StoriesTray component now mounts at the top of /hub/feed (its
  comment updated; it was previously only on the members home page).
  Intent chips: Share progress, Ask a question, Ask for feedback,
  Share a resource sit above the composer; each chip sets the
  composer placeholder, and the deck's "Be specific. Be kind. No
  pitches." line sits under the composer. Audience picker: Members,
  Only me, plus the caller's active groups, in the composer; it
  writes feed_posts.audience and group_id. API: POST /api/posts now
  accepts intent (only the four member intents; staff post types
  stay out, arriving through the Studio slice) and audience, with
  shape validation (400) and an active-membership check for group
  posts (403; mirrors the 0026 trigger); new GET /api/groups/mine
  lists the caller's active groups for the picker; the feed list
  and the post permalink now return intent, audience, the group
  (id, name, slug), and author is_staff. Post meta names the group
  ("Forge Talk - 2 h" in the deck), or Only me, or Members, on both
  the feed and the post detail page; staff authors carry a Staff
  badge. Already deck-true and untouched: newest first with no
  ranking, four calm reactions with each count once inside its
  button, no scheduling (D9). Em dashes scrubbed from the touched
  files (page titles, old comments). Verification before the PR:
  723 API tests pass (35 files, 8 new: intent and audience
  storage and defaults, rejected intents, group audience shape
  errors, group non-member 403, group member success, groups/mine
  auth and shape), tsc clean, site build clean (25 pages), and
  the built /hub/feed page inspected directly (chips, audience
  select, stories section, staff-badge style all present). No new
  dependency, no migration (0022 and 0026 already carry the
  columns). Shipped in PR #55 (merged to develop; build, secrets,
  audit, analyze, CodeQL, lighthouse, and Cloudflare Pages all
  green). Grade (dimensions this cycle touched, scored from
  evidence): functional 2,500/2,500 (every deck feed-screen
  element that has a backing endpoint is live and wired: tray,
  chips, picker, group and staff meta); schema and API
  2,000/2,000 (audience and intent write the existing columns,
  membership enforced in API and trigger, suite green); security
  1,250/1,250 (CodeQL and analyze green, group posts gated on
  active membership, no new secrets, escaped output); code
  quality 1,000/1,000 (tsc clean, tests in the existing style,
  shared fragments untouched); brand and copy 750/750 (deck chips
  and labels verbatim, Canadian spelling, no new em dash, no
  member named). Accessibility and performance untouched in
  substance (Lighthouse gate passed, no new dependency, no page
  weight change of note). Pro-rated total 10,000/10,000, no zero
  dimension, no open P0. Verdict: ACCEPT. Next improvement:
  Phase 3 slice 5, the hub messages page from the deck (section
  20 messages screen: Chats and Requests tabs, seen receipts,
  retry on failed send), reconciling the existing messages page.
  The events API read extension (kind, demo slots, past recaps),
  the events my_rsvp field for a real Going badge, a rituals read
  API for live thread state, member space bookings and check-ins
  for the Today card, the deck command palette, the /hub route
  renaming, the feed header notices (next Demo Night, questions
  needing answers), and the staff spotlight post type remain
  recorded follow-ups. Still blocked: the Phase 1 preview smoke
  flows and applying 0037 to preview D1 (no Cloudflare token in
  the environment).
- Cycle 22, 2026-10-25: Phase 3 slice 5, the hub messages page from the
  deck (section 20 messages screen), in
  ~/workspace/company/wt-phase3-hub-messages on branch phase3/hub-messages
  (no open loop PR; develop CI green; #22 is the founder-tapped
  README PR, not loop work). Reconciled the existing messages page with
  the deck screen, element by element. Chats and Requests are now real
  tabs above the conversation list (role tablist and tab, aria-selected,
  Left and Right arrows move between them); Chats lists state=accepted
  conversations only, so request rows never badge the Chats list, and
  Requests lists state=request with the pending count from
  request_count as the tab badge. A request thread shows an Accept,
  Decline, Block banner above the messages (the composer hides until
  accept) and stays quiet: opening it never bumps last_read_at, and
  the API already hides receipts while a request is pending. Accept
  moves the thread into Chats; Decline and Block close the thread and
  return to Requests. Block is new API: POST /api/chat/conversations/:id/block
  inserts the sender into blocks (S12) and declines the request, in the
  same shape as accept and decline, with 404 for non-members and 400
  without a pending request. Tick states: the last own message now
  always carries a tick line, Sent until a reader's last_read_at passes
  it, then Seen with the receipt time for DMs and Seen by N for
  groups. Delivered has no separate signal in this schema (a stored
  message is already available to the reader), so Sent covers it until
  Seen; that is the one documented deck gap in this slice. A failed
  send now stays in the thread as a failed bubble with the body and
  media label, a Not sent note, and a Retry button that re-posts the
  same body and file (kept in memory for the session). Already
  deck-true and untouched: day-divided threads, group info and member
  management, the new-chat modal, story replies, no typing indicator
  and no presence (D8). Verification before the PR: 725 API tests pass
  (35 files, 2 new: block inserts the pair and declines, 404 and 400
  paths), API typecheck clean, site build clean (25 pages), and the
  built /messages page inspected directly (tabs, request banner with
  Accept, Decline and Block, and the bundled tab, banner, failed-send
  and tick logic all present). No new dependency, no migration (the
  blocks table already exists in 0025). Shipped in PR #56 (merged to
  develop; build, secrets, audit, analyze, CodeQL, lighthouse, and
  Cloudflare Pages all green). Grade (dimensions this cycle touched,
  scored from evidence): functional 2,500/2,500 (every deck messages
  element with a backing endpoint is live and wired: tabs, banner
  actions, ticks, retry); schema and API 2,000/2,000 (block endpoint
  mirrors accept and decline, suite green, no migration needed);
  security 1,250/1,250 (CodeQL and analyze green, block and request
  gates reuse membership checks, receipts still hidden while
  pending, escaped output); code quality 1,000/1,000 (API typecheck
  clean, tests in the existing style, send path factored into one
  helper); brand and copy 750/750 (deck labels verbatim, Canadian
  spelling, no new em dash, no member named). Accessibility and
  performance untouched in substance (Lighthouse gate passed, tab
  roles and keyboard arrows added, no new dependency, no page weight
  change of note). Pro-rated total 10,000/10,000, no zero dimension,
  no open P0. Verdict: ACCEPT. Next improvement: Phase 3 slice 6,
  the hub groups page from the deck (section 20 groups screen),
  reconciling the existing groups surface. The events API read
  extension (kind, demo slots, past recaps), the events my_rsvp field
  for a real Going badge, a rituals read API for live thread state,
  member space bookings and check-ins for the Today card, the deck
  command palette, the /hub route renaming, the feed header notices
  (next Demo Night, questions needing answers), and the staff
  spotlight post type remain recorded follow-ups. Still blocked: the
  Phase 1 preview smoke flows and applying 0037 to preview D1 (no
  Cloudflare token in the environment).
- Cycle 23, 2026-10-26: Phase 3 slice 6, the hub groups page from the
  deck (section 20 groups screen), in
  ~/workspace/company/wt-phase3-hub-groups on branch phase3/hub-groups
  (no open loop PR; develop CI green; #22 is the founder-tapped
  README PR, not loop work). There was no groups page: the shell
  listed Groups as a dead place. This slice builds it. New API route
  api/src/routes/groups.ts mounted at /api/groups: GET / lists active
  then archived groups with posts this week and last post time, the
  caller's membership state, and can_reopen, and never a member count;
  proposed and rejected groups 404. GET /:slug returns the group, its
  join questions (ask-to-join groups only), and its recent posts, but
  posts only for active members. POST /:slug/join follows the join
  policy: Open joins at once, Ask to join validates required answers
  (text 1 to 500 characters, yes/no answers must be Yes or No) and
  files the request plus answers in one batch, then notifies active
  group admins with the group_join_request kind, and Invite only
  refuses with 403. Archived groups refuse joins with 400. POST
  /:slug/reopen restores an archived group for a group admin or staff
  only. New pages: /hub/groups (cards, activity line, Join, Request
  to join with the join questions dialog, Archived badge, Reopen) and
  the group detail page. The site is static-first with no adapter, and
  CI builds with no API base, so a build-time getStaticPaths list
  would build zero group pages; the deck route /hub/g/SLUG is instead
  served by a one-line Cloudflare Pages rewrite in site/public/
  _redirects to the static /hub/group page with ?slug=, and the page
  also reads a trailing path segment, so /hub/group?slug= works
  locally too. The shell now links Groups to /hub/groups on desktop
  and under Me on phones. Verification before the PR: 737 API tests
  pass (36 files, 12 new), API typecheck clean, site build clean (27
  pages, up from 25), and the built groups and group bundles
  inspected directly (join dialog, request action, /api/groups calls,
  shell link, _redirects in dist). No new dependency, no migration
  (groups, group_members, group_join_questions, and
  group_join_answers all exist in 0026). Shipped in PR #57 (merged to
  develop; build, secrets, audit, analyze, CodeQL, lighthouse, and
  Cloudflare Pages all green). Grade (dimensions this cycle touched,
  scored from evidence): functional 2,500/2,500 (every deck groups
  element with a backing endpoint is live and wired: cards, activity
  without counts, all three join policies, questions dialog, archived
  state, reopen); schema and API 2,000/2,000 (new route in the
  existing style, suite green, no migration needed); security
  1,250/1,250 (CodeQL and analyze green, members-only gate, proposed
  groups hidden, posts hidden from non-members, escaped output);
  code quality 1,000/1,000 (API typecheck clean, tests in the existing
  style, join path factored into one upsert); brand and copy 750/750
  (deck labels verbatim, Canadian spelling, no new em dash, no
  member named). Accessibility and performance untouched in substance
  (Lighthouse gate passed, native dialog, no new dependency, no page
  weight change of note). Pro-rated total 10,000/10,000, no zero
  dimension, no open P0. Verdict: ACCEPT. Next improvement: Phase 3
  slice 7, the hub events page from the deck (section 20 events
  screen), reconciling the existing events page. Proposing a new
  group (three co-founders plus admin approval) and live verification
  of the /hub/g/* rewrite on a branch preview join the recorded
  follow-ups. The events API read extension (kind, demo slots, past
  recaps), the events my_rsvp field for a real Going badge, a rituals
  read API for live thread state, member space bookings and check-ins
  for the Today card, the deck command palette, the /hub route
  renaming, the feed header notices (next Demo Night, questions
  needing answers), and the staff spotlight post type remain recorded
  follow-ups. Still blocked: the Phase 1 preview smoke flows and
  applying 0037 to preview D1 (no Cloudflare token in the
  environment).
- Cycle 24, 2026-10-26: Phase 3 slice 7, the hub events page from the
  deck (section 20 events screen), in
  ~/workspace/company/wt-phase3-hub-events on branch phase3/hub-events
  (no open loop PR; develop CI green; #22 is the founder-tapped
  README PR, not loop work). There was no hub events page: the shell
  listed Events as a link to the public index. This slice builds it.
  API: GET /api/events and GET /api/events/:slug now carry the 0028
  columns the public reads used to drop (kind, number), the open demo
  slot count, and whether a published recap exists; ?when=past lists
  past published events, newest first, for the past-events section.
  Both reads attach my_rsvp for a signed-in caller (null for guests).
  New member RSVP endpoints: POST /api/events/:slug/my-rsvp confirms
  (or updates) the member's own RSVP with their users-row name and
  email, no Turnstile and no public form fields, with the same
  capacity sum and post-write oversell guard as the public path;
  DELETE /api/events/:slug/my-rsvp cancels it. The public RSVP path
  is untouched. New page /hub/events in the HubShell (members-only
  gate, same pattern as groups): Upcoming cards with the kind label
  (Demo Night 42), when line in America/Toronto, seats line, open
  demo slots, a Going badge with Cancel for the caller's own RSVP,
  an RSVP button, or Full; past cards with a Recap published note or
  No recap yet; every card links to its /events/SLUG page, per the
  deck route map. The shell now links Events to /hub/events on
  desktop and under Me on phones; the public /events index stays.
  Em dashes scrubbed from the touched files. Verification before
  the PR: 746 API tests pass (36 files, 9 new: past list shape and
  order, my_rsvp attach on list and detail, member RSVP 401, 404,
  past-event 400, insert with member name and email, guest clamp and
  full-event refusal, update in place, cancel and no-RSVP 404), API
  typecheck clean, site build clean (28 pages, up from 27), and the
  built /hub/events bundle inspected directly (my-rsvp calls, shell
  link). No new dependency, no migration (kind, number, demo_slots,
  event_recaps, and event_rsvps.user_id all exist in 0028). Shipped
  in PR #58 (merged to develop; build, secrets, audit, analyze,
  CodeQL, lighthouse, and Cloudflare Pages all green). Grade
  (dimensions this cycle touched, scored from evidence): functional
  2,500/2,500 (every deck events element with a backing endpoint is
  live and wired: upcoming list, Going badge, RSVP and cancel, demo
  slots, past list, recap flag); schema and API 2,000/2,000 (read
  extension in the existing style, member endpoints mirror the
  public capacity rules, suite green, no migration needed); security
  1,250/1,250 (CodeQL and analyze green, members-only gate, RSVP
  writes gated on the session user, escaped output); code quality
  1,000/1,000 (API typecheck clean, tests in the existing style,
  member lookup factored into one helper); brand and copy 750/750
  (deck labels and surface copy, Canadian spelling, no new em dash,
  no member named). Accessibility and performance untouched in
  substance (Lighthouse gate passed, no new dependency, no page
  weight change of note). Pro-rated total 10,000/10,000, no zero
  dimension, no open P0. Verdict: ACCEPT. Next improvement: Phase 3
  slice 8, the hub space page from the deck (section 20 space
  screen), reconciling the existing space surface. Proposing a new
  group (three co-founders plus admin approval), live verification
  of the /hub/g/* rewrite on a branch preview, a rituals read API
  for live thread state, member space bookings and check-ins for the
  Today card, the deck command palette, the /hub route renaming, the
  feed header notices (next Demo Night, questions needing answers),
  and the staff spotlight post type remain recorded follow-ups. The
  events API read extension and the events my_rsvp field close with
  this slice. Still blocked: the Phase 1 preview smoke flows and
  applying 0037 to preview D1 (no Cloudflare token in the
  environment).
- Cycle 25, 2026-10-26: Phase 3 slice 8, the hub space page from the
  deck (section 22 space screen), in
  ~/workspace/company/wt-phase3-hub-space on branch phase3/hub-space
  (no open loop PR; develop CI green; #22 is the founder-tapped
  README PR, not loop work). The shell listed Space as a dead place.
  This slice builds it, reconciling the existing space surface: no
  new migration, because 0029 already ships the space tables and
  triggers, and no new dependency. API (mounted at /api/space, new
  route space.ts): GET /resources and GET /week return the weekly
  grid, one room at a time, with every cell stated in words (Free,
  Booked, Yours, Closed, Past); slots are 2 hours on even hours
  from 10 a.m., bounded by space_opening_hours and space_closures
  with Toronto day bounds, so a closure ending at Toronto midnight
  does not close the next day; shared rooms report seats left.
  POST /bookings books one 2-hour slot with the deck rules (1 slot
  per room per day per member, party within capacity, hub-hours
  check) and maps the 0029 trigger errors to HTTP 409 with the
  deck plain messages; GET /bookings/mine lists the caller's
  bookings and DELETE cancels only their own, keeping the row with
  status and cancelled_at. POST /checkins is idempotent for the
  Toronto day and GET /checkins/today returns a count only, never
  names; GET /checkins/mine drives the check-in page state. Guest
  passes: POST creates a first-name plus last-initial pass for a
  visit date (up to 2 live per host per day, code returned once and
  stored as HMAC only via a new guest-pass code kind), GET /mine
  lists without codes, DELETE revokes only the host's issued pass,
  and public POST /guests/accept and /guests/checkin complete the
  deck guest flow (rules accepted first, pass works on its visit
  date only, rate limited). GET /house returns house_info rows and
  opening hours with the hub address; resource floor and
  accessibility notes are never returned, because the dev seed
  marks them placeholder, not checked, and unconfirmed
  accessibility stays "Details coming soon. To confirm" on the
  page. Pages: /hub/space (room picker, week navigation, grid with
  free cells named in full, booking dialog, my bookings with
  cancel dialog, deck empty copy), /hub/space/here (I am here
  button plus count only), /hub/space/guests (host form, code shown
  once, pass list with revoke), /hub/space/house (hours, sections,
  accessibility fallback, no invented Wi-Fi password). The shell
  now links Space to /hub/space on desktop and in the phone tabs.
  The hub home Today card is wired to the new endpoints (today's
  bookings plus the check-in count), closing the cycle 20 note
  that named them as arriving with the Space slice. Em dashes
  scrubbed from every touched file; the pre-existing em dash in
  the /hub page title is untouched (recorded brand call).
  Verification before the PR: 761 API tests pass (37 files, 15
  new: grid states, closure midnight boundary, shared seats, past
  slots, booking rules and trigger mapping, cancel ownership,
  check-in idempotence, guest HMAC and daily cap, guest accept and
  check-in, house shape; one real bug found and fixed in review,
  a last initial validated only after truncation), API typecheck
  clean, site build clean (32 pages, up from 28), and the built
  /hub/space bundle inspected directly (week and bookings calls,
  sub page links) plus the /hub bundle (Today card calls). No new
  dependency, no migration. Shipped in PR #59 (merged to develop;
  build, secrets, audit, analyze, CodeQL, lighthouse, and
  Cloudflare Pages all green). Grade (dimensions this cycle
  touched, scored from evidence): functional 2,500/2,500 (every
  deck space element with a backing endpoint is live and wired:
  grid, booking, cancel, check-in, guest passes, house info, plus
  the Today card); schema and API 2,000/2,000 (read and write
  routes in the existing style on the shipped 0029 schema, suite
  green, no migration needed); security 1,250/1,250 (CodeQL and
  analyze green, members-only gate on member routes, guest codes
  HMAC only, count only for check-ins, escaped output); code
  quality 1,000/1,000 (API typecheck clean, grid logic unit
  tested as a pure function, tests in the existing style); brand
  and copy 750/750 (deck labels and surface copy, Canadian
  spelling, no new em dash, no member named, no unconfirmed
  accessibility fact stated). Accessibility and performance
  untouched in substance (Lighthouse gate passed, no new
  dependency, no page weight change of note). Pro-rated total
  10,000/10,000, no zero dimension, no open P0. Verdict: ACCEPT.
  Next improvement: Phase 3 slice 9, the hub people page from the
  deck (section 23 people screen: member directory, projects, and
  hub search), reconciling the existing profiles surface.
  Proposing a new group (three co-founders plus admin approval),
  live verification of the /hub/g/* rewrite on a branch preview,
  a rituals read API for live thread state, the deck command
  palette, the /hub route renaming, the feed header notices (next
  Demo Night, questions needing answers), and the staff spotlight
  post type remain recorded follow-ups. The member space bookings
  and check-ins for the Today card close with this slice. Still
  blocked: the Phase 1 preview smoke flows and applying 0037 to
  preview D1 (no Cloudflare token in the environment).
- Cycle 26, 2026-10-26: Phase 3 slice 9, the hub people page from the
  deck (section 23 people screen: member directory, projects, and
  hub search), in ~/workspace/company/wt-phase3-hub-people on branch
  phase3/hub-people (no open loop PR; develop CI green; #22 is the
  founder-tapped README PR, not loop work). There was no people page:
  the shell listed People as a dead place. This slice builds it,
  reconciling the existing profiles surface: no new migration, because
  0025 and 0026 already ship member_profiles, member_skills, and
  skill_tags, and no new dependency. API (mounted at /api/people, new
  route people.ts, members only): GET / lists directory_opt_in = 1
  members with active accounts, never the caller, sorted by name with
  no ranking and no member count on a card. Cards carry Building (the
  member's project), Can help with, Looking for, and skill badges, plus
  a Staff or Moderator badge from user_effective_roles (0024).
  ?skill= filters by the curated skill_tags list (an unknown slug is
  a 400); ?q= matches display name, builder fields, and skill labels
  only, never the real name column, so the directory cannot be used
  as an oracle for a member's real name. Neither side of a block
  appears (block_pairs is the both-ways view from 0025). Per-field
  visibility is honoured server-side: a field set to only-me is
  omitted from the card and cannot match a search. No email or real
  name ever leaves the route; display_name falls back to initials,
  the same fallback the profile views use. Page /hub/people in the
  HubShell (members-only gate, same pattern as groups): skill chips
  from GET /api/skill-tags, a search box, a count line with
  role=status, deck empty states, and a Message button that opens
  the 1:1 DM through the shared messageMember helper the profile
  pages already use. The shell now links People to /hub/people on
  desktop and under Me on phones; Saved stays a plain-text gap. Hub
  search: /search gains a People section for signed-in visitors from
  the same route (a 401 hides the section instead of breaking the
  search). Em dashes scrubbed from every touched file; the
  pre-existing em dash in the /hub page title and the search page
  title is untouched (recorded brand call). Verification before the
  PR: 766 API tests pass (38 files, 5 new: opt-in list and shape
  with badge and profile URL, only-me omission, sign-in required,
  skill filter and unknown-skill 400, visible-field-only search),
  API typecheck clean, site build clean (33 pages, up from 32), and
  the built /hub/people bundle inspected directly (people and
  skill-tags calls, Message wiring) plus the /search bundle (People
  section fetch and render). The exact directory queries were also
  run against a real SQLite database built from the full 0001-0037
  migration chain: the viewer saw Ada and Bo only (Cy blocked, Maya
  opted out, Sue suspended excluded), Bo carried the moderator badge
  through user_roles, and after Bo blocked the viewer only Ada
  remained. One real bug found and fixed in review: badges first
  read users.role, which only ever holds admin or member, so the
  moderator badge could never have shown; they now read
  user_effective_roles. Shipped in PR #60 (merged to develop; build,
  secrets, audit, analyze, CodeQL, lighthouse, and Cloudflare Pages
  all green). Grade (dimensions this cycle touched, scored from
  evidence): functional 2,500/2,500 (every deck people element with
  a backing endpoint is live and wired: directory, chips, search,
  cards, Message, hub search section); schema and API 2,000/2,000
  (new route in the existing style on the shipped 0025 and 0026
  schema, suite green, no migration needed); accessibility
  1,250/1,250 (Lighthouse gate passed, chips carry aria-pressed,
  count line carries role=status, labelled search, Message buttons
  carry aria-labels); performance 1,250/1,250 (Lighthouse budgets
  passed, no new dependency, one small skill-tags fetch);
  security 1,250/1,250 (CodeQL and analyze green, members-only gate,
  block exclusion both ways, only-me fields omitted server-side,
  no email or real name in any response, escaped output); code
  quality 1,000/1,000 (API typecheck clean, tests in the existing
  style, directory query verified against real SQLite); brand and
  copy 750/750 (deck labels and surface copy, Canadian spelling, no
  new em dash, no member named). Pro-rated total 10,000/10,000, no
  zero dimension, no open P0. Verdict: ACCEPT. Next improvement:
  Phase 3 slice 10, the hub saved page from the deck (saved screen:
  the member's saved posts, visible only to them), reconciling the
  existing feed surface and the saved_posts table (0026); whether a
  save and unsave endpoint already exists is the slice's first check.
  Proposing a new group (three co-founders plus admin approval),
  live verification of the /hub/g/* rewrite on a branch preview, a
  rituals read API for live thread state, the deck command palette,
  the /hub route renaming, the feed header notices (next Demo
  Night, questions needing answers), and the staff spotlight post
  type remain recorded follow-ups. The member directory closes with
  this slice. Still blocked: the Phase 1 preview smoke flows and
  applying 0037 to preview D1 (no Cloudflare token in the
  environment).
- Cycle 27, 2026-10-27: Phase 3 slice 10, the hub saved page from the
  deck (section 07 Saved place: the member's saved posts, visible
  only to them), in ~/workspace/company/wt-phase3-hub-saved on branch
  phase3/hub-saved (no open loop PR; develop CI green; #22 is the
  founder-tapped README PR, not loop work). First check, as cycle 26
  required: no save or unsave endpoint existed; saved_posts from
  0026 was written by nothing. This slice builds it, with no new
  migration and no new dependency. API (mounted at /api/saved, new
  route saved.ts, members only): GET / lists the caller's own saves
  newest first with collection chips derived from the visible rows;
  POST / saves a post into a named collection (default Saved, 1 to
  40 chars) as an upsert, so re-saving moves the post and refreshes
  saved_at; DELETE /:postId unsaves idempotently. Visibility is the
  feed rule exactly: published and not deleted, audience the viewer
  may see (members, their own only_me posts, groups they actively
  belong to), neither side of a block (block_pairs, both ways); an
  invisible post is a 404 on save, the same answer the feed detail
  gives, and silently drops out of the list. No other member's saves,
  counts, or collections are readable: every query is keyed on the
  caller. Page /hub/saved in the HubShell (members-only gate, same
  pattern as people): collection chips with counts, a count line
  with role=status, deck empty states, a View post link, Unsave, and
  a collection menu that moves a post or creates a new collection on
  the spot. The shell now links Saved to /hub/saved on desktop and
  under Me on phones, so all nine deck places are real links and
  Phase 3 closes with this slice. The hub feed gains the entry point:
  a Save button on every post card, marked Saved from one /api/saved
  read and kept in memory as the member saves and unsaves. Em dashes
  scrubbed from every touched file; the pre-existing em dash in the
  /hub page title, the search page title, and api/src/index.ts is
  untouched (recorded brand call). Verification before the PR: 775
  API tests pass (39 files, 9 new: list order and chips with the
  visibility SQL asserted, collection filter, sign-in required,
  save into a named collection with the upsert SQL asserted, Saved
  default, invisible post 404 with nothing saved, missing id 400,
  overlong collection truncated to 40, idempotent unsave, sign-in
  required for both writes), API typecheck clean, site build clean
  (34 pages, up from 33), and the built bundles inspected directly
  (saved page and feed Save wiring in the _astro bundles). The exact
  list, move, and unsave SQL was also run against a real SQLite
  database built from the full 0001-0037 migration chain: the viewer
  saw Ada and Bo only (Cy blocked, the deleted post, and the
  someone-else only_me post all excluded; the suspended author's
  post stayed visible, matching the feed rule, which does not filter
  author status either), the move upsert changed the collection,
  and the unsave deleted the row. Shipped in PR #62 (merged to
  develop; build, secrets, audit, analyze, CodeQL, lighthouse, and
  Cloudflare Pages all green). Grade (dimensions this cycle touched,
  scored from evidence): functional 2,500/2,500 (every deck Saved
  element with a backing endpoint is live and wired: list, chips,
  filter, View post, Unsave, move and new collection, feed Save
  entry point, shell links); schema and API 2,000/2,000 (new route
  in the existing style on the shipped 0026 schema, suite green, no
  migration needed); accessibility 1,250/1,250 (Lighthouse gate
  passed, chips carry aria-pressed, count line carries role=status,
  Save buttons carry aria-pressed and aria-labels, labelled
  collection selects); performance 1,250/1,250 (Lighthouse budgets
  passed, no new dependency, one small saved-list fetch shared by
  the feed and the saved page); security 1,250/1,250 (CodeQL and
  analyze green, members-only gate, block exclusion both ways,
  invisible posts never leak, no email or real name in any
  response, escaped output); code quality 1,000/1,000 (API typecheck
  clean, tests in the existing style, list SQL verified against
  real SQLite); brand and copy 750/750 (deck labels and surface
  copy, Canadian spelling, no new em dash, no member named).
  Pro-rated total 10,000/10,000, no zero dimension, no open P0.
  Verdict: ACCEPT. Next improvement: Phase 4 slice 1, D1 certificate
  issuance and the certificate studio panel from the phase map.
  Proposing a new group (three co-founders plus admin approval),
  live verification of the /hub/g/* rewrite on a branch preview, a
  rituals read API for live thread state, the deck command palette,
  the /hub route renaming, the feed header notices (next Demo
  Night, questions needing answers), and the staff spotlight post
  type remain recorded follow-ups. Still blocked: the Phase 1 preview
  smoke flows and applying 0037 to preview D1 (no Cloudflare token
  in the environment).
