-- 0022_feed_posts_fix.sql: fix the P0 "posts" name collision.
--
-- Why: 0002 made the blog table "posts". 0017 then ran
-- "CREATE TABLE IF NOT EXISTS posts" for the feed, which did nothing, so the
-- feed table never existed. INSERT INTO posts (id, author_id, body, created_at)
-- in api/src/routes/feed.ts fails, and polls, post_media and post_reactions
-- point their foreign keys at the BLOG table.
--
-- What: create feed_posts, then rebuild the five feed child tables
-- (polls, poll_options, poll_votes, post_media, post_reactions) so that they
-- reference feed_posts. The blog table "posts" is not touched.
--
-- Data safety (production contents are unknown):
--   1. Copy every row of the five tables into snapshot tables first.
--   2. Drop the five tables LEAF FIRST (poll_votes, poll_options, polls,
--      post_media, post_reactions). Leaf-first order means no DROP fires an
--      ON DELETE CASCADE into a table we still need (DROP TABLE runs an
--      implicit DELETE, and deferred foreign keys do not stop cascade actions).
--   3. Create the new tables with the same names, columns and defaults the API
--      already uses, plus foreign keys to feed_posts.
--   4. Copy back every row whose parent exists. feed_posts is new and empty, so
--      on a real database every old child row is an orphan: it pointed at a
--      blog post. Orphans go to feed_legacy_quarantine as JSON, so no row is
--      lost and the founder can review them.
--   5. Drop only the snapshot tables this file created.
-- This is the one sanctioned table rebuild in v5 (SPEC 3.3). It is correct on
-- empty and on non-empty tables (see test_0022_preserves_existing_child_rows).
--
-- D1 notes: D1 runs each migration file as one unit and rolls it back on error
-- (wrangler docs). BEGIN/COMMIT are not allowed in D1 SQL files, so this file
-- has none. PRAGMA defer_foreign_keys is the D1-documented way to allow
-- temporary FK violations inside a migration; the leaf-first order means we do
-- not rely on it, but it is harmless.

PRAGMA defer_foreign_keys = true;

-- Prerequisite guard. 0022 to 0036 build on 0012 to 0021, which exist only on
-- branch audit/social-ux-deep (main has 0001 to 0008, develop 0001 to 0011).
-- If any of them is missing, this insert fails with the constraint name below
-- and wrangler rolls the whole file back.
CREATE TABLE _m0022_guard (
  ok INTEGER CONSTRAINT needs_migrations_0012_to_0021_from_branch_audit_social_ux_deep CHECK (ok = 1)
);
INSERT INTO _m0022_guard (ok) SELECT
      EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_intro_idem')            -- 0012
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'digest_sends')              -- 0013
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_audit_log_no_update') -- 0014
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'newsletter_subscribers' AND sql LIKE '%confirm_token_expires_at%') -- 0015
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'users' AND sql LIKE '%avatar_r2_key%')         -- 0016
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'post_reactions')            -- 0017
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'story_replies')             -- 0018
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_members')      -- 0019
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notifications')             -- 0020
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'polls' AND sql LIKE '%notified_closed_at%');   -- 0021
DROP TABLE _m0022_guard;

