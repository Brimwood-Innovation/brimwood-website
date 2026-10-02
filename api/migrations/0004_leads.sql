-- 0004_leads.sql — introduction requests, newsletter, email log, media, audit (report §11.2)

CREATE TABLE introduction_requests (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  referral    TEXT,
  message     TEXT,
  ip_hash     TEXT,
  user_agent  TEXT,
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','contacted','invited','declined','spam')),
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_intro_status ON introduction_requests(status, created_at DESC);

CREATE TABLE newsletter_subscribers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','unsubscribed')),
  confirm_token   TEXT,
  unsub_token     TEXT NOT NULL,
  source          TEXT,
  subscribed_at   TEXT,
  unsubscribed_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_subscribers_status ON newsletter_subscribers(status);

CREATE TABLE email_log (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  to_email    TEXT NOT NULL,
  subject     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('sent','failed')),
  provider_id TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_email_log_kind ON email_log(kind, created_at DESC);

CREATE TABLE media_assets (
  id          TEXT PRIMARY KEY,
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  alt_text    TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
