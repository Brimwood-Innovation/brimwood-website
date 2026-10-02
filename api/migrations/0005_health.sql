-- Migration 0005: health monitoring (T33).
CREATE TABLE IF NOT EXISTS health_checks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_health_checks_name_time ON health_checks(name, checked_at DESC);

-- Simple key-value for cron metadata (e.g. last alert timestamp).
CREATE TABLE IF NOT EXISTS kv_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
