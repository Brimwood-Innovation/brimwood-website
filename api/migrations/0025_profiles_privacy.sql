-- 0025_profiles_privacy.sql: profile additions, privacy controls, DM requests.
--
-- Why: the deck adds skills, "can help with", "looking for", directory opt-in
-- and a seen-receipts off switch (D8). Audit 06 P1-2 needs blocks that work
-- both ways at the database, plus mutes and a DM requests inbox (P1-13).
-- New profile fields go in member_profiles, not users: users already has 30
-- columns and D1 allows 100 per table; a side table also keeps users lean.
-- D11: dob, gender and life_events stop here (expand step). Dropping the
-- columns waits for founder approval: db/migrations/pending/.

-- Profile additions. Members are anonymous by default (R1): directory and
-- activity broadcast are opt-in (0).
CREATE TABLE member_profiles (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  building_now       TEXT CHECK (building_now IS NULL OR length(building_now) <= 140),
  can_help_with      TEXT CHECK (can_help_with IS NULL OR length(can_help_with) <= 280),
  looking_for        TEXT CHECK (looking_for IS NULL OR length(looking_for) <= 280),
  pinned_post_id     TEXT REFERENCES feed_posts(id) ON DELETE SET NULL,
  directory_opt_in   INTEGER NOT NULL DEFAULT 0 CHECK (directory_opt_in IN (0,1)),
  activity_broadcast INTEGER NOT NULL DEFAULT 0 CHECK (activity_broadcast IN (0,1)),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_member_profiles_directory ON member_profiles (user_id) WHERE directory_opt_in = 1;

-- Skill tags, curated so the directory filter stays clean.
CREATE TABLE skill_tags (
  slug  TEXT PRIMARY KEY CHECK (length(slug) BETWEEN 2 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40)
);
CREATE TABLE member_skills (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_slug TEXT NOT NULL REFERENCES skill_tags(slug) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, skill_slug)
) WITHOUT ROWID;
-- Directory filter "members who can help with X".
CREATE INDEX idx_member_skills_skill ON member_skills (skill_slug, user_id);
CREATE TRIGGER trg_member_skills_max_12
BEFORE INSERT ON member_skills
WHEN (SELECT count(*) FROM member_skills WHERE user_id = NEW.user_id) >= 12
BEGIN
  SELECT RAISE(ABORT, 'at most 12 skills per member');
END;

-- Per-field visibility. Values match the 0016 JSON map ('public','members',
-- 'only-me') so the API keeps one vocabulary. A missing row means the API
-- default. The JSON map is copied in below; this table is now the source.
CREATE TABLE profile_field_visibility (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field      TEXT NOT NULL CHECK (field IN ('display_name','bio','avatar','location','website',
               'social_links','work_history','education','hobbies','achievements',
               'building_now','can_help_with','looking_for','skills','projects','badges')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','members','only-me')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, field)
) WITHOUT ROWID;
-- Backfill from users.profile_visibility. dob, gender and life_events are
-- left out on purpose (D11). Bad JSON rows are skipped, not failed.
INSERT INTO profile_field_visibility (user_id, field, visibility)
  SELECT u.id, j.key, j.value
  FROM users u, json_each(u.profile_visibility) j
  WHERE u.profile_visibility IS NOT NULL AND json_valid(u.profile_visibility)
    AND json_type(u.profile_visibility) = 'object'
    AND j.key IN ('display_name','bio','avatar','location','website','social_links','work_history',
                  'education','hobbies','achievements')
    AND j.value IN ('public','members','only-me');

-- D11 expand step: no new values for dob, gender, life_events. Clearing to
-- NULL stays allowed so a member can remove what they gave before.
CREATE TRIGGER trg_users_d11_no_sensitive_fields
BEFORE UPDATE OF dob, gender, life_events ON users
WHEN (NEW.dob IS NOT NULL AND NEW.dob IS NOT OLD.dob)
  OR (NEW.gender IS NOT NULL AND NEW.gender IS NOT OLD.gender)
  OR (NEW.life_events IS NOT NULL AND NEW.life_events IS NOT OLD.life_events)
BEGIN
  SELECT RAISE(ABORT, 'date of birth, gender and life events are no longer collected (D11)');
END;
CREATE TRIGGER trg_users_d11_no_sensitive_fields_insert
BEFORE INSERT ON users
WHEN NEW.dob IS NOT NULL OR NEW.gender IS NOT NULL OR NEW.life_events IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'date of birth, gender and life events are no longer collected (D11)');
END;

