-- 0026_community.sql: groups, comments, mentions, helpful answers, saved posts, rituals.
--
-- Why: the deck's hub needs groups with join questions (L1941-L1976), two
-- levels of comments (L1939), mentions, "helpful" answers (L1916), saved
-- posts (L2179) and staff-run weekly ritual threads (L1891, D9).
-- Blocks are enforced on every write that touches another member (S12):
-- comments, comment reactions, post reactions and mentions.

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  purpose     TEXT NOT NULL CHECK (length(purpose) BETWEEN 10 AND 200),
  join_policy TEXT NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','request','invite')),
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','archived','rejected')),
  proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  archived_at TEXT,
  last_post_at TEXT,
  avatar_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status <> 'active' OR approved_at IS NOT NULL),
  CHECK (status <> 'archived' OR archived_at IS NOT NULL)
);
CREATE INDEX idx_groups_status ON groups (status, last_post_at DESC);

-- role 'admin' is the per-group admin (D5).
CREATE TABLE group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  state      TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('requested','active','left','removed')),
  joined_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, user_id),
  CHECK (role = 'member' OR state = 'active')
) WITHOUT ROWID;
CREATE INDEX idx_group_members_user ON group_members (user_id, state);
CREATE INDEX idx_group_members_admins ON group_members (group_id) WHERE role = 'admin';

CREATE TABLE group_join_questions (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  prompt     TEXT NOT NULL CHECK (length(prompt) BETWEEN 5 AND 200),
  kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','yes_no')),
  required   INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  position   INTEGER NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 4),
  UNIQUE (group_id, position)
);
CREATE TABLE group_join_answers (
  group_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES group_join_questions(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL CHECK (length(answer) BETWEEN 1 AND 500),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, user_id, question_id),
  FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Feed posts can live in a group. Audience 'group' needs a group, and the
-- author must be an active group member (trigger: CHECK cannot read tables).
ALTER TABLE feed_posts ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE CASCADE;
CREATE INDEX idx_feed_posts_group ON feed_posts (group_id, created_at DESC) WHERE group_id IS NOT NULL;
CREATE TRIGGER trg_feed_posts_group_rules
BEFORE INSERT ON feed_posts
WHEN (NEW.audience = 'group') <> (NEW.group_id IS NOT NULL)
  OR (NEW.group_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM group_members WHERE group_id = NEW.group_id AND user_id = NEW.author_id AND state = 'active'))
BEGIN
  SELECT RAISE(ABORT, 'group posts need an active group member and audience group');
END;
-- Announcements are staff-only (L2027).
CREATE TRIGGER trg_feed_posts_announcement_staff
BEFORE INSERT ON feed_posts
WHEN NEW.intent = 'announcement' AND NOT EXISTS (
  SELECT 1 FROM user_effective_roles WHERE user_id = NEW.author_id AND role IN ('admin','editor'))
BEGIN
  SELECT RAISE(ABORT, 'announcements are staff-only');
END;

-- Feed comments: at most two levels (L1939). parent_id NULL = level 1.
CREATE TABLE feed_comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES feed_comments(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  status     TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','held','removed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at  TEXT,
  deleted_at TEXT,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX idx_feed_comments_post ON feed_comments (post_id, created_at);
CREATE INDEX idx_feed_comments_parent ON feed_comments (parent_id, created_at) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_feed_comments_author ON feed_comments (author_id, created_at DESC);
CREATE TRIGGER trg_feed_comments_depth
BEFORE INSERT ON feed_comments
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM feed_comments p WHERE p.id = NEW.parent_id AND p.post_id = NEW.post_id AND p.parent_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'replies go two levels deep, on the same post');
END;
CREATE TRIGGER trg_feed_comments_depth_update
BEFORE UPDATE OF parent_id, post_id ON feed_comments
BEGIN
  SELECT RAISE(ABORT, 'a comment cannot move');
