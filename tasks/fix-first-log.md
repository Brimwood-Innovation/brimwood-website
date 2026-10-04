# Fix-First Phase — Running Log

Started 2026-10-03. Source: Brimwood full-stack audit (Claude, 2026-10-03).
Mission: 12 fixes before any new social feature. No new features.

## Execution map

Order: F2 (blocked, needs token) then F5, F4, F9 (API sequence, done by lead in order),
F6, F7, F10, F12 (parallel crews), F8 (after API work). F1, F3, F11 are
sign-off items: written plans only, no code until the founder approves.

| Fix | Branch | Worker | Sign-off | Status |
|-----|--------|--------|----------|--------|
| F2 prod schema audit (read-only) | - | lead | no | BLOCKED: no Cloudflare API token |
| F5 one auth module | fix/f5-auth-module | lead | no | pending |
| F4 CSRF middleware | fix/f4-csrf | lead | no | pending |
| F9 rate limits + sessions to D1 | fix/f9-d1-limits | lead | no | pending |
| F6 self-host Decap | fix/f6-decap | crew | no | pending |
| F7 tighten CSP | fix/f7-csp | crew | no | pending |
| F10 contrast fixes | fix/f10-contrast | crew | no | pending |
| F12 CI upgrade | fix/f12-ci | crew | no | pending |
| F8 workers-runtime tests | fix/f8-workers-tests | lead/crew | no | pending (after F5/F4/F9) |
| F1 split environments | - | - | YES | plan only, awaiting sign-off |
| F3 same-origin API + cookies | - | - | YES | plan only, awaiting sign-off |
| F11 licence + repo hygiene | - | - | YES | plan only, awaiting sign-off |

Rules: no pushes to main, one PR per fix targeting develop, PRs under ~600 lines,
Phase D code (password.ts, profiles.ts, studio.ts) parked except F5 session dedup,
no writes to production D1, no secrets in code or chat, no em dashes in any
written artifact.

## Per-fix records

### F2 — read-only production schema audit
- Status: BLOCKED. Needs a Cloudflare API token (read-only is enough).
- What is known without the token: commit ef99f2f message says migration
  0009_passwords.sql was applied to remote brimwood_db_v2 while that code is
  not on main. Migration 0010_profiles.sql was NOT applied (blocked on token
  earlier tonight). Remote state unverified.

### F5 — one auth module
- Status: DONE. Branch fix/f5-auth-module, PR #5 targeting develop.
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

### F1 — split environments [SIGN-OFF]
- Status: PLAN ONLY. Awaiting founder sign-off. No code written.
- Plan:
  1. Create preview D1: wrangler d1 create brimwood_db_preview
  2. Create preview KV namespaces (2): wrangler kv namespace create for sessions and rate limits with preview suffix
  3. Add [env.preview] to api/wrangler.toml binding the preview D1/KV/R2; production keeps the current bindings
  4. Run all migrations on the preview DB; deploy worker with --env preview
  5. Submit a test introduction via the preview URL
- Acceptance: row counts in production D1 before/after are identical (paste counts).
- Rollback: delete the preview D1/KV namespaces; revert wrangler.toml. Production untouched.
- Commands need CLOUDFLARE_API_TOKEN (founder provides transiently).

### F3 — same-origin API + cookie hardening [SIGN-OFF]
- Status: PLAN ONLY. Awaiting founder sign-off. No code written.
- Plan:
  1. In Cloudflare dashboard (or via API): add route brimwoodinnovation.com/api/* to the brimwood-api worker
  2. Update site env: PUBLIC_API_BASE = "" (same-origin) or "https://brimwoodinnovation.com"
  3. Rename cookie to __Host-brimwood-sess; set SameSite=Lax, Secure, HttpOnly, Path=/
  4. Remove the SameSite=None branch in auth.ts/password.ts (deferred from F4)
  5. Update CORS: same-origin needs no CORS headers for the site
- Acceptance: test asserts exact Set-Cookie header (__Host- prefix, Lax, Secure, HttpOnly); sign-in works in Safari on preview (screenshot or tester note).
- Rollback: revert worker route and cookie name; restore PUBLIC_API_BASE. One deploy.
- Note: changes production routing. Safari third-party cookie blocking is the motivator.

### F11 — licence and repo hygiene [SIGN-OFF]
- Status: PLAN ONLY. Awaiting founder sign-off (licence choice first).
- Plan (after founder picks AGPL-3.0 or MIT):
  1. Add LICENSE file at repo root with the chosen licence + copyright notice
  2. Add NOTICE: site/public/img, fonts, and site content are all rights reserved (brand assets excluded from code licence)
  3. Move docs/BRIMWOOD-FULLSTACK-FRAMEWORK-REPORT.md, docs/*.html, CAPABILITY-MAP.md internal sections to a private repo; remove from public repo
  4. Scrub the owner personal email from the working tree (grep to verify zero hits)
  5. Tag and archive preview/ and build/ dirs, remove from develop
- Acceptance: LICENSE present; grep for "do not publish" and the personal email returns nothing.
- Rollback: git revert (before the private-repo move); licence change is hard to reverse once forks exist, which is why this needs sign-off.