-- Member settings: DM policy, seen receipts (D8), quiet hours (C23: one
-- table, two screens). Wall-clock times are local to tz (X2).
CREATE TABLE member_settings (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dm_policy        TEXT NOT NULL DEFAULT 'members' CHECK (dm_policy IN ('members','nobody')),
  seen_receipts    INTEGER NOT NULL DEFAULT 1 CHECK (seen_receipts IN (0,1)),
  quiet_start      TEXT NOT NULL DEFAULT '22:00' CHECK (quiet_start GLOB '[0-2][0-9]:[0-5][0-9]' AND quiet_start < '24:00'),
  quiet_end        TEXT NOT NULL DEFAULT '08:00' CHECK (quiet_end GLOB '[0-2][0-9]:[0-5][0-9]' AND quiet_end < '24:00'),
  quiet_enabled    INTEGER NOT NULL DEFAULT 1 CHECK (quiet_enabled IN (0,1)),
  tz               TEXT NOT NULL DEFAULT 'America/Toronto' CHECK (tz GLOB '[A-Z]*/[A-Za-z_]*' OR tz = 'UTC'),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Blocks (S12, P1-2). Enforced both ways: block_pairs lists each block in
-- both directions, and write triggers (below and in 0026) use it.
CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
) WITHOUT ROWID;
CREATE INDEX idx_blocks_reverse ON blocks (blocked_id, blocker_id);

-- Read helper: add "AND NOT EXISTS (SELECT 1 FROM block_pairs WHERE a = :viewer
-- AND b = <author_id>)" to every query that returns another member's content.
CREATE VIEW block_pairs AS
  SELECT blocker_id AS a, blocked_id AS b FROM blocks
  UNION ALL
  SELECT blocked_id AS a, blocker_id AS b FROM blocks;

-- Mutes: hide without telling the other person. One-way by design.
CREATE TABLE user_mutes (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, muted_user_id),
  CHECK (user_id <> muted_user_id)
) WITHOUT ROWID;
CREATE TABLE thread_mutes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, post_id)
) WITHOUT ROWID;
CREATE TABLE muted_words (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word       TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(word)) BETWEEN 1 AND 60),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, word)
) WITHOUT ROWID;
CREATE TRIGGER trg_muted_words_max_100
BEFORE INSERT ON muted_words
WHEN (SELECT count(*) FROM muted_words WHERE user_id = NEW.user_id) >= 100
BEGIN
  SELECT RAISE(ABORT, 'at most 100 muted words');
END;

-- "Keep an eye on": private follow, never shown as a count (L2046).
CREATE TABLE member_follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
) WITHOUT ROWID;
CREATE INDEX idx_member_follows_followee ON member_follows (followee_id);
CREATE TRIGGER trg_member_follows_block
BEFORE INSERT ON member_follows
WHEN EXISTS (SELECT 1 FROM block_pairs WHERE a = NEW.follower_id AND b = NEW.followee_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;

-- DM requests inbox (P1-13). Existing members are 'accepted'.
-- 'request' = a DM from someone the recipient has not accepted yet.
ALTER TABLE conversation_members ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted'
  CHECK (state IN ('request','accepted','declined','left'));
ALTER TABLE conversation_members ADD COLUMN muted_until TEXT;
CREATE INDEX idx_conversation_members_inbox ON conversation_members (user_id, state);

-- Requests stay quiet: no read state while a request is pending (L1991).
-- RAISE(IGNORE) drops the update silently so the API read call still succeeds.
CREATE TRIGGER trg_conversation_members_no_read_on_request
BEFORE UPDATE OF last_read_at ON conversation_members
WHEN NEW.state = 'request' AND NEW.last_read_at IS NOT NULL
BEGIN
  SELECT RAISE(IGNORE);
END;

-- On block: drop follows both ways and decline open DM requests between the two.
CREATE TRIGGER trg_blocks_cleanup
AFTER INSERT ON blocks
BEGIN
  DELETE FROM member_follows
   WHERE (follower_id = NEW.blocker_id AND followee_id = NEW.blocked_id)
      OR (follower_id = NEW.blocked_id AND followee_id = NEW.blocker_id);
  UPDATE conversation_members SET state = 'declined'
   WHERE state = 'request' AND user_id IN (NEW.blocker_id, NEW.blocked_id)
     AND conversation_id IN (
       SELECT c.id FROM conversations c
       WHERE c.kind = 'dm'
         AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = NEW.blocker_id)
         AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = NEW.blocked_id));