END;
CREATE TRIGGER trg_feed_comments_block
BEFORE INSERT ON feed_comments
WHEN EXISTS (SELECT 1 FROM feed_posts p JOIN block_pairs bp ON bp.a = NEW.author_id AND bp.b = p.author_id
             WHERE p.id = NEW.post_id)
  OR EXISTS (SELECT 1 FROM feed_comments c JOIN block_pairs bp ON bp.a = NEW.author_id AND bp.b = c.author_id
             WHERE c.id = NEW.parent_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;

CREATE TABLE comment_reactions (
  comment_id TEXT NOT NULL REFERENCES feed_comments(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('thanks','celebrate','insightful','support')),
  reacted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (comment_id, member_id)
) WITHOUT ROWID;
CREATE TRIGGER trg_comment_reactions_block
BEFORE INSERT ON comment_reactions
WHEN EXISTS (SELECT 1 FROM feed_comments c JOIN block_pairs bp ON bp.a = NEW.member_id AND bp.b = c.author_id
             WHERE c.id = NEW.comment_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;
CREATE TRIGGER trg_post_reactions_block
BEFORE INSERT ON post_reactions
WHEN EXISTS (SELECT 1 FROM feed_posts p JOIN block_pairs bp ON bp.a = NEW.member_id AND bp.b = p.author_id
             WHERE p.id = NEW.post_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;
-- The API re-reacts with INSERT ... ON CONFLICT DO UPDATE; guard that path too.
CREATE TRIGGER trg_post_reactions_block_update
BEFORE UPDATE ON post_reactions
WHEN EXISTS (SELECT 1 FROM feed_posts p JOIN block_pairs bp ON bp.a = NEW.member_id AND bp.b = p.author_id
             WHERE p.id = NEW.post_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;

-- Mentions: one row per mentioned member per post or comment.
CREATE TABLE mentions (
  id                TEXT PRIMARY KEY,
  post_id           TEXT REFERENCES feed_posts(id) ON DELETE CASCADE,
  comment_id        TEXT REFERENCES feed_comments(id) ON DELETE CASCADE,
  author_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((post_id IS NULL) <> (comment_id IS NULL)),
  CHECK (author_id <> mentioned_user_id)
);
CREATE UNIQUE INDEX idx_mentions_post ON mentions (post_id, mentioned_user_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX idx_mentions_comment ON mentions (comment_id, mentioned_user_id) WHERE comment_id IS NOT NULL;
CREATE INDEX idx_mentions_user ON mentions (mentioned_user_id, created_at DESC);
CREATE TRIGGER trg_mentions_block
BEFORE INSERT ON mentions
WHEN EXISTS (SELECT 1 FROM block_pairs WHERE a = NEW.author_id AND b = NEW.mentioned_user_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;

-- Helpful answer: only the post author marks one comment on their own question.
CREATE TABLE helpful_answers (
  post_id    TEXT PRIMARY KEY REFERENCES feed_posts(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL UNIQUE REFERENCES feed_comments(id) ON DELETE CASCADE,
  marked_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER trg_helpful_answers_rules
BEFORE INSERT ON helpful_answers
WHEN NOT EXISTS (SELECT 1 FROM feed_posts WHERE id = NEW.post_id AND author_id = NEW.marked_by)
  OR NOT EXISTS (SELECT 1 FROM feed_comments WHERE id = NEW.comment_id AND post_id = NEW.post_id)
BEGIN
  SELECT RAISE(ABORT, 'only the post author marks a comment on that post as helpful');
END;

-- Saved posts, private to the member.
CREATE TABLE saved_posts (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  collection TEXT NOT NULL DEFAULT 'Saved' CHECK (length(collection) BETWEEN 1 AND 40),
  saved_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, post_id)
) WITHOUT ROWID;
CREATE INDEX idx_saved_posts_list ON saved_posts (user_id, collection, saved_at DESC);

-- Rituals: weekly threads run by staff (D9: members cannot schedule).
-- Each run inserts one feed post; publish_queue (0032) holds the next run.
CREATE TABLE rituals (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  body_template TEXT NOT NULL CHECK (length(body_template) BETWEEN 1 AND 2000),
  group_id      TEXT REFERENCES groups(id) ON DELETE CASCADE,
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday, local to tz
  local_time    TEXT NOT NULL CHECK (local_time GLOB '[0-2][0-9]:[0-5][0-9]' AND local_time < '24:00'),
  tz            TEXT NOT NULL DEFAULT 'America/Toronto',
  author_id     TEXT NOT NULL REFERENCES users(id),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER trg_rituals_staff_only
BEFORE INSERT ON rituals
WHEN NOT EXISTS (SELECT 1 FROM user_effective_roles WHERE user_id = NEW.author_id AND role IN ('admin','editor'))
BEGIN
  SELECT RAISE(ABORT, 'rituals are a Studio feature (D9)');
END;
ALTER TABLE feed_posts ADD COLUMN ritual_id TEXT REFERENCES rituals(id) ON DELETE SET NULL;
