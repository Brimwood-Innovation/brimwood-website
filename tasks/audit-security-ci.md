# Security + CI audit — 2026-10-08 (audit/security-ci branch)

Scope: `site/public/_headers`, API CORS/cookie/security-header code (`api/src/index.ts`,
`api/src/lib/csrf.ts`, `api/src/lib/auth.ts`), `.github/workflows/ci.yml` (audit + lighthouse
jobs only — gitleaks belongs to PR #13), `site/package.json` / `api/package.json` dependency
upgrades, `.lighthouserc.json` (read-only reference). Plus three email follow-ups reassigned
from the email crew: RFC 8058 one-click unsubscribe, newsletter confirm-token expiry,
unguarded Resend failures.

Method: audit → research → implement. Verified: `npx vitest run`, `npx tsc --noEmit`,
site `npm run build`, dependency advisories via OSV (`npm audit` POST is blocked by the
sandbox egress policy — see finding S6).

## Errors found

### Critical
1. **Astro 5.18.2 ships a critical RCE advisory (GHSA-26w7-cxv4-gfx2, CVSS 9.8).**
   Remote code execution through AVIF image optimization (libheif via Sharp). GitHub marks
   all astro `< 7.2.8` affected; patched in 7.2.8. This alone fails the CI audit job
   (`--audit-level=high`). Fix: upgrade `astro` ^5.0.0 → ^7.3.8 (latest stable ≥ 7.2.8),
   regenerate the lock, rebuild.
2. **Lighthouse CI job fails on every run — but not on performance.** `.lighthouserc.json`
   sets `collect.url` to the literal string `${PREVIEW_URL:-http://localhost:4321/}`.
   LHCI does no shell-style `${VAR:-default}` expansion, so Lighthouse receives that
   literal string and dies with `INVALID_URL` on run #1 (CI log, run 37785271911, job
   113338513190). The budgets were never even evaluated. Fix the cause (pass a real URL
   from `ci.yml` via `--collect.url`), never the budgets.

### Major
3. **Newsletter confirm tokens never expire.** `confirm_token` has no expiry column; the
   "link has expired" page only fires for unknown tokens, so a leaked confirm link works
   indefinitely. Fix: migration `0012` adds `confirm_token_expires_at` (48h), set on
   signup/re-signup; the verify handler rejects expired tokens (legacy NULL = expired,
   forcing a fresh signup — documented choice).
4. **RFC 8058 one-click unsubscribe impossible.** The digest/welcome mail can only offer a
   GET unsubscribe link; Gmail one-click needs `List-Unsubscribe-Post:
   List-Unsubscribe=One-Click` plus an HTTPS endpoint that accepts POST. GET must stay
   prefetch-safe. Fix: add `POST /api/newsletter/unsubscribe` (email+token via query,
   JSON, or urlencoded body incl. the `List-Unsubscribe=One-Click` one-click body),
   rate-limited, token-verified, idempotent `{ok:true}` on any token (no oracle).
   The global `csrfGuard` would 403 Gmail's `application/x-www-form-urlencoded` POST,
   so it gets a narrow, documented exemption for exactly this path (Origin rule still
   applies; the endpoint only acts on an unguessable per-recipient token).
5. **Unguarded Resend failures 500 the request after the row is written.**
   `POST /api/newsletter` and `POST /api/auth/request-code` `await sendEmail(...)` with
   no try/catch — a Resend outage throws unhandled (newsletter: subscriber stored as
   pending, no confirm email ever sent; auth: code in KV, no email). Fix: try/catch,
   log to `email_log` as `failed` with the error; newsletter still returns `{ok:true}`
   (user can re-submit to regenerate the token/email); auth returns a clean 503 without
   leaking validity.
6. **`npm audit` cannot run in this sandbox** (registry POST `/security/audits/quick`
   blocked by egress policy `zz_managed_internal_spaces_package_registries`). CI's audit
   job is the source of truth; locally I verified via the OSV API (same GitHub Advisory
   data) against every pinned version in both lock files. Reported honestly in
   verification below.

### Minor
7. **API HTML responses (`page()` verify/unsubscribe pages) carry no CSP.** The API
   security-header middleware sets nosniff/DENY/referrer/permissions but no
   `Content-Security-Policy`. Fix: add a tight page CSP
   (`default-src 'self'; style-src 'unsafe-inline'` for the inline-styled pages,
   `img-src 'self' data: https:` for the logo, `object-src 'none'`, `base-uri 'self'`,
   `form-action 'self'`).
8. **Stale F3 comment in `api/src/lib/csrf.ts`.** The NOTE claims the SameSite=None
   cookie branch is "kept until F3" — F3 (same-origin API, SameSite=None fully removed)
   shipped and was independently re-verified. Fix: replace with the current rationale.
9. **`_headers` global CSP allows `img-src https:` (any host).** Acceptable for a
   content site (blog images), but recorded: tightening to an allowlist is possible
   future work, not done here to avoid breaking author content.
