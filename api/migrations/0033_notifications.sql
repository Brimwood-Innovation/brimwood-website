-- 0033_notifications.sql: more notification kinds, preferences, digests.
--
-- Why additive: notifications.kind (0020) has a CHECK with six values. A
-- wider CHECK needs a table rebuild. Instead:
--   1. notification_kinds is a registry table. It lists the six old kinds and
--      every new kind, with flags (transactional, default channels).
--   2. New kinds go into notification_items, whose kind is a FOREIGN KEY to
--      the registry. Adding a kind later is one INSERT, never a rebuild.
--   3. The bell reads the view notification_feed (UNION ALL of both tables).
-- The six old kinds keep using the old table, so the current API keeps working.
-- A later contract step (after the API reads only the view) can move old
-- rows into notification_items; it is not part of v5.

CREATE TABLE notification_kinds (
  kind            TEXT PRIMARY KEY CHECK (kind NOT GLOB '*[^a-z_]*'),
  legacy          INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0,1)),   -- 1 = lives in notifications (0020)
  transactional   INTEGER NOT NULL DEFAULT 0 CHECK (transactional IN (0,1)),  -- cannot be switched off (L1641)
  default_in_app  INTEGER NOT NULL DEFAULT 1 CHECK (default_in_app IN (0,1)),
  default_email   INTEGER NOT NULL DEFAULT 0 CHECK (default_email IN (0,1)),
  default_push    INTEGER NOT NULL DEFAULT 0 CHECK (default_push IN (0,1)),
  label           TEXT NOT NULL
);
INSERT INTO notification_kinds (kind, legacy, transactional, default_in_app, default_email, default_push, label) VALUES
  ('mention',            1, 0, 1, 1, 0, 'Mentions'),
  ('reply',              1, 0, 1, 1, 0, 'Replies to you'),
  ('follow',             1, 0, 1, 0, 0, 'Someone keeps an eye on your work'),
  ('story_reply',        1, 0, 1, 0, 0, 'Story replies'),
  ('poll_closed',        1, 0, 1, 0, 0, 'Polls you voted in closed'),
  ('event_reminder',     1, 0, 1, 1, 0, 'Event reminders'),
  ('dm',                 0, 0, 1, 0, 0, 'Direct messages'),
  ('dm_request',         0, 0, 1, 0, 0, 'Message requests'),
  ('answer',             0, 0, 1, 1, 0, 'Answers to your questions'),
  ('helpful_marked',     0, 0, 1, 0, 0, 'Your answer was marked helpful'),
  ('group_join_request', 0, 0, 1, 0, 0, 'Requests to join your group'),
  ('group_join_approved',0, 0, 1, 0, 0, 'Your group request was approved'),
  ('invite_redeemed',    0, 0, 1, 1, 0, 'Your invite was redeemed'),
  ('booking_confirmed',  0, 1, 1, 1, 0, 'Room booking confirmed'),
  ('booking_cancelled',  0, 1, 1, 1, 0, 'Room booking cancelled'),
  ('guest_arrived',      0, 0, 1, 0, 1, 'Your guest checked in'),
  ('demo_feedback',      0, 0, 1, 1, 0, 'Written feedback on your demo'),
  ('demo_slot',          0, 1, 1, 1, 0, 'Demo slot confirmed'),
  ('reflection_shared',  0, 0, 1, 0, 0, 'Cohort reflections'),
  ('certificate_issued', 0, 1, 1, 1, 0, 'Certificate issued'),
  ('new_course',         0, 0, 1, 0, 0, 'New courses'),
  ('report_outcome',     0, 1, 1, 1, 0, 'Outcome of your report'),
  ('sanction_notice',    0, 1, 1, 1, 0, 'Notice about your account'),
  ('appeal_decided',     0, 1, 1, 1, 0, 'Appeal decision'),
  ('digest_ready',       0, 0, 0, 0, 0, 'Weekly digest'),
  ('security_alert',     0, 1, 1, 1, 0, 'Security alerts');

