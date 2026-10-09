-- 0012_api_core_audit.sql — audit(api-core) fixes.
--  * index for newsletter double-opt-in token lookups (GET /api/newsletter/verify)
--  * idempotency_key columns (+ unique indexes) for introduction_requests and
--    form_submissions, backing client-supplied idempotency keys on the public
--    POST endpoints. SQLite UNIQUE permits multiple NULLs, so existing rows
--    and keyless inserts are unaffected.

CREATE INDEX IF NOT EXISTS idx_subscribers_confirm_token
  ON newsletter_subscribers(confirm_token);

ALTER TABLE introduction_requests ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_intro_idem
  ON introduction_requests(idempotency_key);

ALTER TABLE form_submissions ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_sub_idem
  ON form_submissions(idempotency_key);
