-- 0020_notifications.sql — audit/social/wiring: in-app notifications.
-- One row per event that deserves the bell: @mentions, replies, follows,
-- story replies, closed polls, event reminders. Unread rows drive the header
-- badge; clicking a row marks it read and follows its deep link.
-- Additive and nullable: safe to apply on preview/prod via wrangler.
-- A partial unique index dedupes repeat emissions while a notification is
-- still unread (e.g. two @mentions of the same member in one post).

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL
              CHECK (kind IN ('mention','reply','follow','story_reply','poll_closed','event_reminder')),
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  preview     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(user_id) WHERE read_at IS NULL;

-- Same unread event twice = one row. Once read, the same event may notify again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications(user_id, kind, actor_id, target_type, target_id)
  WHERE read_at IS NULL;

-- Event reminders (audit/social/wiring): the hourly reminder job marks an
-- event once its 24h reminder has gone out, so the 15-minute cron window
-- cannot re-send emails to the same RSVP list.
ALTER TABLE events ADD COLUMN reminder_sent_at TEXT;
