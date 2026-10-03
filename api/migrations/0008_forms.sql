-- Migration 0008: form builder (Phase B).
-- Admins create custom forms; public submissions stored + emailed.

CREATE TABLE IF NOT EXISTS forms (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'published', 'closed')),
  notify_email TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_forms_slug ON forms(slug);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms(status);

CREATE TABLE IF NOT EXISTS form_fields (
  id         TEXT PRIMARY KEY,
  form_id    TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  field_type TEXT NOT NULL
             CHECK (field_type IN ('text', 'email', 'textarea', 'select', 'checkbox')),
  required   INTEGER NOT NULL DEFAULT 0,
  options    TEXT,
  position   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_form_fields_form ON form_fields(form_id, position);

CREATE TABLE IF NOT EXISTS form_submissions (
  id           TEXT PRIMARY KEY,
  form_id      TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  data         TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form ON form_submissions(form_id);
