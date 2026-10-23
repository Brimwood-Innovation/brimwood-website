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
  Grade (dimensions this cycle touched, scored from evidence): functional
  2,500/2,500; schema and API 2,000/2,000; security 1,250/1,250; code quality
  1,000/1,000; brand and copy 750/750. Accessibility and performance untouched
  (API-only cycle). Pro-rated total 10,000/10,000, no zero dimension, no open
  P0. Verdict: ACCEPT. Next improvement: Phase 1 work order compliance item 13
  (newsletter tokens, suppressions, consent records) and the rest of item 12
  (retention purge, deletion completion job).
