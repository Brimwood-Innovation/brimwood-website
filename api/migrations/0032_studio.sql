-- 0032_studio.sql: Studio (D4): pages, revisions, media, SEO, redirects,
-- publish queue, newsletter, API keys, webhooks.
--
-- Why: D4 makes Studio on D1 the one owner of pages, events, courses,
-- newsletter and feed moderation (the blog stays in Git via Decap).
-- Every save keeps a revision so "restore" makes a new draft and never
-- overwrites what is live (L1333). Redirects are checked in the database so
-- an editor cannot create an open redirect (S22). Scheduled publishing is a
-- staff feature and runs in UTC (D9, X1, X2).
-- Rich text is Markdown only: no raw-HTML column on any new table (P1-9).

CREATE TABLE pages (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 80 AND slug NOT GLOB '*[^a-z0-9/-]*'),
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body_md          TEXT NOT NULL DEFAULT '' CHECK (length(body_md) <= 100000),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','scheduled','published','archived')),
  meta_title       TEXT CHECK (meta_title IS NULL OR length(meta_title) <= 60),
  meta_description TEXT CHECK (meta_description IS NULL OR length(meta_description) <= 155),
  canonical_path   TEXT CHECK (canonical_path IS NULL OR (canonical_path LIKE '/%' AND canonical_path NOT LIKE '//%')),
  noindex          INTEGER NOT NULL DEFAULT 0 CHECK (noindex IN (0,1)),
  og_media_id      TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  author_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at     TEXT,
  trashed_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE INDEX idx_pages_status ON pages (status, updated_at DESC);
CREATE INDEX idx_pages_trash ON pages (trashed_at) WHERE trashed_at IS NOT NULL;

-- Generic revisions for every Studio-owned type. Restore = new revision with
-- restored_from_id set, saved as a draft.
CREATE TABLE content_revisions (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('page','event','course','module','lesson',
                     'newsletter_issue','house_info','community_rule','announcement')),
  entity_id        TEXT NOT NULL,
  version_no       INTEGER NOT NULL CHECK (version_no >= 1),
  snapshot_json    TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(snapshot_json) <= 500000),
  author_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  note             TEXT CHECK (note IS NULL OR length(note) <= 200),
  restored_from_id TEXT REFERENCES content_revisions(id) ON DELETE SET NULL,
  conflict_choice  TEXT CHECK (conflict_choice IS NULL OR conflict_choice IN ('keep_mine','use_theirs','copy_both')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (entity_type, entity_id, version_no)
);
CREATE INDEX idx_content_revisions_list ON content_revisions (entity_type, entity_id, version_no DESC);
CREATE TRIGGER trg_content_revisions_append_only
BEFORE UPDATE ON content_revisions
BEGIN SELECT RAISE(ABORT, 'revisions are append-only; restore makes a new revision'); END;

-- Editorial margin comments on drafts (L1351).
CREATE TABLE editorial_comments (
  id          TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES content_revisions(id) ON DELETE CASCADE,
  anchor      TEXT NOT NULL CHECK (length(anchor) <= 80),
  body        TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'resolved') = (resolved_by IS NOT NULL))
);
CREATE INDEX idx_editorial_comments_open ON editorial_comments (revision_id) WHERE status = 'open';

-- Media library additions (S18). The existing 0004 columns stay.
ALTER TABLE media_assets ADD COLUMN focal_x REAL CHECK (focal_x IS NULL OR focal_x BETWEEN 0 AND 1);
ALTER TABLE media_assets ADD COLUMN focal_y REAL CHECK (focal_y IS NULL OR focal_y BETWEEN 0 AND 1);
ALTER TABLE media_assets ADD COLUMN decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0,1));
ALTER TABLE media_assets ADD COLUMN bucket TEXT NOT NULL DEFAULT 'public' CHECK (bucket IN ('public','private'));
ALTER TABLE media_assets ADD COLUMN metadata_stripped INTEGER NOT NULL DEFAULT 0 CHECK (metadata_stripped IN (0,1));
ALTER TABLE media_assets ADD COLUMN deleted_at TEXT;
-- Decorative images carry empty alt text; informative images need alt text
-- before use (L1284, L1339). Triggers, because ADD COLUMN cannot add a
-- table-level CHECK.
CREATE TRIGGER trg_media_alt_rules
BEFORE UPDATE OF decorative, alt_text ON media_assets
WHEN NEW.decorative = 1 AND NEW.alt_text <> ''
BEGIN
  SELECT RAISE(ABORT, 'a decorative image has empty alt text');
