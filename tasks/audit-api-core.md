# Audit: core API routes (audit/api-core)

Scope: `api/src/routes/{introduction,newsletter,forms,search,events}.ts`,
`api/src/lib/{validate,turnstile,ratelimit-d1}.ts`, and the five route-registration
lines in `api/src/index.ts` (left byte-identical). Baseline: 236/236 vitest green,
`tsc --noEmit` clean.

## Errors found

### Critical

1. **Newsletter confirm tokens never expire** (`newsletter.ts` → `GET /verify`).
   The lookup is `WHERE confirm_token = ? AND status = 'pending'` with no age check;
   `created_at` exists on the table but is never read. A confirmation link from
   months ago still activates the subscription. Double opt-in tokens must be
   short-lived (48 h).
2. **Newsletter verify sends email outside try/catch** (`newsletter.ts` → `GET /verify`).
   The welcome + owner `sendEmail` calls are unguarded. A Resend outage *after* the
   row was activated throws into `onError`, so a user who just clicked a valid
   confirm link sees a bare `{ok:false}` 500 even though they are now subscribed.

### Major

3. **RSVP capacity check-then-insert race** (`events.ts` → `POST /events/:slug/rsvp`).
   Capacity is enforced with SELECT-then-INSERT. Two concurrent requests can both
   pass the check and both insert, overselling a capped event. The `ON CONFLICT`
   upsert only dedupes per (event, email), it does not bound the total.
4. **No idempotency on POST /api/introduction.** A double submit (retry, double
   click) inserts two rows and sends two owner-notify + two confirmation emails.
5. **No idempotency on POST /api/forms/:slug/submit.** Same double-submit
   problem: duplicate `form_submissions` rows and duplicate notify emails.
6. **Newsletter POST confirm-email send is unguarded** (`newsletter.ts` → `POST /`).
   If Resend throws, the row sits in `pending` with no confirm link ever emailed
   and the user gets a bare 500. Unlike introduction.ts, the failure is not logged
   to `email_log`.
7. **Form-submit notify emails are never logged** (`forms.ts` → `POST /:slug/submit`).
   The notify `sendEmail(...).catch(() => {})` swallows failures with no
   `email_log` row (sent or failed) — inconsistent with introduction/newsletter,
   and invisible to admins.
8. **Turnstile siteverify has no timeout** (`lib/turnstile.ts`). A hung upstream
   stalls the worker invocation. (Precedent: `cron.ts:151` already uses
   `AbortSignal.timeout`.)
9. **`await c.req.json()` results assumed to be objects.** A valid-JSON but
   non-object body (`null`, `[]`, `"x"`) makes `data.website` / `data.title` throw
   → 500 via `onError`. Affects: introduction POST, newsletter POST, forms submit,
   forms admin create, events RSVP, events admin create/patch.
10. **Unguarded `JSON.parse` on stored data** (`forms.ts`). `parseFields` parses
    `form_fields.options` and the admin submissions list parses
    `form_submissions.data` with no try/catch — one corrupt row 500s the whole
    public form page / admin list.

### Minor

11. **Inconsistent error envelopes.** Several failures return bare `{ok:false}`
    with no `error` message: malformed-JSON 400s (introduction, newsletter,
    forms submit, events RSVP), missing `RESEND_API_KEY` 500s (introduction,
    newsletter).
12. **SQL string interpolation in `events.ts`.** `GET /events` interpolates the
    `${NOW}` constant into the query text. Not user input, but it violates the
    no-interpolation rule — bind the timestamp.
13. **Dead code / misplaced export.** `events.ts` imports `getCookie` and
    destructures `RATE_LIMIT_KV` without using either; `forms.ts` destructures
    unused `RATE_LIMIT_KV` and has `export default app;` stranded mid-file
    (public routes are defined after it — works, but misleading).
14. **Inconsistent `page()` env passing** (`newsletter.ts`). Only the verify-failure
    page passes `c.env`, so the `SITE_URL` override is ignored on the other pages.
15. **Missing index on `newsletter_subscribers.confirm_token`.** Every verify does
    a token lookup with no index.
16. **`pruneRateLimits` is never called.** `api/src/cron.ts` does not reference it
    (read-only check) — the `rate_limits` table grows unboundedly. Flagged for the
    cron owner; `cron.ts` is out of scope for this branch.