10. **esbuild low-severity advisory (GHSA-g7r4-m6w7-qqqr, dev-server file read on
    Windows).** Below the `--audit-level=high` gate; fixed as a side effect of the
    astro 7 upgrade (esbuild ^0.28.0).

## What passed (verified, not changed)
- `_headers`: HSTS (1yr + includeSubDomains), CSP without `unsafe-inline`/`unsafe-eval`
  in script-src, X-Frame-Options DENY, nosniff, strict-origin-when-cross-origin
  Referrer-Policy, minimal Permissions-Policy. `/cms/*` correctly detaches the global
  CSP for Decap's `unsafe-eval` (documented, only place it appears).
- CORS: exact allowlist, no wildcard; production domains get no CORS headers
  (same-origin via `/api/*`); branch-preview regex is anchored to the project's own
  `pages.dev` zone.
- Cookies: `__Host-` prefix, `Path=/; HttpOnly; Secure; SameSite=Lax`, no Domain
  attribute, set from a single `setSessionCookie` helper. Zero `SameSite=None`
  remnants in code.
- CSRF guard: Origin allowlist + JSON/multipart content-type rule on all mutating
  routes.
- No secrets in code (scanned before commit); Canadian spelling in user-facing
  strings (checked new/changed strings).

## Implementation notes
- `site/package.json`: `astro` ^5.0.0 → ^7.3.8; lock regenerated with
  `npm install --package-lock-only`. Post-upgrade tree per OSV: sharp drops out
  entirely (astro 7 no longer bundles it — the three sharp advisories GHSA-f88m-g3jw-g9cj,
  GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w are gone), http-cache-semantics resolves to
  4.3.0 (clean for GHSA-ch52-4w7c-c8xp), all 10 astro advisories cleared.
- `ci.yml` lighthouse step now computes `URL="${PREVIEW_URL:-http://127.0.0.1:4321/}"`
  and runs `lhci autorun --collect.url="$URL"` (CLI overrides the unexpanded rc value).
  `.lighthouserc.json` untouched — budgets identical.
- Migration `0012_newsletter_token_expiry.sql` is additive (`ADD COLUMN`, nullable);
  safe to apply on preview/prod via the normal wrangler migration flow.
- The email crew's `audit/email` branch touches `email.ts`/`cron.ts`/`auth.ts`
  cosmetically; this branch's changes to those files are the three assigned items only,
  kept minimal for a clean merge.

## Verification (2026-10-08, worktree audit/security-ci)
- [x] `npx vitest run` green (api): **250/250 pass, 17 files** (baseline 236 + 14 new:
  4× RFC 8058 POST unsubscribe, 3× confirm-token expiry, 1× newsletter Resend outage,
  3× auth request-code Resend outage, 3× CSRF one-click exemption)
- [x] `npx tsc --noEmit` clean (api)
- [x] site `npm run build` clean (astro 7.3.8, 20 pages; only pre-existing warning is
  the empty `pages` CMS collection)
- [x] Advisory check on final lock trees via OSV (same GitHub Advisory data npm audit
  uses): **0 advisories in site (259 pkgs) and api (170 pkgs)** — the CI
  `--audit-level=high` gate has nothing left to fail on
- [x] secret scan clean (only test placeholder tokens)
- [x] Canadian spelling checked on new/changed user-facing strings

### CI job prognosis (honest)
- **audit job**: will go green — every advisory the 2026-10-08 CI log flagged is
  resolved by real upgrades (astro 5.18.2→7.3.8, sharp 0.34.5→0.35.5 via astro 7,
  http-cache-semantics 4.2.0→4.3.0 via overrides, wrangler 4.146.0→4.149.0 for the
  api-tree sharp 0.35.4→0.35.5). No thresholds weakened, no ignores added.
  Caveat: verified via OSV, not `npm audit` itself (registry audit POST is blocked
  by this sandbox's egress policy); the advisory data is identical.
- **lighthouse job**: the INVALID_URL root cause is fixed (real URL now passed via
  `--collect.url`; budgets untouched). Whether the *budgets* then pass is unproven
  here — no Chrome in this sandbox to run LHCI locally. The job was failing before
  any measurement, so this was purely an infra/config bug; perf assertions are a
  separate, still-unknown gate.
- **secrets job**: untouched (PR #13's area).

### Follow-ups for the parent
- Merge coordination: `audit/email` also touches `api/src/lib/email.ts`,
  `api/src/routes/auth.ts`, `api/src/cron.ts` (cosmetic/template fixes). This
  branch's changes there are the three assigned items only; merge order may need a
  rebase.
- Migration `0012` applies on next wrangler deploy (0010/0011 still pending remote
  too — pre-existing).
- The 503-on-Resend-outage in `/auth/request-code` is a transient validity signal
  (unknown emails get 200, known get 503 during an outage). Accepted per the email
  crew's "clean 5xx" instruction; alternative (silent ok:true) strands real users.
