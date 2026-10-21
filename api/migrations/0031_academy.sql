-- 0031_academy.sql: cohorts, reflections (D6), captions, capstones, certificates (D3).
--
-- Why:
-- D6: a lesson is complete only when the member submits a reflection. The
--     reflection is private by default; the member may share it with the cohort.
-- D3: certificate code BRIM-YYYY-XXXXXX, 6 chars from the 31-symbol alphabet
--     23456789ABCDEFGHJKMNPQRSTUVWXYZ (no 0 O 1 I L), UNIQUE. Ed25519 signature
--     over "v1|code|member_id|course_id|issued_at". The name is not signed and
--     not stored here: the page shows the member's current display name.
--     Private by default (P0-3). Revocation is a state plus an event row,
--     never a delete.
-- R3: Foundations is 3 modules and 9 lessons (seed data, not schema).

CREATE TABLE cohorts (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL CHECK (number >= 1),
  slug          TEXT NOT NULL UNIQUE CHECK (slug NOT GLOB '*[^a-z0-9-]*'),
  starts_on     TEXT NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  demo_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  group_id      TEXT REFERENCES groups(id) ON DELETE SET NULL,
  capacity      INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 200),
  status        TEXT NOT NULL DEFAULT 'enrolling' CHECK (status IN ('enrolling','active','graduated','archived')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (course_id, number)
);

CREATE TABLE cohort_members (
  cohort_id TEXT NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'learner' CHECK (role IN ('learner','buddy','facilitator')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at   TEXT,
  PRIMARY KEY (cohort_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_cohort_members_user ON cohort_members (user_id);
CREATE TRIGGER trg_cohort_members_capacity
BEFORE INSERT ON cohort_members
WHEN NEW.role = 'learner'
 AND (SELECT capacity FROM cohorts WHERE id = NEW.cohort_id) IS NOT NULL
 AND (SELECT count(*) FROM cohort_members WHERE cohort_id = NEW.cohort_id AND role = 'learner' AND left_at IS NULL)
     >= (SELECT capacity FROM cohorts WHERE id = NEW.cohort_id)
BEGIN
  SELECT RAISE(ABORT, 'cohort is full');
END;

-- Reflections (D6). One per member per lesson; editing keeps the row.
CREATE TABLE lesson_reflections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: reflections are member writing and the D6 proof of
  -- completion. A lesson that leaves the CMS is archived, never deleted.
  lesson_id  TEXT NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
  body       TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 20 AND 2000),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','cohort')),
  cohort_id  TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
  shared_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, lesson_id),
  CHECK ((visibility = 'cohort') = (cohort_id IS NOT NULL AND shared_at IS NOT NULL))
);
CREATE INDEX idx_reflections_cohort ON lesson_reflections (cohort_id, lesson_id, shared_at DESC) WHERE visibility = 'cohort';
CREATE TRIGGER trg_reflections_share_own_cohort
BEFORE UPDATE OF visibility, cohort_id ON lesson_reflections
WHEN NEW.visibility = 'cohort' AND NOT EXISTS (
  SELECT 1 FROM cohort_members WHERE cohort_id = NEW.cohort_id AND user_id = NEW.user_id AND left_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'share only with a cohort you belong to');
END;
CREATE TRIGGER trg_reflections_share_own_cohort_insert
BEFORE INSERT ON lesson_reflections
WHEN NEW.visibility = 'cohort' AND NOT EXISTS (
  SELECT 1 FROM cohort_members WHERE cohort_id = NEW.cohort_id AND user_id = NEW.user_id AND left_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'share only with a cohort you belong to');
END;

-- Archive, never delete, a lesson that members have worked on. The sync job
-- (api/src/routes/sync.ts) sets lessons.status = 'archived' and
-- modules.archived_at instead of DELETE. This trigger gives a clear message
-- (the RESTRICT key above would only say "FOREIGN KEY constraint failed"),
-- and also covers progress rows, which 0003 would otherwise cascade away.
-- It fires for module deletes too, because the cascade deletes each lesson.
ALTER TABLE modules ADD COLUMN archived_at TEXT;
CREATE TRIGGER trg_lessons_archive_not_delete
BEFORE DELETE ON lessons
WHEN EXISTS (SELECT 1 FROM lesson_reflections WHERE lesson_id = OLD.id)
  OR EXISTS (SELECT 1 FROM lesson_progress WHERE lesson_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'members have worked on this lesson; archive it (status = archived) instead of deleting');
