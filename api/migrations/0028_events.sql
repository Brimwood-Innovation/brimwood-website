-- 0028_events.sql: event kinds, RSVP by member, reminders, recaps, demo night.
--
-- Why: 0007 stores RSVPs by name and email only, so a member's RSVP cannot
-- be joined to the member, and there is no home for demo slots, demo
-- submissions with "needs", written feedback or check-ins (L1651-L1691).
-- Feedback is written words only: there is no score column anywhere (SPEC 3.2).
-- Times are stored UTC; the site shows America/Toronto (R5, X2).

ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'
  CHECK (kind IN ('demo_night','public_demo','ama','build_session','workshop','other'));
ALTER TABLE events ADD COLUMN number INTEGER CHECK (number IS NULL OR number > 0);
ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'members'
  CHECK (visibility IN ('members','members_and_guests','public'));
ALTER TABLE events ADD COLUMN tz TEXT NOT NULL DEFAULT 'America/Toronto';
ALTER TABLE events ADD COLUMN demo_slots_total INTEGER CHECK (demo_slots_total IS NULL OR demo_slots_total BETWEEN 1 AND 20);
CREATE UNIQUE INDEX idx_events_kind_number ON events (kind, number) WHERE number IS NOT NULL;
CREATE INDEX idx_events_upcoming ON events (status, starts_at);

-- RSVP by member (keeps name/email for the public monthly demo guests).
ALTER TABLE event_rsvps ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX idx_rsvps_event_user ON event_rsvps (event_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_rsvps_user ON event_rsvps (user_id) WHERE user_id IS NOT NULL;

-- Reminders at 24 h and 1 h. Quiet hours can suppress one (L1676).
CREATE TABLE event_reminders (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offset_minutes    INTEGER NOT NULL CHECK (offset_minutes IN (60, 1440)),
  due_at            TEXT NOT NULL,
  sent_at           TEXT,
  suppressed_reason TEXT CHECK (suppressed_reason IS NULL OR suppressed_reason IN ('quiet_hours','opted_out','cancelled')),
  UNIQUE (event_id, user_id, offset_minutes),
  CHECK (sent_at IS NULL OR suppressed_reason IS NULL)
);
CREATE INDEX idx_event_reminders_due ON event_reminders (due_at) WHERE sent_at IS NULL AND suppressed_reason IS NULL;

CREATE TABLE event_recaps (
  event_id          TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  body_md           TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 10000),
  recording_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  -- Recordings stay members-only unless every presenter consented (P1-10).
  recording_visibility TEXT NOT NULL DEFAULT 'members' CHECK (recording_visibility IN ('members','public')),
  thread_post_id    TEXT REFERENCES feed_posts(id) ON DELETE SET NULL,
  published_at      TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Demo submissions: what you will show and what you need from the room.
CREATE TABLE demo_submissions (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  summary     TEXT NOT NULL CHECK (length(summary) BETWEEN 10 AND 600),
  needs       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(needs) AND json_type(needs) = 'array'),
  status      TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','waitlisted','withdrawn','declined')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (event_id, user_id)
);
CREATE INDEX idx_demo_submissions_event ON demo_submissions (event_id, status);
-- needs uses a fixed vocabulary so the room can prepare.
CREATE TRIGGER trg_demo_submissions_needs
BEFORE INSERT ON demo_submissions
WHEN EXISTS (SELECT 1 FROM json_each(NEW.needs)
             WHERE value NOT IN ('feedback_on_idea','feedback_on_ux','first_users','technical_help',
                                 'pricing_help','co_builder','intro_to_someone'))
BEGIN
  SELECT RAISE(ABORT, 'unknown need');
END;

-- Demo slots: 5 minutes each by default. Capstones point here (0031).
CREATE TABLE demo_slots (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  slot_no       INTEGER NOT NULL CHECK (slot_no BETWEEN 1 AND 20),
  minutes       INTEGER NOT NULL DEFAULT 5 CHECK (minutes BETWEEN 3 AND 15),
  submission_id TEXT UNIQUE REFERENCES demo_submissions(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','delivered','no_show','released')),
  delivered_at  TEXT,
  logged_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (event_id, slot_no),
  CHECK (status = 'open' OR status = 'released' OR submission_id IS NOT NULL),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

-- Written feedback only (no score, no rating). Private to the presenter.
CREATE TABLE demo_feedback (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES demo_submissions(id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt        TEXT NOT NULL CHECK (prompt IN ('what_worked','what_was_unclear','one_idea','offer_help')),
  body          TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 10 AND 1500),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (submission_id, author_id, prompt)
);
CREATE INDEX idx_demo_feedback_submission ON demo_feedback (submission_id, created_at);
CREATE TRIGGER trg_demo_feedback_rules
BEFORE INSERT ON demo_feedback
WHEN NEW.author_id = (SELECT user_id FROM demo_submissions WHERE id = NEW.submission_id)
  OR EXISTS (SELECT 1 FROM demo_submissions s JOIN block_pairs bp ON bp.a = NEW.author_id AND bp.b = s.user_id
             WHERE s.id = NEW.submission_id)
BEGIN
  SELECT RAISE(ABORT, 'feedback goes to another member you have not blocked');
END;

-- Event check-ins: staff mark attendance, or the member checks in at the door.
CREATE TABLE event_checkins (
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('staff','self_qr')),
  checked_in_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  checked_in_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (event_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_event_checkins_user ON event_checkins (user_id);
