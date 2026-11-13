-- Poll close notifications (social-UX reconciliation pass).
-- Idempotency marker so the 15-minute cron notifies each poll's voters
-- exactly once when the poll closes. Additive and nullable.
ALTER TABLE polls ADD COLUMN notified_closed_at TEXT;
