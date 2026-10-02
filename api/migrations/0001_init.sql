-- 0001_init.sql — users, invite_codes (report §11.2)
-- Conventions: TEXT PRIMARY KEY UUIDs, ISO-8601 UTC timestamps,
-- soft status enums via CHECK, FKs with ON DELETE CASCADE.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('admin', 'member')),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended')),
  referral    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE invite_codes (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  created_by  TEXT REFERENCES users(id),
  max_uses    INTEGER NOT NULL DEFAULT 1,
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_invite_codes_code ON invite_codes(code);
