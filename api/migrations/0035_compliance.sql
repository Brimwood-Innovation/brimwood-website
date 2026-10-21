-- 0035_compliance.sql: export, deletion with grace, consent, retention, breaches.
--
-- Why (audit 06 P1-14, S19 to S24; PIPEDA, CASL):
-- - Members can download their data; the link lives 7 days (L1090).
-- - Deletion has a 14-day grace with Undo (L1090). During grace the member is
--   signed out everywhere and hidden from the directory, at once, by trigger.
-- - CASL needs proof of consent: who, when, how, which form and policy version.
-- - Every PII table without a natural end has a purge rule (retention_policies)
--   and, where the table is new, a purge_after column with an index.
-- - PIPEDA requires a record of every breach of security safeguards, kept at
--   least 24 months.

CREATE TABLE data_export_requests (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','expired','failed')),
  r2_key             TEXT,                          -- private bucket only
  requested_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ready_at           TEXT,
  expires_at         TEXT,
  download_count     INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  last_downloaded_at TEXT,
  CHECK (status <> 'ready' OR (r2_key IS NOT NULL AND ready_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR (julianday(expires_at) - julianday(ready_at)) <= 7.0001)
);
CREATE UNIQUE INDEX idx_data_exports_one_open ON data_export_requests (user_id) WHERE status IN ('queued','ready');
CREATE INDEX idx_data_exports_expiry ON data_export_requests (expires_at) WHERE status = 'ready';

CREATE TABLE deletion_requests (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  due_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+14 days')),
  delete_content INTEGER NOT NULL DEFAULT 0 CHECK (delete_content IN (0,1)),  -- "also delete my posts"
  cancelled_at   TEXT,
  completed_at   TEXT,
  CHECK (abs(julianday(due_at) - julianday(requested_at) - 14) < 0.0001),
  CHECK (cancelled_at IS NULL OR completed_at IS NULL)
);
CREATE UNIQUE INDEX idx_deletion_one_open ON deletion_requests (user_id)
  WHERE cancelled_at IS NULL AND completed_at IS NULL;
CREATE INDEX idx_deletion_due ON deletion_requests (due_at) WHERE cancelled_at IS NULL AND completed_at IS NULL;
-- Undo works only inside the grace period; completion only after it.
CREATE TRIGGER trg_deletion_undo_in_grace
BEFORE UPDATE OF cancelled_at ON deletion_requests
WHEN NEW.cancelled_at IS NOT NULL AND (NEW.cancelled_at > OLD.due_at OR OLD.completed_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'the 14-day grace period is over');
END;
CREATE TRIGGER trg_deletion_complete_after_grace
BEFORE UPDATE OF completed_at ON deletion_requests
WHEN NEW.completed_at IS NOT NULL AND (NEW.completed_at < OLD.due_at OR OLD.cancelled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'deletion completes only after the 14-day grace period');
END;
-- At request time: sign out everywhere, leave the directory, hide the profile.
CREATE TRIGGER trg_deletion_start_grace
AFTER INSERT ON deletion_requests
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.user_id;
  UPDATE member_profiles SET directory_opt_in = 0, activity_broadcast = 0 WHERE user_id = NEW.user_id;
  UPDATE users SET show_profile = 0 WHERE id = NEW.user_id;
  INSERT INTO security_events (id, user_id, kind) VALUES (lower(hex(randomblob(16))), NEW.user_id, 'deletion_requested');
END;

-- PII-free tombstones: re-apply deletions after a Time Travel restore (S20).
CREATE TABLE deletion_tombstones (
  subject_hmac TEXT PRIMARY KEY CHECK (length(subject_hmac) = 64),
  deleted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID;

-- Consent records (S21). Append-only: the current consent is the newest row
-- per (subject, purpose). Rows survive account deletion as CASL proof.
CREATE TABLE consent_records (
  id             TEXT PRIMARY KEY,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  email_hmac     TEXT CHECK (email_hmac IS NULL OR length(email_hmac) = 64),
  purpose        TEXT NOT NULL CHECK (purpose IN ('newsletter','member_nudges','wall_testimonial','spotlight',
                   'certificate_public','evidence_public','recording_appearance','directory',
                   'activity_broadcast','project_public','push')),
  granted        INTEGER NOT NULL CHECK (granted IN (0,1)),
  method         TEXT NOT NULL CHECK (method IN ('double_opt_in','settings_toggle','written','admin_recorded')),
  form_version   TEXT NOT NULL CHECK (length(form_version) BETWEEN 1 AND 40),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  evidence       TEXT CHECK (evidence IS NULL OR json_valid(evidence)),
  recorded_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (user_id IS NOT NULL OR email_hmac IS NOT NULL),
  CHECK (method <> 'admin_recorded' OR recorded_by IS NOT NULL)
);
CREATE INDEX idx_consent_user ON consent_records (user_id, purpose, created_at DESC);
CREATE INDEX idx_consent_email ON consent_records (email_hmac, purpose, created_at DESC) WHERE email_hmac IS NOT NULL;
CREATE TRIGGER trg_consent_append_only
BEFORE UPDATE OF purpose, granted, method, form_version, policy_version, evidence, created_at, email_hmac ON consent_records
BEGIN
  SELECT RAISE(ABORT, 'consent_records is append-only');
END;
-- Only user_id may change, and only to NULL (account deletion keeps the proof).
CREATE TRIGGER trg_consent_user_only_to_null
BEFORE UPDATE OF user_id ON consent_records
WHEN NEW.user_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'consent_records is append-only');
END;
CREATE TRIGGER trg_consent_no_delete
BEFORE DELETE ON consent_records
BEGIN
  SELECT RAISE(ABORT, 'consent_records is append-only');
END;

-- Suppression list: the sender joins this before every send (S21).
CREATE TABLE email_suppressions (
  email_hmac TEXT PRIMARY KEY CHECK (length(email_hmac) = 64),
  reason     TEXT NOT NULL CHECK (reason IN ('bounce','complaint','unsubscribe','deleted_account')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID;

-- Wall testimonials need written permission on file (L971).
CREATE TABLE testimonials (
  id          TEXT PRIMARY KEY,
  member_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  quote       TEXT NOT NULL CHECK (length(quote) BETWEEN 10 AND 600),
  attribution TEXT NOT NULL CHECK (length(attribution) BETWEEN 2 AND 60),  -- initials only, e.g. "M., Foundations cohort 3"
  consent_id  TEXT NOT NULL REFERENCES consent_records(id),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER trg_testimonials_consent
BEFORE INSERT ON testimonials
WHEN NOT EXISTS (SELECT 1 FROM consent_records WHERE id = NEW.consent_id
                 AND purpose = 'wall_testimonial' AND granted = 1 AND method = 'written')
BEGIN
  SELECT RAISE(ABORT, 'a testimonial needs written consent on file');
END;

-- Retention schedule (S24). The daily purge job reads this table.
CREATE TABLE retention_policies (
  table_name   TEXT PRIMARY KEY,
  purge_column TEXT NOT NULL,
  retain_days  INTEGER NOT NULL CHECK (retain_days BETWEEN 1 AND 3650),
  lawful_basis TEXT NOT NULL CHECK (lawful_basis IN ('contract','consent','legal_obligation','legitimate_interest')),
  note         TEXT NOT NULL
);
INSERT INTO retention_policies (table_name, purge_column, retain_days, lawful_basis, note) VALUES
  ('auth_email_codes',      'created_at',  1,   'contract',            'Sign-in codes: 24 hours.'),
  ('webauthn_challenges',   'expires_at',  1,   'contract',            'Passkey challenges: 24 hours.'),
  ('rate_limits',           'window_start',2,   'legitimate_interest', 'Rate-limit windows: 48 hours.'),
  ('introduction_requests', 'purge_after', 365, 'legitimate_interest', 'Declined and spam intros: 12 months.'),
  ('certificate_lookups',   'purge_after', 90,  'legitimate_interest', 'Lookup log: 90 days.'),
  ('guest_passes',          'purge_after', 90,  'contract',            'Guest names: 90 days after the visit.'),
  ('webhook_deliveries',    'purge_after', 30,  'legitimate_interest', 'Delivery log: 30 days.'),
  ('security_events',       'purge_after', 396, 'legitimate_interest', 'Member security trail: 13 months.'),
  ('email_log',             'created_at',  180, 'legitimate_interest', 'Send log: 6 months.'),
  ('feed_legacy_quarantine','moved_at',    180, 'legitimate_interest', 'Review, then purge after 6 months.'),
  ('audit_log',             'created_at',  2555,'legal_obligation',    'Staff actions: 7 years, actor ids only. Purge job must not run here while 0014 triggers stand.'),
  ('privacy_breaches',      'retain_until',730, 'legal_obligation',    'PIPEDA breach record: 24 months minimum.');

-- introduction_requests (0004) holds non-member PII: add a purge date.
ALTER TABLE introduction_requests ADD COLUMN purge_after TEXT;
CREATE INDEX idx_intro_purge ON introduction_requests (purge_after) WHERE purge_after IS NOT NULL;
CREATE TRIGGER trg_intro_purge_on_decline
AFTER UPDATE OF status ON introduction_requests
WHEN NEW.status IN ('declined','spam') AND NEW.purge_after IS NULL
BEGIN
  UPDATE introduction_requests SET purge_after = strftime('%Y-%m-%dT%H:%M:%fZ','now','+365 days') WHERE id = NEW.id;
END;

-- Breach register (S23). Staff-only. Never deleted; kept at least 24 months.
CREATE TABLE privacy_breaches (
  id                        TEXT PRIMARY KEY,
  discovered_at             TEXT NOT NULL,
  occurred_from             TEXT,
  occurred_to               TEXT,
  description               TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 5000),
  data_categories           TEXT NOT NULL CHECK (json_valid(data_categories) AND json_type(data_categories) = 'array'),
  affected_count            INTEGER CHECK (affected_count IS NULL OR affected_count >= 0),
  real_risk_of_significant_harm INTEGER NOT NULL CHECK (real_risk_of_significant_harm IN (0,1)),
  opc_reported_at           TEXT,
  individuals_notified_at   TEXT,
  third_parties_notified_at TEXT,
  recorded_by               TEXT NOT NULL REFERENCES users(id),
  retain_until              TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (julianday(retain_until) - julianday(discovered_at) >= 729.999)
);
CREATE INDEX idx_privacy_breaches_open ON privacy_breaches (discovered_at)
  WHERE real_risk_of_significant_harm = 1 AND opc_reported_at IS NULL;
CREATE TRIGGER trg_privacy_breaches_no_delete
BEFORE DELETE ON privacy_breaches
WHEN OLD.retain_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
BEGIN
  SELECT RAISE(ABORT, 'breach records are kept until retain_until');
END;
CREATE TRIGGER trg_privacy_breaches_fixed_fields
BEFORE UPDATE OF discovered_at, description, recorded_by, created_at ON privacy_breaches
BEGIN
  SELECT RAISE(ABORT, 'breach facts are fixed; add detail in a new record');
END;
