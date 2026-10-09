-- 0017_feed_polls.sql — social area (feed agent): posts, post media, polls.
-- Feed is members-only, chronological, calm (no algorithmic ranking).
-- Polls: one vote per member per poll, changeable until close. Voter list is
-- exposed only when the poll's show_voters flag is on (private polls show
-- counts only). Reels are video <= 90s, flagged kind='reel' at upload time.

CREATE TABLE IF NOT EXISTS posts (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id);

CREATE TABLE IF NOT EXISTS post_media (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'reel')),
  width      INTEGER,
  height     INTEGER,
  duration_s INTEGER,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media (post_id, position);

CREATE TABLE IF NOT EXISTS polls (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  closes_at   TEXT NOT NULL,
  show_voters INTEGER NOT NULL DEFAULT 0 CHECK (show_voters IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS poll_options (
  id       TEXT PRIMARY KEY,
  poll_id  TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  id        TEXT PRIMARY KEY,
  poll_id   TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voter_id  TEXT NOT NULL REFERENCES users(id),
  voted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (poll_id, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id);

-- Calm reactions: the four brand reactions (like, celebrate, insightful,
-- support). One reaction per member per post; re-reacting changes it, tapping
-- the same kind again removes it. Counted server-side in GET /api/feed.
CREATE TABLE IF NOT EXISTS post_reactions (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('like', 'celebrate', 'insightful', 'support')),
  reacted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (post_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions (post_id);