END;

-- D6 gate. Rows completed before 0031 stay as they are (trigger fires on writes).
-- BEFORE INSERT also covers the API upsert (INSERT ... ON CONFLICT DO UPDATE).
CREATE TRIGGER trg_lesson_progress_needs_reflection
BEFORE INSERT ON lesson_progress
WHEN NEW.status = 'completed' AND NOT EXISTS (
  SELECT 1 FROM lesson_reflections WHERE user_id = NEW.user_id AND lesson_id = NEW.lesson_id)
BEGIN
  SELECT RAISE(ABORT, 'a lesson is complete when its reflection is submitted (D6)');
END;
CREATE TRIGGER trg_lesson_progress_needs_reflection_update
BEFORE UPDATE OF status ON lesson_progress
WHEN NEW.status = 'completed' AND OLD.status <> 'completed' AND NOT EXISTS (
  SELECT 1 FROM lesson_reflections WHERE user_id = NEW.user_id AND lesson_id = NEW.lesson_id)
BEGIN
  SELECT RAISE(ABORT, 'a lesson is complete when its reflection is submitted (D6)');
END;

-- Captions and transcripts per lesson (WCAG 1.2.2, L1682).
CREATE TABLE lesson_captions (
  id         TEXT PRIMARY KEY,
  lesson_id  TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('captions','transcript')),
  lang       TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','fr')),
  r2_key     TEXT,                   -- WebVTT file for captions
  body_md    TEXT,                   -- searchable transcript text
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (lesson_id, kind, lang),
  CHECK (kind <> 'captions' OR r2_key IS NOT NULL),
  CHECK (kind <> 'transcript' OR body_md IS NOT NULL)
);
-- Studio warning list: published video lessons without published captions.
CREATE VIEW lessons_missing_captions AS
  SELECT l.id, l.slug, l.title FROM lessons l
  WHERE l.status = 'published' AND l.video_r2_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM lesson_captions c WHERE c.lesson_id = l.id
                    AND c.kind = 'captions' AND c.status = 'published');