CREATE TABLE notification_items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL REFERENCES notification_kinds(kind),
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 40),
  target_id   TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  preview     TEXT CHECK (preview IS NULL OR length(preview) <= 200),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at     TEXT,
  CHECK (actor_id IS NULL OR actor_id <> user_id)
);
CREATE INDEX idx_notification_items_user ON notification_items (user_id, created_at DESC);
CREATE INDEX idx_notification_items_unread ON notification_items (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX idx_notification_items_dedupe
  ON notification_items (user_id, kind, coalesce(actor_id, ''), target_type, target_id) WHERE read_at IS NULL;
CREATE TRIGGER trg_notification_items_new_kinds_only
BEFORE INSERT ON notification_items
WHEN (SELECT legacy FROM notification_kinds WHERE kind = NEW.kind) = 1
BEGIN
  SELECT RAISE(ABORT, 'legacy kinds go to the notifications table');
END;

-- No notification from a blocked or muted member. IGNORE, because the API
-- rule is "notifications must never break the action that caused them".
CREATE TRIGGER trg_notifications_block
BEFORE INSERT ON notifications
WHEN NEW.actor_id IS NOT NULL AND (
  EXISTS (SELECT 1 FROM block_pairs WHERE a = NEW.user_id AND b = NEW.actor_id)
  OR EXISTS (SELECT 1 FROM user_mutes WHERE user_id = NEW.user_id AND muted_user_id = NEW.actor_id))
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER trg_notification_items_block
BEFORE INSERT ON notification_items
WHEN NEW.actor_id IS NOT NULL AND (
  EXISTS (SELECT 1 FROM block_pairs WHERE a = NEW.user_id AND b = NEW.actor_id)
  OR EXISTS (SELECT 1 FROM user_mutes WHERE user_id = NEW.user_id AND muted_user_id = NEW.actor_id))
BEGIN
  SELECT RAISE(IGNORE);
END;

-- The bell. source tells the API which table to mark read.
CREATE VIEW notification_feed AS
  SELECT id, user_id, kind, actor_id, target_type, target_id, preview, created_at, read_at,
         'notifications' AS source FROM notifications
  UNION ALL
  SELECT id, user_id, kind, actor_id, target_type, target_id, preview, created_at, read_at,
         'notification_items' AS source FROM notification_items;

-- Preferences: kind x channel. A missing row means the registry default.
CREATE TABLE notification_preferences (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL REFERENCES notification_kinds(kind) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('in_app','email','push')),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, kind, channel)
) WITHOUT ROWID;
CREATE TRIGGER trg_notification_preferences_transactional
BEFORE INSERT ON notification_preferences
WHEN NEW.enabled = 0 AND NEW.channel IN ('in_app','email')
 AND (SELECT transactional FROM notification_kinds WHERE kind = NEW.kind) = 1
BEGIN
  SELECT RAISE(ABORT, 'transactional notices cannot be switched off');
END;
CREATE TRIGGER trg_notification_preferences_transactional_update
BEFORE UPDATE OF enabled ON notification_preferences
WHEN NEW.enabled = 0 AND NEW.channel IN ('in_app','email')
 AND (SELECT transactional FROM notification_kinds WHERE kind = NEW.kind) = 1
BEGIN
  SELECT RAISE(ABORT, 'transactional notices cannot be switched off');
END;

-- Member weekly digest (C22): off by default; built only from posts the
-- member can see. One per member per week, so a retry cannot send twice.
-- (digest_sends in 0013 stays for the public newsletter digest.)
CREATE TABLE member_digests (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  period_end   TEXT NOT NULL CHECK (period_end GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  item_count   INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','skipped_empty','skipped_quiet','failed')),
  sent_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, period_start),
  CHECK (period_end > period_start)
);
CREATE INDEX idx_member_digests_queue ON member_digests (status, created_at) WHERE status = 'queued';
