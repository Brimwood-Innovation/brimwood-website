# Auth audit (magic-code + Phase D password auth + GitHub OAuth + sessions)

Branch `audit/auth`, 2026-10-08. Scope: `api/src/routes/{auth,password,oauth}.ts`,
`api/src/lib/auth*.ts`, `api/src/routes/session-cookie.test.ts`,
`site/src/pages/{members,invite}.astro`. Ruthless critical pass; every finding
below was re-checked against the code before writing.

## Errors found

### CRITICAL

1. **Stale session role trusted for authorization (`academy.ts`, `video.ts`).**
   `sessionUser()` returns `role` from the session row, which is cached at login
   and lives up to 30 days (`SESS_TTL`). `academy.ts:85` and `video.ts:38` use
   `user.role !== "admin"` to bypass the enrolment check. A demoted admin keeps
   the bypass until their session expires — the lib comment in `lib/auth.ts`
   ("Admin checks re-read the role from D1 so demotion takes effect
   immediately") is only true for `requireAdmin`/`getAdminUser` routes.
   FIXED: new `isAdminUser(c, userId)` helper re-reads `role` from D1; both
   routes use it. Additionally, `PATCH /admin/users/:id` (profiles.ts) now
   destroys all of a user's sessions when they are demoted from admin or
   suspended.

### MAJOR

2. **Login timing side-channel → user enumeration (`password.ts` `/login`).**
   Unknown email / suspended / no-password paths returned immediately, while a
   valid user burned ~600k PBKDF2 iterations (~1s on Workers). Response-time
   differences distinguish registered emails. FIXED: failure paths now run a
   dummy PBKDF2 verify with the same iteration count before returning the
   generic error.
3. **Password change did not invalidate other sessions (`password.ts`).**
   `password/change` left every session alive; only reset killed sessions.
   FIXED: `password/change` now destroys all *other* sessions for the user
   (new `destroyOtherUserSessions`); the current session is rotated via the
   existing cookie on the next request — actually the current session is kept
   and all others destroyed, which is the standard behaviour.
4. **`pruneSessions` / `pruneRateLimits` existed but were never called.**
   Expired sessions accumulate forever; `rate_limits` rows accumulate forever
   and keys are attacker-controlled (`pwlogin:email:<arbitrary email>`,
   `authreq:<ip>`) — an unbounded-storage DoS vector on D1. FIXED: the 5-min
   cron job now prunes both tables.

### MINOR

5. **Magic-code TTL extended on every failed attempt (`auth.ts`).**
   Failed verifies re-`put` the KV record with a fresh 10-minute
   `expirationTtl`, so the code's life extended with each guess. FIXED: the
   record now carries `expiresAt` (ms epoch) which is enforced strictly; the
   KV TTL remains only as a backstop.
6. **Modulo bias in 6-digit codes.** `rand % 900000` over the 2^32 space
   slightly favours some codes. FIXED: rejection sampling in both
   `request-code` and `redeem-invite`.
7. **No per-email throttle on `request-code` / `password/reset/request`.**
   Per-IP limits existed; a distributed attacker could still inbox-bomb a
   victim. FIXED: per-email limits added (`authreq:email:` 5/hr,
   `pwreset:email:` 3/hr).
8. **Reset request did not invalidate prior unused tokens.** Multiple reset
   links could be live at once. FIXED: unused tokens for the user are deleted
   before a new one is issued.
9. **OAuth `state` compared with `!==` (`oauth.ts`).** Timing-safe compare is
   the house rule for secrets. FIXED: uses `safeEqual`.
10. **OAuth authorization-code flow had no PKCE (`oauth.ts`).**
    Defense-in-depth for the Decap CMS handshake flow. FIXED: S256
    `code_challenge` sent to GitHub, `code_verifier` (stored in the signed
    state cookie) sent at token exchange.
11. **Stale comment in `lib/csrf.ts`.** Claimed a "SameSite=None cookie branch
    … is kept until F3" — no such branch exists in the code (F3 removed it).
    FIXED: comment updated to describe the current state.
12. **`/oauth/callback` failure responses discarded the state-cookie
    deletion.** `deleteCookie()` stages a header that raw `new Response()`
    returns drop — the same trap the `/auth` comment warns about for
    `setSignedCookie`. On state-mismatch / missing-code / exchange-failure
    paths the state cookie survived, breaking the single-use guarantee.
    FIXED: all `/callback` responses now go through `c.text()`/`c.html()`.

### CRITICAL (cross-area follow-ups, confirmed and fixed)

13. **`readSession` did not check `users.status` (academy crew flag —
    CONFIRMED).** A suspended user's session stayed valid until the 30-day
    expiry; a hard-deleted user likewise. FIXED: `readSession` now JOINs
    `users` in the same indexed query — `u.status = 'active'` is enforced
    and the returned role is always live, never the login-time cache. This
    also closes the stale-role hole globally (finding 1's `isAdminUser`
    remains as explicit defence-in-depth on the admin bypasses).
14. **Invite redeem was check-then-increment (admin-cms crew flag —
    CONFIRMED).** `SELECT` saw `uses < max_uses`, then a separate `UPDATE`
    incremented — concurrent redemptions of a single-use code could both
    succeed. FIXED: atomic `UPDATE invite_codes SET uses = uses + 1 WHERE
    id = ? AND uses < max_uses` issued before user creation; the changes
    count is authoritative. Race loser gets "already been used" and no user
    is created.

### Checked and clean (no finding)

- Magic codes: SHA-256-hashed at rest in KV, 10-min expiry, single-use
  (deleted on success and on 5-attempt lockout), constant-time compare via
  `safeEqual`, existence of email never revealed, strict per-IP rate limits on
  request (10/15min) and verify (10/15min).
- Session cookie: `__Host-brimwood-sess`, `Path=/; HttpOnly; Secure;
  SameSite=Lax` — one shared `setSessionCookie`, no `Domain=`, no
  SameSite=None remnants in code (only the stale comment, fixed above).
- Password hashing: PBKDF2-HMAC-SHA256, 600k iterations (OWASP 2023), 32-byte
  salt, 32-byte key, constant-time verify — Workers-compatible, cost sane.
- Login responses: generic error everywhere, no enumeration via message or
  status (after the timing fix).
- Logout: deletes the server-side session row, clears the cookie. Verified.
- Admin seeding: no seeding endpoint exists — admin is provisioned manually;
  cannot be re-triggered by non-admins. Verified via grep.
- `requireAdmin`/`getAdminUser` re-read role from D1 on every call (demotion
  takes effect immediately). `PATCH /admin/users/:id` is admin-gated.
- Reset tokens: 32-byte random, SHA-256-hashed at rest, single-use, 30-min
  TTL, generic errors, session invalidation + audit log on confirm.
- OAuth: state is 32 random bytes in a signed httpOnly cookie (10-min,
  single-use, cleared regardless of outcome); token exchange is server-side;
  `postMessage` targets the validated CMS origin (never `*`); scope is
  `public_repo` (least privilege); fails closed without `SESSION_SECRET`.
- Session TTL: fixed 30 days, no sliding refresh — bounded and acceptable;
  left unchanged deliberately (sliding refresh would extend lifetime).
- Site pages (`members.astro`, `invite.astro`): auth checks are API-side;
  client scripts only call `/api/auth/*`. No secrets in pages.
- Invite redemption hardcodes `role='member'` — no role injection.

## What was implemented (this branch)

- `api/src/lib/auth.ts`: `isAdminUser()`, `destroyOtherUserSessions()`.
- `api/src/routes/academy.ts`, `video.ts`: admin bypass now re-reads role via
  `isAdminUser()`.
- `api/src/routes/profiles.ts`: demote/suspend destroys the target's sessions.
- `api/src/routes/password.ts`: dummy-verify timing equalization on `/login`;
  `password/change` kills other sessions; `reset/request` per-email throttle +
  invalidation of prior unused tokens.
- `api/src/routes/auth.ts`: `expiresAt` enforcement + rejection-sampled codes;
  per-email throttle on `request-code`.
- `api/src/routes/oauth.ts`: `safeEqual` state compare; PKCE (S256).
- `api/src/cron.ts`: prune expired sessions + stale rate-limit rows every
  5 minutes.
- `api/src/lib/csrf.ts`: stale comment corrected.
- Tests: new/updated vitest coverage in `password.test.ts`, `auth.test.ts`
  (new file `api/src/routes/auth.test.ts`), `oauth.test.ts` (new),
  `session-cookie.test.ts`, `api/src/lib/auth.test.ts`.

## Verification

- `npx vitest run` (api/): all green — 270 tests (baseline 236; +34 new),
  19 files, 0 failures.
- `npx tsc --noEmit` (api/): clean.
- Scanned diff for secrets before commit: none (no credentials, tokens, or
  real-looking test fixtures; test passwords are the suite's existing fake
  fixtures).
- Remote D1 untouched — local bindings/mocks only.

## Files changed (beyond the named area, with reason)

The stale-role and invite-race fixes unavoidably touched adjacent files:
`api/src/routes/academy.ts`, `video.ts` (admin bypass now uses
`isAdminUser`), `api/src/routes/profiles.ts` (+ test; demote/suspend kills
sessions), `api/src/cron.ts` (+ `cron.test.ts`; prune wiring),
`api/src/test/helpers.ts` (mock honours the new session JOIN and the
`destroyOtherUserSessions` query shape), `api/src/lib/csrf.ts` (stale
comment). All changes are auth-security fixes; no other routes' behaviour
was altered.
