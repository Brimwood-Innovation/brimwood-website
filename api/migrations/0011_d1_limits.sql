-- 0011_d1_limits.sql — F9: rate limits and sessions in D1 (atomic, no KV writes)
-- Replaces KV-backed rate limiting (eventually consistent, every check is a
-- KV write) and KV sessions with D1 tables. Atomic upserts make bursts
-- correct; the per-user session index replaces the full KV scan on reset.

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
