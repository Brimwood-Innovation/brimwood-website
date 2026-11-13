# Brimwood Website — Full Platform Audit (2026-10-08/09)

Branch: `audit/all-features` (from `develop` @ e67ff4e). Method: 8 parallel crews
(site, api-core, academy, auth, admin-cms, community, email, security-ci), each
running audit → research → implement → verify on its own branch, then merged here
with conflict resolution. Nothing merged to develop or main.

## Verification (final, on the merged branch)

- `npx vitest run` (api/): **405/405 green** (25 files; baseline was 236)
- `npx tsc --noEmit` (api/): clean
- `npm run build` (site/): clean, 20 pages
- Secret scan on the full diff: clean
- `npm audit`: endpoint blocked in this sandbox; the security-ci crew verified
  0 advisories against the OSV API (same GitHub Advisory data) for the final
  lock trees in site/ and api/.

## Critical findings (fixed)

1. **Members-only video leaked via edge cache** (academy). `GET /api/video/:key`
   set `Cache-Control: public` on every response; edge cache keys on URL only, so
   one member's view could be served to anonymous users. Now `private` for gated
   video, `public` only for preview/public-course video.
2. **Stale session role trusted for authorization** (auth). `academy.ts`/`video.ts`
   used the role cached in the session row (up to 30 days old) to bypass enrolment
   checks — a demoted admin kept access. New `isAdminUser()` re-reads role from D1;
   `PATCH /admin/users/:id` destroys all sessions on demotion/suspension; and
   `readSession` now JOINs `users`, enforcing `status='active'` with the live role.
3. **Newsletter confirm tokens never expired** (api-core/security-ci). Resolved to a
   `confirm_token_expires_at` column (48h, refreshed on re-subscribe); expired and
   legacy-NULL tokens read as unknown (no oracle). Migration `0015`.
4. **Resend failure after newsletter activation threw a bare 500** (api-core). The
   welcome/owner mails are now best-effort + logged; the success page always renders.
5. **Revoked public profile stayed live** (community). `/u/[id]` and `/@username`
   are statically prerendered; turning OFF "Make my profile public" left the old
   profile served until the next build. `profile-refresh.js` now self-heals to a
   "This profile is private" notice on 404.
6. **Astro 5.18.2 carried a critical RCE advisory** (GHSA-26w7-cxv4-gfx2, CVSS 9.8,
   AVIF/Sharp). Upgraded `astro` ^5 → ^7.3.8 (clears all 10 astro advisories; sharp
   0.34.5→0.35.5 clears 3 more), `http-cache-semantics` override ^4.3.0, `wrangler`
   ^4.149.0 (fixes a HIGH sharp/librsvg advisory published 2026-10-06).
   `src/content/config.ts` → `src/content.config.ts` for Astro 6+.
7. **Organization JSON-LD never rendered** (site). `{JSON.stringify(...)}` inside
   `<script>` is emitted literally by Astro — every page shipped source code, not
   schema. Fixed with `set:html`; BlogPosting moved to `<head>` via a `jsonld` prop.
8. **RSS feed linked to `/blog/undefined/`** (site). `rss.xml.js` used `p.slug`,
   which doesn't exist on glob-loader entries. Fixed to `p.id`; added atom self
   link, lastBuildDate, isPermaLink guids.
9. **Favicons 404 + SVG og:image** (site). Base referenced four missing icon files;
   `og:image` was an SVG scrapers can't read. Kit `04-Favicon` files added verbatim;
   1200×630 `brimwood-og.png` composed from kit assets only.
10. **Draft blog posts built publicly** (site). `getStaticPaths`, blog index, and
    sitemap didn't filter `draft: true`. Now filtered at the data layer everywhere.
11. **Broken logo in every email** (email). `LOGO_URL` pointed to
    `brimwoodinnovation.com/logo-email.png`, which didn't exist (and was
    git-ignored). Rendered a 560×167 PNG from the kit's reversed logo, committed at
    `site/public/logo-email.png`.
12. **Decap `config.yml` didn't match the Astro content model** (admin-cms). Decap
    wrote `excerpt`/`date`/pillar `members-and-hub`; the schema requires
    `description`/`publishDate`/pillar `members-hub` + `tags`/`author`. Any
    Decap-created post would fail zod validation and be dropped.
13. **Studio `/commit` had zero server-side editorial guardrails** (admin-cms). All
    checks lived in Decap's browser JS. New `api/src/lib/editorial.ts` enforces
    identical rules server-side (422 + issue list).
14. **Login timing oracle** (auth). Unknown/suspended/password-less emails returned
    fast; valid users burned ~600k PBKDF2 iterations. Failure paths now burn a dummy
    verify (spy-tested: exactly 1 call on both paths).
15. **Invite redeem check-then-increment race** (auth). Concurrent redemptions of a
    single-use code could both succeed. Atomic `UPDATE ... WHERE uses < max_uses`.

## Major findings (fixed)

- Range requests mishandled (404 instead of 416, negative lengths, suffix ranges
  mis-served) — rewritten with strict parsing (academy).
- Weekly digest not retry-safe — `digest_sends(digest_id, email)` PK, INSERT OR
  IGNORE before each send (migration `0013`) (academy).
- Dashboard "Completed ✓" was dead (`enrollments.completed_at` never written) —
  now derived in-query (academy).
