# Admin + CMS Audit (admin-cms crew, 2026-10-08)

Scope: `api/src/routes/{admin.ts,studio.ts,sync.ts,metrics.ts}` + tests,
`site/src/pages/{admin.astro,studio.astro}`, `site/public/cms/**` (Decap config
+ editorial.js). Read-only review of `api/src/routes/{auth.ts,oauth.ts}` and
`api/src/lib/auth.ts` where the admin surface depends on them.

Method: read every file, traced every admin endpoint server-side, tested the
editorial.js guardrail logic in Node with a stubbed Decap `CMS` object,
verified Decap 3.16.3's `prePublish` semantics in the vendored bundle
(a rejected promise is awaited before `persistEntry`, so it genuinely blocks
publishing), and confirmed the six admin sections against their API contracts.

## Errors found

### Critical

1. **Decap `config.yml` blog collection does not match the Astro content model.**
   Decap writes `excerpt`, `date`, and pillar `members-and-hub`. The canonical
   schema (`site/src/content/config.ts`, and every real post on disk) requires
   `description`, `publishDate`, and pillar `members-hub`, with optional `tags`
   and `author`. Any blog post created in Decap fails zod validation, so Astro
   drops the entry (or the build errors). Studio's schema already matches the
   model; Decap is the outlier. Fix: rewrote the blog fields in `config.yml`.

2. **Studio `/commit` had zero server-side editorial guardrails.** All checks
   (Canadian spelling, banned hype/income phrases, member anonymity, SEO,
   testimonial attribution) lived only in Decap's browser-side `editorial.js`.
   An admin saving through Studio could publish "10x passive income" copy or a
   member's full name with no check at all. Fix: new shared
   `api/src/lib/editorial.ts` enforcing the same rules server-side on
   `POST /api/studio/commit` (HTTP 422 with the issue list on violation).

### Major

3. **Invite creation had no input validation** (`POST /api/admin/invites`).
   `max_uses: 0` created an instantly-dead code, negative/huge/string values
   were accepted, and negative `expires_days` produced an already-expired code.
   Fix: `max_uses` must be an integer 1-100 (default 1), `expires_days` an
   integer 1-365 or omitted.

4. **Invite codes could not be revoked.** Once created, a leaked code was
   usable until expiry/uses ran out. Fix: `DELETE /api/admin/invites/:id`
   (audit-logged) plus a Revoke button in the admin Invites tab.

5. **Admin Metrics tab was broken.** `loadMetrics()` rendered the raw API
   response keys, producing cards for `ok: true`, `generatedAt`, and
   `[object Object]` for every grouped count. Fix: rewrote the tab to render
   labelled count cards per group.

6. **Audit log omitted the actor and was append-only by convention only.**
   `GET /api/admin/audit` returned action/detail/created_at with no actor, and
   nothing in the schema stopped an UPDATE/DELETE of audit rows. Fix: the
   endpoint now joins `users` for the actor email + returns `actor_id`, and new
   migration `0012_audit_immutable.sql` adds triggers that abort any
   UPDATE or DELETE on `audit_log`.

7. **Intro status update audited phantom rows.** `POST /api/admin/intros/:id`
   wrote an audit entry even when the id did not exist. Fix: 404 when the intro
   is not found, no audit write.

8. **Studio course schema drifted from the content model.** Level option
   `founder` does not exist (sync + Decap + sample content use
   `foundations|builder|operator`); status lacked `archived` which Decap and
   the sync endpoint both support. Fix: `operator`, added `archived`.

9. **`POST /api/admin/sync/courses` had no rate limiting.** Every other
   mutation endpoint is rate-limited. Fix: 60/hour per actor via the D1 limiter.

10. **Studio `newFile()` filename bug.** `slugify(...) + ext || "untitled"+ext`
    can never fall through (empty slug still yields `".md"`), so a blank name
    created a file literally called `.md`. Fix: fall back to `untitled` first.

### Minor

11. `metrics.ts` declared an unused `SESSIONS_KV` in its Env type. Removed.
12. `editorial.js` SEO check read `excerpt` for blog posts; the content model
    uses `description`. Now checks `description || excerpt`.
13. `config.yml` comment pointed at a wrong path (`site/src/cms/editorial.js`);
    corrected to `site/public/cms/editorial.js`.
14. Admin Users tab loaded only the first 25 users with no search, though the
    API supports `q`/`page`/`limit`. Added a search box and prev/next paging.
15. Admin Audit tab now shows the actor email per entry.

### Verified healthy (no change)

- Every admin endpoint is server-side gated (`requireAdmin` re-reads the role
  from D1 per request; studio/sync use `getAdminUser` or the bearer sync
  secret). The existing `admin-gates.test.ts` sweep passes; non-admin tokens
  get 401/403 on all targets.
- Decap GitHub OAuth flow (`oauth.ts`): state CSRF cookie (signed, 10 min),
  postMessage targets the Referer-validated CMS origin (never `*`), scope is
  `public_repo`, client id/secret are worker secrets. No secrets in
  `site/public/cms/` (scanned).
- Metrics queries are index-backed GROUP BY aggregates
  (`idx_intro_status`, `idx_subscribers_status`, `idx_email_log_kind`,
  users role has no index but the table is tiny and the query is a single
  grouped count). No full-table scans of concern.
- Invite redeem validates expiry and remaining uses, rate-limited at 5/hour.
- `editorial.js` prePublish logic tested: clean posts pass; hype, US spelling,
  real names, full-name attributions, and thin content are all blocked with
  clear messages; brand phrases ("Brimwood Innovation", "Elite by effort") are
  not false-flagged.

### Out of area (reported, not fixed)

- `auth.ts` invite redeem is check-then-increment: two concurrent redemptions
  of a single-use code could both succeed. Needs an atomic
  `UPDATE ... SET uses = uses + 1 WHERE id = ? AND uses < max_uses
   AND (expires_at IS NULL OR expires_at > now)` and a changes-count check.
  Flagging for the auth crew.

## Verification

- `npx vitest run` in `api/`: green (was 236, now higher with new tests).
- `npx tsc --noEmit` in `api/`: clean.
- `npm run build` in `site/`: clean (admin.astro + studio.astro touched).
- New migration validated against local sqlite3 (trigger syntax + abort
  behaviour); never touched remote D1.
- Pre-commit secret scan: no credentials in the diff.

## Files changed

- `api/src/lib/editorial.ts` (new), `api/src/lib/editorial.test.ts` (new)
- `api/src/routes/studio.ts`, `api/src/routes/studio.test.ts`
- `api/src/routes/admin.ts`, `api/src/routes/admin.test.ts` (new)
- `api/src/routes/sync.ts`, `api/src/routes/metrics.ts`
- `api/migrations/0012_audit_immutable.sql` (new)
- `site/public/cms/config.yml`, `site/public/cms/editorial.js`
- `site/src/pages/admin.astro`, `site/src/pages/studio.astro`
