-- 0034_ops_analytics.sql: job queue, job failures, cookieless analytics.
--
-- Why: admin home counts failed jobs and failed emails (L1147, L1176), and
-- emails that fail must be retried, not lost (L1429). health_checks (0005)
-- already exists. audit_log (0004) is append-only since 0014; the test
-- suite checks that both triggers still hold.
-- Analytics: the founder dashboard (SPEC 3.2) needs page views, the intro
-- funnel, UTM sources and room use. These are daily aggregates with no user
-- id, no IP and no cookie: nothing here can identify a person (PIPEDA).

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('send_email','publish_scheduled','send_newsletter','run_ritual',
                    'deliver_webhook','issue_certificate','build_digest','export_data','finalize_deletion',
                    'send_push','send_reminder','purge_retention','rollup_analytics')),
  payload_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(payload_json) <= 20000),
  run_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  locked_until    TEXT,
  idempotency_key TEXT UNIQUE,
  last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at     TEXT,
  CHECK (attempts <= max_attempts),
  CHECK (status <> 'dead' OR attempts = max_attempts)
);
CREATE INDEX idx_jobs_due ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX idx_jobs_failed ON jobs (status, finished_at DESC) WHERE status IN ('failed','dead');

CREATE TABLE job_failures (
  id        INTEGER PRIMARY KEY,
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt   INTEGER NOT NULL CHECK (attempt >= 1),
  error     TEXT NOT NULL CHECK (length(error) <= 1000),
  failed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (job_id, attempt)
);
CREATE INDEX idx_job_failures_recent ON job_failures (failed_at DESC);

-- Daily page views by path. No visitor id: views only.
CREATE TABLE analytics_daily_pages (
  day        TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  path       TEXT NOT NULL CHECK (substr(path, 1, 1) = '/' AND length(path) <= 300),
  views      INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  referrer_class TEXT NOT NULL DEFAULT 'none' CHECK (referrer_class IN ('none','search','social','email','direct_link','internal','other')),
  PRIMARY KEY (day, path, referrer_class)
) WITHOUT ROWID;

-- Intro funnel: from intro page view to redeemed invite (D2 flow).
CREATE TABLE analytics_intro_funnel (
  day   TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  step  TEXT NOT NULL CHECK (step IN ('intro_page_view','form_started','form_submitted','approved','invite_sent','invite_redeemed')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, step)
) WITHOUT ROWID;

-- UTM sources (L1825): first-party tags only.
CREATE TABLE analytics_utm_daily (
  day            TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  source         TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 60 AND source = lower(source)),
  medium         TEXT NOT NULL DEFAULT '' CHECK (length(medium) <= 60),
  campaign       TEXT NOT NULL DEFAULT '' CHECK (length(campaign) <= 80),
  visits         INTEGER NOT NULL DEFAULT 0 CHECK (visits >= 0),
  intro_submits  INTEGER NOT NULL DEFAULT 0 CHECK (intro_submits >= 0),
  PRIMARY KEY (day, source, medium, campaign)
) WITHOUT ROWID;

-- Room use per resource per local day (America/Toronto).
CREATE TABLE analytics_room_utilisation (
  day            TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  resource_id    TEXT NOT NULL REFERENCES space_resources(id) ON DELETE CASCADE,
  open_minutes   INTEGER NOT NULL CHECK (open_minutes BETWEEN 0 AND 1440),
  booked_minutes INTEGER NOT NULL DEFAULT 0 CHECK (booked_minutes >= 0),
  bookings       INTEGER NOT NULL DEFAULT 0 CHECK (bookings >= 0),
  checked_in     INTEGER NOT NULL DEFAULT 0 CHECK (checked_in >= 0),
  no_shows       INTEGER NOT NULL DEFAULT 0 CHECK (no_shows >= 0),
  PRIMARY KEY (day, resource_id),
  CHECK (checked_in + no_shows <= bookings)
) WITHOUT ROWID;

-- Show-up rate for events (SPEC 3.2 founder analytics).
CREATE TABLE analytics_event_attendance (
  event_id   TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  rsvps      INTEGER NOT NULL DEFAULT 0 CHECK (rsvps >= 0),
  checked_in INTEGER NOT NULL DEFAULT 0 CHECK (checked_in >= 0),
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Active members per day (founder dashboard "active in 30 days"). Sessions
-- expire and are deleted, so the daily rollup keeps the count. Counts only.
CREATE TABLE analytics_active_daily (
  day            TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  active_1d      INTEGER NOT NULL DEFAULT 0 CHECK (active_1d >= 0),
  active_7d      INTEGER NOT NULL DEFAULT 0 CHECK (active_7d >= 0),
  active_30d     INTEGER NOT NULL DEFAULT 0 CHECK (active_30d >= 0),
  computed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (active_1d <= active_7d AND active_7d <= active_30d)
) WITHOUT ROWID;
