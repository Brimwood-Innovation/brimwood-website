# Fix-First Phase — Running Log

Started 2026-10-03. Source: Brimwood full-stack audit (Claude, 2026-10-03).
Mission: 12 fixes before any new social feature. No new features.

## Execution map

Order: F2 (blocked, needs token) then F5, F4, F9 (API sequence, done by lead in order),
F6, F7, F10, F12 (parallel crews), F8 (after API work). F1, F3, F11 are
sign-off items: written plans only, no code until the founder approves.

| Fix | Branch | Worker | Sign-off | Status |
|-----|--------|--------|----------|--------|
| F2 prod schema audit (read-only) | - | lead | no | DONE: tasks/prod-schema-audit.md; 0009 confirmed applied, 0010/0011 not |
| F5 one auth module | fix/f5-auth-module | lead | no | MERGED 2026-10-03 (PR #5) |
| F4 CSRF middleware | fix/f4-csrf | lead | no | pending |
| F9 rate limits + sessions to D1 | fix/f9-d1-limits | lead | no | PR #8 retargeted to develop, rebased, 206 tests |
| F6 self-host Decap | fix/f6-decap | crew | no | pending |
| F7 tighten CSP | fix/f7-csp | crew | no | pending |
| F10 contrast fixes | fix/f10-contrast | crew | no | pending |
| F12 CI upgrade | fix/f12-ci | crew | no | pending |
| F8 workers-runtime tests | fix/f8-workers-tests | lead/crew | no | pending (after F5/F4/F9) |
| F1 split environments | fix/f1-preview-env | lead | YES (2026-10-03) | DONE: PR #10; preview D1/KV/R2 + worker live, isolation proven |
| F3 same-origin API + cookies | fix/f3-same-origin | lead/crew | YES (2026-10-03) | DONE: PR #11; routing live on domain; 210 tests green |
| F11 licence + repo hygiene | fix/f11-licence | crew | YES (2026-10-03) | DONE: PR #12; dual MIT/AGPL-3.0, email scrub verified 0 hits |

Rules: no pushes to main, one PR per fix targeting develop, PRs under ~600 lines,
Phase D code (password.ts, profiles.ts, studio.ts) parked except F5 session dedup,
no writes to production D1, no secrets in code or chat, no em dashes in any
written artifact.

## Per-fix records

### F2 — read-only production schema audit
- Status: DONE (2026-10-03). Report: tasks/prod-schema-audit.md.
- Method: Cloudflare D1 REST query API against brimwood_db_v2, read-only.
  No writes, no migrations run.
- Result: 26 tables (25 app + _cf_KV). Matches migrations 0001-0009 exactly,
  zero drift. 0009_passwords CONFIRMED applied remotely (password columns on
  users + password_resets with both indexes). 0010_profiles NOT applied (no
  profile columns on users). 0011_d1_limits NOT applied (no rate_limits or
  sessions tables; still on PR #8).
- Row-count baseline captured (1651 total rows; health_checks 1623 and
  cron-ticked). Used for the F1 acceptance.

### F5 — one auth module
- Status: MERGED to develop 2026-10-03 (PR #5, commit 00e1e8f). Branch fix/f5-auth-module, PR #5 targeting develop.
- New api/src/lib/auth.ts: createSession, readSession, destroySession,
  requireUser/requireAdmin middleware, getAdminUser/getUserId helpers.
- Sessions keyed by SHA-256 of token. requireAdmin re-reads role from D1.
- All 14 route files refactored. grep for raw "sess:" keys in routes: 0.
- Tests: 205 passed (8 new in auth.test.ts). tsc clean.
- Note: deploy logs out all members once (old raw-key sessions invalid).
  Shared-tree incident: a crew git operation reset the branch pointer;
  recovered via reflog (fa028b2), pointer restored, pushed.

### F4 — CSRF middleware
- Status: DONE. Branch fix/f4-csrf, PR #7 targeting develop.
- New api/src/lib/csrf.ts: global middleware on POST/PATCH/PUT/DELETE.
  Origin must be allowlisted if present; Content-Type must be
  application/json (multipart excepted for media upload).
- SameSite=None removal DEFERRED to F3: removing it now would break
  cookie auth on cross-origin preview deployments. Documented in PR.
- Tests: 24 new, 221 total passed. tsc clean.

### F9 — rate limits and sessions off KV writes
- Status: DONE. Branch fix/f9-d1-limits, PR #8 targeting fix/f5-auth-module
  (stacked on PR #5; retarget to develop after #5 merges).
- Migration 0011: rate_limits and sessions tables.
- Atomic UPSERT rate limiter; all 10 call sites migrated; KV version deleted.
- Sessions in D1; per-user index replaces the full scan on reset.
- Acceptance: 20-request burst limited to 5; zero KV writes per login.
- Tests: 206 passed. tsc clean.

### F6 — self-host and pin Decap
- Status: DONE. Branch fix/f6-decap, PR #3 targeting develop.
- Decap CMS 3.16.3 self-hosted with SRI hash. Awaiting review.

### F7 — tighten CSP
- Status: DONE. Branch fix/f7-csp, PR #6 targeting develop.
- 18 files, 503+/415-. Awaiting review.

### F10 — contrast fixes (WCAG 2.2 AA)
- Status: DONE. Branch fix/f10-contrast, PR #4 targeting develop.
- Awaiting review.

### F12 — CI upgrade
- Status: DONE. Branch fix/f12-ci, PR #2 targeting develop.
- 4 files, +105/-11. Awaiting review.

### F8 — workers-runtime tests
- Status: DONE. Branch fix/f8-workers-tests, PR #9 targeting develop.
- @cloudflare/vitest-pool-workers evaluated but conflicts with vitest 5
  (pool requires vitest 4); used wall-clock timing assertion instead.
- New test: hash+verify must complete within 5s; measured 305ms in Node
  (audit: 263ms in workerd). Confirms passwords exceed Workers Free CPU.
- Tests: 198 passed. tsc clean.

### F1 — split environments [SIGNED OFF 2026-10-03, DONE]
- Status: DONE. Branch fix/f1-preview-env, PR #10 targeting develop.
- Resources created (account-level): D1 brimwood_db_preview
  (71b2f3ec-b0c8-4602-99ba-3ee82de5dca4) with migrations 0001-0010 applied;
  KV brimwood-sessions-preview, brimwood-rate-limit-preview,
  brimwood-newsletter-preview; R2 brimwood-media-preview.
- api/wrangler.toml: [env.preview] bound to the preview resources, preview
  crons disabled, SITE_URL set to the preview worker URL.
- Worker brimwood-api-preview deployed:
  https://brimwood-api-preview.adamsayani.workers.dev
  (preview-only dummy secrets, clearly labelled).
- Isolation evidence: GET /api/courses on preview returns [] (prod has 2);
  rate-limit key written to preview RATE_LIMIT_KV, prod KV empty; marker row
  inserted in preview D1 then production counts re-snapshotted: all 25 tables
  identical to the F2 baseline except health_checks (+3 cron ticks, expected);
  marker deleted afterwards.
- Plan extension (noted): created a third preview KV (newsletter) and a
  preview R2 bucket beyond the signed plan's two KVs, for a true split.
  Rollback: delete the preview D1/KV/R2 resources and revert the commit.
- Follow-up for full e2e form tests: production Resend + Turnstile secrets
  would need to be set on the preview env (founder dashboard job); binding
  isolation is already proven without them.

### F3 — same-origin API + cookie hardening [SIGNED OFF 2026-10-03]
- Status: DONE. Branch fix/f3-same-origin, PR #11 targeting develop
  (stacked on fix/f5-auth-module like PR #8; rebase after PR #5 merges).
- Code (commit 7b74a58, 191 diff lines): session cookie renamed to
  __Host-brimwood-sess, exact header
  `__Host-brimwood-sess=<token>; Path=/; HttpOnly; Secure; SameSite=Lax`
  via a shared setSessionCookie() in api/src/lib/auth.ts (used by
  magic-code verify and password login; logout clears with matching attrs).
  gh_oauth_state left as-is (short-lived signed state token, already
  Lax+Secure+HttpOnly, not a session cookie).
- SameSite=None fully removed from api/src (only mentions left are a code
  comment and test assertions of absence). Deferred F4 item now complete.
- CORS: brimwoodinnovation.com and www removed from the allowlist
  (same-origin needs none); localhost dev origins and
  *.brimwood-website-preview.pages.dev previews kept. Site needed no code
  change: PUBLIC_API_BASE already defaults to "" (relative /api calls);
  the env var remains the local-dev escape hatch.
- Tests: 210/210 pass (5 new in session-cookie.test.ts asserting the exact
  Set-Cookie format and the absence of SameSite=None/Domain=), tsc clean.
  Independently re-run by lead on the PR commit.
- Routing (production, done 2026-10-03): brimwoodinnovation.com/api/* worker
  route moved from brimwood-introduction to brimwood-api (route id
  14a23385a19040178de660fd0eca83e2, updated via API). Added
  www.brimwoodinnovation.com/api/* -> brimwood-api as well (same intent).
  Verified: https://brimwoodinnovation.com/api/courses returns 200 with live
  data; /api/introduction honeypot returns ok:true. The old
  brimwood-introduction worker is kept untouched as rollback.
- Rollback: revert the code commit and repoint the two worker routes to
  brimwood-introduction. One deploy each. Note: the cookie rename signs all
  members out once on deploy.

### F11 - licence and repo hygiene [SIGNED OFF 2026-10-03]
- Status: DONE. Branch fix/f11-licence, PR #12 targeting develop.
- Licence decision (founder, 2026-10-03): BOTH. Dual-licensed MIT OR
  AGPL-3.0 at the recipient's choice.
- Delivered (commit 649f3bc + follow-up): LICENSE (dual-licence statement,
  copyright Brimwood Innovation 2026), LICENSE-MIT, LICENSE-AGPL-3.0,
  NOTICE reserving brand assets (img, fonts, site content - all rights
  reserved, excluded from the code licence). site/package.json licence field
  set to the dual expression.
- Internal docs moved to the new PRIVATE repo
  Brimwood-Innovation/brimwood-internal-docs (verified: report md + html,
  CAPABILITY-MAP.md, staged report body all present there), then removed
  from the public tree.
- Owner personal email scrubbed from the working tree: final grep returns
  zero hits (one occurrence in tasks/todo.md missed by the crew was fixed
  by lead). Account IDs kept; placeholders used.
- Dead preview/ and build/ content removed from the branch.
- Rollback: git revert; licence choice is hard to reverse after forks exist.

## Decision D1 — passwordless (founder, 2026-10-03)
- Direction: passkeys + magic code + GitHub login at C$0. Workers Paid
  (~USD 5/mo) declined.
- The 305 ms PBKDF2 measurement stands as the evidence. Do NOT silently
  weaken PBKDF2 iterations.
- Implementation is POST-Gate-1 work (fix-first rule: no new features in
  this phase). password.ts and the 0009 password columns stay parked;
  passkeys are new feature work for Phase E planning, not for fix-first.
