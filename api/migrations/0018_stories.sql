-- 0018_stories.sql — social stories (24h ephemeral, Instagram/Facebook model).
--
-- Stories are member-authored photos/videos that disappear 24h after posting.
-- Expiry is enforced LAZILY: expires_at is written at insert time and every
-- read filters with `expires_at > now`, so an unexpired-but-overdue story is
-- never shown even if no cleanup has run recently. (A per-row TTL like the
-- one the system-design literature recommends would be native in Cassandra;
-- D1 has no TTL feature, so lazy filtering is the equivalent guarantee here.)
--
-- CLEANUP: a scheduled job should periodically hard-delete expired rows (and
-- their R2 objects) to reclaim storage. Until that job exists, expired rows
-- remain invisible to readers but still occupy D1/R2. The read filters below
-- make that safe: expiry correctness never depends on the cleanup running.
-- Suggested: add `pruneStories(env)` to api/src/cron.ts alongside
-- pruneSessions/pruneRateLimits —
--   DELETE FROM stories WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
-- plus an R2 delete for each reclaimed r2_key. (Not added in 0018: cron
-- changes are a separate, reviewable unit.)
--
-- Views are deduped per viewer (UNIQUE via composite PRIMARY KEY): the tray
-- can show seen/unseen state and the author gets a who-watched list.
-- Viewer lists are author-only by design (see GET /api/stories/:id): nobody
-- else learns who watched what.
--
-- Replies are NOT DMs themselves. story_replies stores the raw reply; the
-- chat/DM system is responsible for surfacing each new reply to the story
-- author as a conversation starter. See tasks/social-stories.md for the
-- contract the chat area implements against.

CREATE TABLE stories (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);
CREATE INDEX IF NOT EXISTS idx_stories_author ON stories(author_id);

CREATE TABLE story_views (
  story_id  TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  viewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (story_id, viewer_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (viewer_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer ON story_views(viewer_id);

CREATE TABLE story_replies (
  id           TEXT PRIMARY KEY,
  story_id     TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_replies_story ON story_replies(story_id);