-- Capstone: the project a learner demos at a demo night slot.
CREATE TABLE capstones (
  id            TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollments(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  demo_slot_id  TEXT UNIQUE REFERENCES demo_slots(id) ON DELETE SET NULL,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  demoed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (demoed_at IS NULL OR demo_slot_id IS NOT NULL)
);

-- Public signing keys. The private key is a Worker secret, never in D1.
CREATE TABLE signing_keys (
  key_id     TEXT PRIMARY KEY,
  alg        TEXT NOT NULL DEFAULT 'Ed25519' CHECK (alg = 'Ed25519'),
  public_key TEXT NOT NULL UNIQUE CHECK (length(public_key) = 43 AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at TEXT
);

CREATE TABLE certificates (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE CHECK (
                   length(code) = 16 AND substr(code, 1, 5) = 'BRIM-'
                   AND substr(code, 6, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(code, 10, 1) = '-'
                   -- 31-symbol alphabet, no 0 O 1 I L. Short patterns: D1 caps GLOB at 50 bytes.
                   AND substr(code, 11) NOT GLOB '*[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]*'),
  -- Users are anonymised, not hard-deleted, so RESTRICT keeps the signed
  -- member_id valid for as long as the certificate exists.
  member_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  course_id      TEXT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  enrollment_id  TEXT NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  capstone_id    TEXT REFERENCES capstones(id) ON DELETE SET NULL,
  issued_at      TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at),
  hours          REAL NOT NULL CHECK (hours > 0 AND hours <= 500),
  canonical      TEXT NOT NULL,
  signature      TEXT NOT NULL CHECK (length(signature) = 86 AND signature NOT GLOB '*[^A-Za-z0-9_-]*'),
  signing_key_id TEXT NOT NULL REFERENCES signing_keys(key_id),
  issue_source   TEXT NOT NULL DEFAULT 'auto' CHECK (issue_source IN ('auto','manual')),
  issued_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  issue_reason   TEXT,
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','link','public')),
  status         TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','revoked','superseded','withdrawn')),
  status_changed_at TEXT,
  status_changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status_reason  TEXT,
  supersedes_id  TEXT REFERENCES certificates(id),
  -- The year in the code is the year of issue.
  CHECK (substr(code, 6, 4) = substr(issued_at, 1, 4)),
  -- D3 canonical string, exactly.
  CHECK (canonical = 'v1|' || code || '|' || member_id || '|' || course_id || '|' || issued_at),
  CHECK (issue_source = 'auto' OR (issued_by IS NOT NULL AND coalesce(length(trim(issue_reason)), 0) > 0)),
  CHECK (status = 'valid' OR (status_changed_at IS NOT NULL AND coalesce(length(trim(status_reason)), 0) > 0)),
  -- Only a valid certificate can be seen by others.
  CHECK (status = 'valid' OR visibility = 'private')
);
-- Idempotent auto-issue: one valid certificate per enrolment.
CREATE UNIQUE INDEX idx_certificates_one_valid ON certificates (enrollment_id) WHERE status = 'valid';
CREATE INDEX idx_certificates_member ON certificates (member_id);

CREATE TRIGGER trg_certificates_immutable
BEFORE UPDATE OF code, member_id, course_id, enrollment_id, issued_at, hours, canonical, signature, signing_key_id ON certificates
BEGIN
  SELECT RAISE(ABORT, 'certificates are immutable; re-issue instead');
END;
CREATE TRIGGER trg_certificates_terminal
BEFORE UPDATE OF status ON certificates
WHEN OLD.status <> 'valid' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'a revoked, superseded or withdrawn certificate stays that way');
END;
CREATE TRIGGER trg_certificates_no_delete
BEFORE DELETE ON certificates
BEGIN
  SELECT RAISE(ABORT, 'certificates are never deleted; revoke or withdraw');
END;
CREATE TRIGGER trg_certificates_completed_enrollment
BEFORE INSERT ON certificates
WHEN NOT EXISTS (SELECT 1 FROM enrollments WHERE id = NEW.enrollment_id AND user_id = NEW.member_id
                 AND course_id = NEW.course_id AND completed_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'certificate needs a completed enrolment of this member in this course');
END;

-- Append-only certificate history, written by triggers so no change is missed.
CREATE TABLE certificate_events (
  id             INTEGER PRIMARY KEY,
  certificate_id TEXT NOT NULL REFERENCES certificates(id),
  kind           TEXT NOT NULL CHECK (kind IN ('issued','visibility_changed','revoked','superseded','withdrawn')),
  detail         TEXT,
  actor_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_certificate_events_cert ON certificate_events (certificate_id, id);
CREATE TRIGGER trg_certificate_events_append_only
BEFORE UPDATE ON certificate_events
BEGIN SELECT RAISE(ABORT, 'certificate_events is append-only'); END;
CREATE TRIGGER trg_certificate_events_no_delete
BEFORE DELETE ON certificate_events
BEGIN SELECT RAISE(ABORT, 'certificate_events is append-only'); END;
CREATE TRIGGER trg_certificates_log_issue
AFTER INSERT ON certificates
BEGIN
  INSERT INTO certificate_events (certificate_id, kind, detail, actor_id)
  VALUES (NEW.id, 'issued', NEW.issue_source, NEW.issued_by);
END;
CREATE TRIGGER trg_certificates_log_status
AFTER UPDATE OF status ON certificates
WHEN NEW.status <> OLD.status
BEGIN
  INSERT INTO certificate_events (certificate_id, kind, detail, actor_id)
  VALUES (NEW.id, NEW.status, NEW.status_reason, NEW.status_changed_by);
END;
CREATE TRIGGER trg_certificates_log_visibility
AFTER UPDATE OF visibility ON certificates
WHEN NEW.visibility <> OLD.visibility
BEGIN
  INSERT INTO certificate_events (certificate_id, kind, detail, actor_id)
  VALUES (NEW.id, 'visibility_changed', OLD.visibility || ' to ' || NEW.visibility,
          CASE WHEN NEW.status <> OLD.status THEN NEW.status_changed_by ELSE NEW.member_id END);
END;

-- Lookup log for /c/CODE (L1022): rate-limit evidence and spike alerts.
-- Stores no raw IP and no unknown code in clear.
CREATE TABLE certificate_lookups (
  id             INTEGER PRIMARY KEY,
  certificate_id TEXT REFERENCES certificates(id),
  code_tried_hmac TEXT,
  result         TEXT NOT NULL CHECK (result IN ('shown','private','revoked','not_found','rate_limited')),
  ip_hmac        TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  purge_after    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days'))
);
CREATE INDEX idx_certificate_lookups_spike ON certificate_lookups (certificate_id, created_at);
CREATE INDEX idx_certificate_lookups_purge ON certificate_lookups (purge_after);