-- Feed posts. Columns id, author_id, body, created_at match the API insert.
-- No scheduled_for column: members cannot schedule posts (D9). Staff
-- scheduling uses publish_queue (0032).
CREATE TABLE feed_posts (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
  intent      TEXT NOT NULL DEFAULT 'progress'
              CHECK (intent IN ('progress','question','feedback','resource','poll',
                                'ritual','spotlight','announcement','event_recap','intro')),
  audience    TEXT NOT NULL DEFAULT 'members'
              CHECK (audience IN ('members','group','only_me')),
  status      TEXT NOT NULL DEFAULT 'published'
              CHECK (status IN ('published','held','removed')),
  held_reason TEXT,
  quoted_post_id TEXT REFERENCES feed_posts(id) ON DELETE SET NULL,
  client_idempotency_key TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  mod_edited  INTEGER NOT NULL DEFAULT 0 CHECK (mod_edited IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at   TEXT,
  deleted_at  TEXT,
  CHECK (status <> 'held' OR held_reason IS NOT NULL)
);
-- Keyset pagination of the chronological feed: WHERE created_at < ? ORDER BY created_at DESC.
CREATE INDEX idx_feed_posts_created ON feed_posts (created_at DESC, id DESC);
CREATE INDEX idx_feed_posts_author  ON feed_posts (author_id, created_at DESC);
CREATE INDEX idx_feed_posts_held    ON feed_posts (status, created_at) WHERE status = 'held';
-- Offline composer retry: one post per client key per author.
CREATE UNIQUE INDEX idx_feed_posts_idem ON feed_posts (author_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;

-- Orphan rows from the old child tables. Kept as JSON, never re-read by the API.
CREATE TABLE feed_legacy_quarantine (
  id           INTEGER PRIMARY KEY,
  source_table TEXT NOT NULL CHECK (source_table IN ('polls','poll_options','poll_votes','post_media','post_reactions')),
  row_json     TEXT NOT NULL CHECK (json_valid(row_json)),
  reason       TEXT NOT NULL,
  moved_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 1. Snapshots.
CREATE TABLE _m0022_polls          AS SELECT * FROM polls;
CREATE TABLE _m0022_poll_options   AS SELECT * FROM poll_options;
CREATE TABLE _m0022_poll_votes     AS SELECT * FROM poll_votes;
CREATE TABLE _m0022_post_media     AS SELECT * FROM post_media;
CREATE TABLE _m0022_post_reactions AS SELECT * FROM post_reactions;

-- 2. Drop leaf first (indexes go with their tables).
DROP TABLE poll_votes;
DROP TABLE poll_options;
DROP TABLE polls;
DROP TABLE post_media;
DROP TABLE post_reactions;

-- 3. New tables: same names and columns as 0017/0021, parent is feed_posts.
CREATE TABLE polls (
  id                 TEXT PRIMARY KEY,
  post_id            TEXT NOT NULL UNIQUE REFERENCES feed_posts(id) ON DELETE CASCADE,
  question           TEXT NOT NULL,
  closes_at          TEXT NOT NULL,
  show_voters        INTEGER NOT NULL DEFAULT 0 CHECK (show_voters IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  notified_closed_at TEXT
);
-- Cron: polls that closed and were not notified yet.
CREATE INDEX idx_polls_close_notify ON polls (closes_at) WHERE notified_closed_at IS NULL;

CREATE TABLE poll_options (
  id       TEXT PRIMARY KEY,
  poll_id  TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_poll_options_poll ON poll_options (poll_id, position);

-- voter_id cascades: a vote has no meaning without its voter.
CREATE TABLE poll_votes (
  id        TEXT PRIMARY KEY,
  poll_id   TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (poll_id, voter_id)
);
CREATE INDEX idx_poll_votes_poll ON poll_votes (poll_id);
CREATE INDEX idx_poll_votes_option ON poll_votes (option_id);

CREATE TABLE post_media (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'reel')),
  width      INTEGER,
  height     INTEGER,
  duration_s INTEGER,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_post_media_post ON post_media (post_id, position);

-- R4: the four calm reactions are Thanks, Insightful, Support, Celebrate.
-- 'like' stays allowed so existing rows and the current API keep working;
-- the API should write 'thanks' from now on (see SCHEMA.md API changes).
CREATE TABLE post_reactions (
  post_id    TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('like', 'thanks', 'celebrate', 'insightful', 'support')),
  reacted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (post_id, member_id)
);
CREATE INDEX idx_post_reactions_post ON post_reactions (post_id);
CREATE INDEX idx_post_reactions_member ON post_reactions (member_id);

-- 4. Copy back rows whose parents exist, in parent-first order.
INSERT INTO polls (id, post_id, question, closes_at, show_voters, created_at, notified_closed_at)
  SELECT id, post_id, question, closes_at, show_voters, created_at, notified_closed_at
  FROM _m0022_polls WHERE post_id IN (SELECT id FROM feed_posts);
INSERT INTO poll_options (id, poll_id, label, position)
  SELECT id, poll_id, label, position
  FROM _m0022_poll_options WHERE poll_id IN (SELECT id FROM polls);
INSERT INTO poll_votes (id, poll_id, option_id, voter_id, voted_at)
  SELECT id, poll_id, option_id, voter_id, voted_at
  FROM _m0022_poll_votes
  WHERE poll_id IN (SELECT id FROM polls) AND option_id IN (SELECT id FROM poll_options)
    AND voter_id IN (SELECT id FROM users);
INSERT INTO post_media (id, post_id, r2_key, kind, width, height, duration_s, position)
  SELECT id, post_id, r2_key, kind, width, height, duration_s, position
  FROM _m0022_post_media WHERE post_id IN (SELECT id FROM feed_posts);
INSERT INTO post_reactions (post_id, member_id, kind, reacted_at)
  SELECT post_id, member_id, kind, reacted_at
  FROM _m0022_post_reactions
  WHERE post_id IN (SELECT id FROM feed_posts) AND member_id IN (SELECT id FROM users);

-- Everything else goes to quarantine, with the full row.
INSERT INTO feed_legacy_quarantine (source_table, row_json, reason)
  SELECT 'polls', json_object('id',id,'post_id',post_id,'question',question,'closes_at',closes_at,
         'show_voters',show_voters,'created_at',created_at,'notified_closed_at',notified_closed_at),
         'parent post is not a feed post'
  FROM _m0022_polls WHERE id NOT IN (SELECT id FROM polls);
INSERT INTO feed_legacy_quarantine (source_table, row_json, reason)
  SELECT 'poll_options', json_object('id',id,'poll_id',poll_id,'label',label,'position',position),
         'parent poll was quarantined'
  FROM _m0022_poll_options WHERE id NOT IN (SELECT id FROM poll_options);
INSERT INTO feed_legacy_quarantine (source_table, row_json, reason)
  SELECT 'poll_votes', json_object('id',id,'poll_id',poll_id,'option_id',option_id,'voter_id',voter_id,
         'voted_at',voted_at),
         'parent poll or option was quarantined'
  FROM _m0022_poll_votes WHERE id NOT IN (SELECT id FROM poll_votes);
INSERT INTO feed_legacy_quarantine (source_table, row_json, reason)
  SELECT 'post_media', json_object('id',id,'post_id',post_id,'r2_key',r2_key,'kind',kind,'width',width,
         'height',height,'duration_s',duration_s,'position',position),
         'parent post is not a feed post'
  FROM _m0022_post_media WHERE id NOT IN (SELECT id FROM post_media);
INSERT INTO feed_legacy_quarantine (source_table, row_json, reason)
  SELECT 'post_reactions', json_object('post_id',s.post_id,'member_id',s.member_id,'kind',s.kind,
         'reacted_at',s.reacted_at),
         'parent post is not a feed post'
  FROM _m0022_post_reactions s
  WHERE NOT EXISTS (SELECT 1 FROM post_reactions r WHERE r.post_id = s.post_id AND r.member_id = s.member_id);

-- 5. Remove only the snapshots this file made.
DROP TABLE _m0022_polls;
DROP TABLE _m0022_poll_options;
DROP TABLE _m0022_poll_votes;
DROP TABLE _m0022_post_media;
DROP TABLE _m0022_post_reactions;