- Progress math counted any-status/unpublished lessons (could exceed 100%) —
  now `status='completed'` + published only (academy).
- N+1 on course detail → single `IN` query (academy).
- Video 404 on keys containing `/` (route now `/:key{.+}`) (academy).
- Course `visibility` selected but never enforced — `'public'` fully open,
  `'members'` default keeps gating (academy).
- No idempotency on introduction/form submits — `Idempotency-Key` header/body field
  backed by UNIQUE columns (migration `0012`) (api-core).
- RSVP capacity check-then-insert race — pre-check + post-write verify with
  restore-or-delete (api-core).
- Unguarded `JSON.parse` / non-object bodies → 500s — `isRecord()` guards (api-core).
- Turnstile siteverify had no timeout — `AbortSignal.timeout(8000)` (api-core).
- Comment impersonation via free-form name (community — mitigated by
  held-for-moderation + Turnstile + rate limits; recommend folding into
  `/admin/reports`).
- Profile editor `esc()` only escaped `<` inside quoted attributes (community).
- Weekly digest had no `List-Unsubscribe` header; brittle triple-`.replace()`
  personalization rebuilt as `digestBody()`; RFC 8058 one-click via new
  `POST /api/newsletter/unsubscribe` (token-verified, idempotent, prefetch-safe
  GET) (email/security-ci).
- Invite creation had no validation (`max_uses: 0` = dead code) — now 1–100,
  `expires_days` 1–365; added invite revoke `DELETE /api/admin/invites/:id` +
  UI button (admin-cms).
- Admin Metrics tab rendered raw API keys (`[object Object]`) — rewritten as
  labelled count cards; Users tab got search + pagination (admin-cms).
- Audit log omitted the actor and was append-only by convention — now joins users
  for actor email/id; triggers abort UPDATE/DELETE (migration `0014`) (admin-cms).
- Password change didn't kill other sessions; `pruneSessions`/`pruneRateLimits`
  were dead code — wired into the 5-min cron (rate-limit keys are
  attacker-controlled → was unbounded storage) (auth).
- Magic-code: TTL extended on failed attempts (now strict), 6-digit modulo bias
  (rejection sampling), per-email throttles, stale reset tokens invalidated,
  OAuth PKCE (S256) + `safeEqual` state compare (auth).
- Lighthouse CI failed on every run — not on performance: `collect.url` used
  `${PREVIEW_URL:-...}` which LHCI never expands (literal `INVALID_URL`). Now
  resolved in `ci.yml`; budgets untouched (security-ci).
- CSP tightened on API `page()` HTML (`script-src 'none'`); stale F3
  `SameSite=None` comment corrected; narrow CSRF exemption for the one-click
  POST path only (security-ci).
- `sendEmail` had no fetch timeout — `AbortSignal.timeout(15000)` (merge phase).
- Site: sitemap gained `/events`, `/invite`, `/search`, `<lastmod>`; robots.txt
  disallows `/cms/`, `/admin`, `/dashboard`, `/members/`, `/api/`; `llms.txt`
  route coverage; 44px touch targets; `role="status"` regions; `lang="en-CA"`;
  print stylesheet; non-kit hexes replaced; `_headers` CSP `connect-src` cleaned.

## Deliberate merge decisions (documented)

- **Newsletter POST Resend failure: fail loudly (500), not ok:true.** Two crews
  disagreed. Pre-subscription the confirm email IS the flow — a false ok leaves
  the user in limbo; a clear 500 lets them retry immediately. (Post-activation
  welcome mails stay best-effort.) Test updated to assert this.
- **Verify expiry: `confirm_token_expires_at` column, not `created_at` math.**
  api-core's `created_at` approach broke on re-subscribe (UPDATE didn't refresh
  `created_at`, so a fresh token could read as expired). Column is set on both
  INSERT and UPDATE.
- **Academy gating: kept `course_visibility='public'` bypass AND the live-role
  check** — the auth crew's version dropped the visibility check; the merged code
  has both. Video keeps the 404-on-unknown-key (don't leak bucket contents).
- **Migrations renumbered:** four crews each wrote `0012_*`; now
  `0012_api_core_audit`, `0013_digest_sends`, `0014_audit_immutable`,
  `0015_newsletter_token_expiry`. All additive/nullable; remote is at 0009 per the
  F2 audit — nothing applied remotely by this task.
- **Community scope held:** feed, DMs, groups, reactions, repost/quote were NOT
  built — each needs new D1 tables + routes + UI; none is genuinely small.
  Built-vs-designed: 3 built, 2 partial, 14 missing (see tasks/audit-community.md).

## Open items (not changed — need founder or a follow-up)

- Turnstile: if `TURNSTILE_SECRET_KEY` was never set in the production worker env,
  the public comment form can never succeed — needs a production env check.
- "Toronto · Coming soon" eyebrow + countdown may be stale post-cutover — copy
  call for the founder.
- Lighthouse budgets now actually run in CI for the first time — the gate may fail
  on real measurements; no Chrome in this environment to pre-verify.
- `members.astro`/`dashboard.astro` were excluded from the site crew's area and not
  re-audited here (owned by other areas' page scopes — verify before Gate 1).
- Footer TikTok/Reddit links need verified URLs (flagged by site crew).
