-- Migration 0006: moderated blog comments.
-- Comments are held as 'pending' until an admin approves them.
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  post_slug  TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'approved', 'spam')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_slug_status ON comments (post_slug, status, created_at);