END;
CREATE TRIGGER trg_media_alt_rules_insert
BEFORE INSERT ON media_assets
WHEN NEW.decorative = 1 AND NEW.alt_text <> ''
BEGIN
  SELECT RAISE(ABORT, 'a decorative image has empty alt text');
END;
-- Images must be stripped of EXIF/GPS before they are stored (P1-10).
CREATE TRIGGER trg_media_exif_stripped
BEFORE INSERT ON media_assets
WHEN NEW.mime LIKE 'image/%' AND NEW.metadata_stripped = 0
BEGIN
  SELECT RAISE(ABORT, 'strip image metadata before storing');
END;
CREATE TRIGGER trg_media_no_svg
BEFORE INSERT ON media_assets
WHEN NEW.mime = 'image/svg+xml'
BEGIN
  SELECT RAISE(ABORT, 'SVG uploads are not allowed');
END;

-- Where each media item is used. RESTRICT stops a careless hard delete.
CREATE TABLE media_usages (
  media_id    TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('page','event','course','lesson','newsletter_issue','group','project','recap')),
  entity_id   TEXT NOT NULL,
  field       TEXT NOT NULL CHECK (field IN ('featured','body','og','video','avatar','cover','recording')),
  PRIMARY KEY (media_id, entity_type, entity_id, field)
) WITHOUT ROWID;
CREATE INDEX idx_media_usages_entity ON media_usages (entity_type, entity_id);
CREATE TRIGGER trg_media_soft_delete_unused
BEFORE UPDATE OF deleted_at ON media_assets
WHEN NEW.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM media_usages WHERE media_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'media is still in use');
END;

-- Redirects (S22). Both paths are site-relative: start with one "/", no "//",
-- no backslash, printable ASCII only, no encoded slash or backslash at the
-- start. This blocks open redirects like "//evil.example" or "/\evil.example".
CREATE TABLE redirects (
  from_path   TEXT PRIMARY KEY CHECK (
                substr(from_path, 1, 1) = '/' AND substr(from_path, 1, 2) <> '//'
                AND instr(from_path, char(92)) = 0 AND from_path NOT GLOB '*[^!-~]*'
                AND length(from_path) <= 300),
  to_path     TEXT NOT NULL CHECK (
                substr(to_path, 1, 1) = '/' AND substr(to_path, 1, 2) <> '//'
                AND instr(to_path, char(92)) = 0 AND to_path NOT GLOB '*[^!-~]*'
                AND lower(substr(to_path, 1, 4)) NOT IN ('/%2f','/%5c')
                AND instr(lower(to_path), '%5c') = 0
                AND length(to_path) <= 300),
  status_code INTEGER NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 308)),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (from_path <> to_path)
) WITHOUT ROWID;