17. **Events admin CRUD is incomplete.** No `DELETE /admin/events/:id`
    (`event_rsvps` already has `ON DELETE CASCADE`).
18. **Email case inconsistency.** Newsletter and RSVP lowercase emails (RSVP
    dedupe depends on it); introduction stores the address as typed.
19. **Forms submit has no honeypot field** (introduction/newsletter/RSVP do;
    Turnstile covers it, but the check is one line).
20. **Non-scalar `responses` values become `"[object Object]"`.** `cleanStr`
    coerces objects/arrays via `String()` — a data-quality gap for text/email/
    textarea/select fields.
21. **Re-subscribing an `unsubscribed` address leaves stale `unsubscribed_at`.**
    Cosmetic.

### Checked and clean

- No user-input string interpolation anywhere: every query is a prepared
  statement with bound params (PATCH column lists use hardcoded column names).
- No stack traces leaked: `onError` returns bare `{ok:false}`; the missing-key
  test asserts no `stack`/`Error:` in the body.
- Rate limits on all public write endpoints (intro 5/h, newsletter 3/h, forms 5/h,
  RSVP 5/h, search 30/min, verify/unsubscribe 30/h) via the atomic D1 upsert.
- Turnstile fails closed on all public forms; honeypot preserved.
- Search never exposes members-only lessons (`is_preview = 1` + published course);
  LIKE wildcards escaped; query bounded 2–100 chars.
- `sendEmail` takes the Resend key from env only — no secret in code (verified).
- Canadian spelling clean in all user-facing strings of the audited files.
- KV TTLs: not applicable — these routes do no KV writes.

## Fixes implemented (audit/api-core)

- `lib/turnstile.ts`: `AbortSignal.timeout(8000)` on the siteverify fetch.
- `lib/validate.ts`: added `isRecord()` guard; all JSON bodies validated as
  records before field access (fixes #9 everywhere).
- `newsletter.ts`: 48 h confirm-token expiry (fixes #1); verify welcome/owner
  sends wrapped in try/catch with `email_log` rows, success page still rendered
  (fixes #2); POST confirm-send failure logged as `failed` and returned as a
  500 with a message (fixes #6); consistent `error` envelopes (fixes #11);
  `page()` always receives `c.env` (fixes #14).
- `events.ts`: capacity enforced pre-write (existing check) **plus** post-write
  verify with restore-or-delete on oversell, closing the race (fixes #3);
  `NOW` bound as a parameter (fixes #12); removed dead import/destructure
  (fixes #13); added `DELETE /admin/events/:id` (fixes #17); object checks on
  admin create/patch (part of #9); malformed-JSON 400 carries an error (#11).
- `introduction.ts`: idempotency via `Idempotency-Key` header or
  `idempotency_key` body field, backed by a UNIQUE column; duplicate delivery
  returns `{ok:true}` without re-inserting or re-sending (fixes #4); email
  lowercased (fixes #18); error envelopes on 400/500 (#11).
- `forms.ts`: same idempotency-key support on submit (fixes #5); notify emails
  now logged to `email_log` as sent/failed (fixes #7); `website` honeypot on
  submit (fixes #19); non-scalar response values rejected with 400 (fixes #20);
  `parseFields` and the admin submissions list tolerate corrupt JSON (fixes #10);
  `export default` moved to end of file, dead destructure removed (#13); error
  envelopes (#11).
- `api/migrations/0012_api_core_audit.sql`: index on
  `newsletter_subscribers(confirm_token)` (#15); `idempotency_key` columns +
  unique indexes on `introduction_requests` and `form_submissions` (#4, #5).
  **Deploy note:** apply with `wrangler d1 execute --remote --file` before the
  worker build that references the columns; the routes degrade gracefully
  (fall back to keyless insert) if the column is not yet present.
- Tests added: token expiry, verify email-outage still shows success,
  newsletter confirm-send failure logging, null-body 400s, idempotency dedupe
  (intro + forms), capacity-race restore/delete, admin event DELETE, corrupt
  options/data JSON tolerance, non-scalar response rejection, `isRecord`,
  Turnstile timeout signal.

## Open / out of scope

- `pruneRateLimits` wiring belongs to the cron owner (#16).
- `sendEmail` (in `lib/email.ts`, out of scope) has no fetch timeout — flagged
  for the email-lib owner; same for any retry/backoff policy.
- `index.ts` route-registration lines for the five routes left byte-identical.
