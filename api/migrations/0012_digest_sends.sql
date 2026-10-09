-- 0012_digest_sends.sql — retry-safe weekly digest (cron idempotency).
--
-- The weekly digest send loop is at-least-once: a cron retry or overlapping
-- invocation after a partial send must not re-mail subscribers. digest_id is
-- the Monday (UTC) of the digest week, e.g. 'digest-2026-10-05'. The cron
-- handler INSERT OR IGNOREs one row per subscriber BEFORE sending and skips
-- the send when the insert changes 0 rows (already sent this run).

CREATE TABLE digest_sends (
  digest_id TEXT NOT NULL,
  email     TEXT NOT NULL,
  sent_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (digest_id, email)
);