-- One queue for everything Studio schedules. run_at is a UTC instant; the
-- calendar shows display_tz (America/Toronto).
CREATE TABLE publish_queue (
  id          TEXT PRIMARY KEY,
  item_type   TEXT NOT NULL CHECK (item_type IN ('page','event','course','lesson','newsletter_issue','announcement','ritual_run')),
  item_id     TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT 'publish' CHECK (action IN ('publish','unpublish','send')),
  run_at      TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', run_at) = run_at),
  display_tz  TEXT NOT NULL DEFAULT 'America/Toronto',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  last_error  TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE UNIQUE INDEX idx_publish_queue_one_pending ON publish_queue (item_type, item_id, action) WHERE status = 'pending';
CREATE INDEX idx_publish_queue_due ON publish_queue (run_at) WHERE status = 'pending';
-- D9: only staff can schedule.
CREATE TRIGGER trg_publish_queue_staff_only
BEFORE INSERT ON publish_queue
WHEN NOT EXISTS (SELECT 1 FROM user_effective_roles WHERE user_id = NEW.created_by AND role IN ('admin','editor'))
BEGIN
  SELECT RAISE(ABORT, 'scheduling is a Studio feature (D9)');
END;

-- Newsletter. Segments live in D1, not KV (C6).
CREATE TABLE newsletter_segments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 2 AND 60),
  rule_json   TEXT NOT NULL CHECK (json_valid(rule_json)),
  cached_count INTEGER CHECK (cached_count IS NULL OR cached_count >= 0),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE newsletter_issues (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE CHECK (slug NOT GLOB '*[^a-z0-9-]*'),
  subject      TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  preview_text TEXT CHECK (preview_text IS NULL OR length(preview_text) <= 150),
  body_md      TEXT NOT NULL DEFAULT '' CHECK (length(body_md) <= 100000),
  segment_id   TEXT REFERENCES newsletter_segments(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled')),
  scheduled_for TEXT,
  sent_at      TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL)
);
CREATE INDEX idx_newsletter_issues_status ON newsletter_issues (status, scheduled_for);

-- Pre-send checklist (L1336): five gates before a send.
CREATE TABLE newsletter_checklists (
  issue_id              TEXT PRIMARY KEY REFERENCES newsletter_issues(id) ON DELETE CASCADE,
  links_total           INTEGER NOT NULL DEFAULT 0 CHECK (links_total >= 0),
  links_ok              INTEGER NOT NULL DEFAULT 0 CHECK (links_ok >= 0),
  preview_ok_at         TEXT,
  test_send_at          TEXT,
  audience_confirmed_at TEXT,
  approved_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (links_ok <= links_total)
);
CREATE TRIGGER trg_newsletter_send_gate
BEFORE UPDATE OF status ON newsletter_issues
WHEN NEW.status IN ('scheduled','sending') AND OLD.status = 'draft' AND (
  length(NEW.subject) > 60
  OR NEW.preview_text IS NULL
  OR NOT EXISTS (SELECT 1 FROM newsletter_checklists c WHERE c.issue_id = NEW.id
                 AND c.links_ok = c.links_total AND c.preview_ok_at IS NOT NULL
                 AND c.test_send_at IS NOT NULL AND c.audience_confirmed_at IS NOT NULL
                 AND c.approved_by IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'pre-send checklist is not complete');
END;

-- One row per issue per subscriber: a retry cannot send twice.
CREATE TABLE newsletter_sends (
  issue_id      TEXT NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','bounced','complained','suppressed')),
  provider_id   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent_at       TEXT,
  PRIMARY KEY (issue_id, subscriber_id)
) WITHOUT ROWID;
CREATE INDEX idx_newsletter_sends_queue ON newsletter_sends (issue_id, status);

-- API keys (S22): shown once, stored hashed, scoped, must expire within a year.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  prefix       TEXT NOT NULL UNIQUE CHECK (length(prefix) BETWEEN 6 AND 12),
  key_hash     TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  scopes       TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  owner_id     TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  CHECK (julianday(expires_at) > julianday(created_at) AND julianday(expires_at) - julianday(created_at) <= 366)
);

-- Webhooks (S22): HTTPS only. The signing secret must be readable to sign,
-- so it is stored encrypted (AES-GCM, key in a Worker secret), not hashed.
CREATE TABLE webhooks (
  id                TEXT PRIMARY KEY,
  url               TEXT NOT NULL CHECK (url LIKE 'https://%' AND url NOT LIKE 'https://localhost%'
                                         AND url NOT GLOB 'https://[0-9]*' AND length(url) <= 500),
  events            TEXT NOT NULL CHECK (json_valid(events) AND json_type(events) = 'array'),
  secret_ciphertext BLOB NOT NULL,
  key_id            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','failing','disabled')),
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- No payload bodies are stored (S22).
CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  status_code     INTEGER,
  next_attempt_at TEXT,
  dead_lettered_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  purge_after     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'))
);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries (next_attempt_at) WHERE next_attempt_at IS NOT NULL AND dead_lettered_at IS NULL;
CREATE INDEX idx_webhook_deliveries_purge ON webhook_deliveries (purge_after);
