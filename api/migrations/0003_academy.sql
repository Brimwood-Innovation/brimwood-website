-- 0003_academy.sql — courses, modules, lessons, enrolments, progress (report §11.2)

CREATE TABLE courses (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  tagline         TEXT NOT NULL,
  description_md  TEXT NOT NULL,
  cover_r2_key    TEXT,
  level           TEXT NOT NULL DEFAULT 'foundations'
                  CHECK (level IN ('foundations','builder','operator')),
  visibility      TEXT NOT NULL DEFAULT 'members'
                  CHECK (visibility IN ('public','members')),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','archived')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_courses_status ON courses(status, sort_order);

CREATE TABLE modules (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_modules_course ON modules(course_id, sort_order);

CREATE TABLE lessons (
  id              TEXT PRIMARY KEY,
  module_id       TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body_md         TEXT NOT NULL,
  body_html       TEXT,
  video_r2_key    TEXT,
  duration_minutes INTEGER,
  is_preview      INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','archived')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (module_id, slug)
);
CREATE INDEX idx_lessons_module ON lessons(module_id, sort_order);

CREATE TABLE enrollments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  TEXT,
  UNIQUE (user_id, course_id)
);

CREATE TABLE lesson_progress (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'started'
                CHECK (status IN ('started','completed')),
  completed_at  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, lesson_id)
);
CREATE INDEX idx_progress_user ON lesson_progress(user_id);