END;

-- DM write rules (S16): sender must be an active member of the conversation;
-- no DM across a block; no message into a conversation the sender left.
CREATE TRIGGER trg_messages_sender_rules
BEFORE INSERT ON messages
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.sender_id AND status = 'active')
  OR NOT EXISTS (SELECT 1 FROM conversation_members
                 WHERE conversation_id = NEW.conversation_id AND user_id = NEW.sender_id
                   AND state IN ('accepted','request'))
BEGIN
  SELECT RAISE(ABORT, 'sender cannot post in this conversation');
END;
CREATE TRIGGER trg_messages_block
BEFORE INSERT ON messages
WHEN EXISTS (
  SELECT 1 FROM conversation_members m
  JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'dm'
  JOIN block_pairs bp ON bp.a = NEW.sender_id AND bp.b = m.user_id
  WHERE m.conversation_id = NEW.conversation_id AND m.user_id <> NEW.sender_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;
-- dm_policy 'nobody': a new DM to this member must arrive as a request.
CREATE TRIGGER trg_conversation_members_dm_policy
BEFORE INSERT ON conversation_members
WHEN NEW.state = 'accepted'
 AND (SELECT kind FROM conversations WHERE id = NEW.conversation_id) = 'dm'
 AND (SELECT created_by FROM conversations WHERE id = NEW.conversation_id) <> NEW.user_id
 AND EXISTS (SELECT 1 FROM member_settings WHERE user_id = NEW.user_id AND dm_policy = 'nobody')
BEGIN
  SELECT RAISE(ABORT, 'this member takes DMs as requests only');
END;
-- No DM conversation may join two members across a block.
CREATE TRIGGER trg_conversation_members_block
BEFORE INSERT ON conversation_members
WHEN (SELECT kind FROM conversations WHERE id = NEW.conversation_id) = 'dm'
 AND EXISTS (SELECT 1 FROM conversation_members m JOIN block_pairs bp
             ON bp.a = NEW.user_id AND bp.b = m.user_id
             WHERE m.conversation_id = NEW.conversation_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;
-- Story replies open a DM thread (0018), so they obey blocks too.
CREATE TRIGGER trg_story_replies_block
BEFORE INSERT ON story_replies
WHEN EXISTS (SELECT 1 FROM stories s JOIN block_pairs bp ON bp.a = NEW.from_user_id AND bp.b = s.author_id
             WHERE s.id = NEW.story_id)
BEGIN
  SELECT RAISE(ABORT, 'blocked');
END;

-- Web Push (P2). endpoint is a capability URL; p256dh and auth are the
-- browser's public key and auth secret, needed in clear to encrypt payloads
-- (RFC 8291), so they cannot be hashed. Rows go when the member signs out.
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%' AND length(endpoint) <= 1000),
  p256dh      TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  device_id   TEXT REFERENCES devices(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_ok_at  TEXT,
  failures    INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0)
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);

-- Personal ICS feed (P2). The URL token is a bearer secret: SHA-256 only.
CREATE TABLE ics_feed_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_ics_one_live ON ics_feed_tokens (user_id) WHERE revoked_at IS NULL;
