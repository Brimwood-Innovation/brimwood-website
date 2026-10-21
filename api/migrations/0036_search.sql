-- 0036_search.sql: one search table for hub and site search, kept in sync by triggers.
--
-- Why: hub global search and site search (L979, SPEC 3.2) need one place to
-- query feed posts, events, pages, courses and lessons.
-- FTS5: D1 supports FTS5 (Cloudflare D1 SQL statements docs). BUT the D1
-- docs also say "Export is not supported for virtual tables, including
-- databases with virtual tables", so an FTS5 table would break
-- "wrangler d1 export" backups for the whole database. So v5 ships a plain
-- table here (LIKE search, prefix index on title), and the FTS5 index is a
-- separate, opt-in file: db/migrations/pending/0901_search_fts5.sql.
-- Read rules stay in the API: visibility, group membership and block_pairs
-- are applied to every result (S12).
-- Update triggers fire only on the indexed columns, so a cron write such as
-- events.reminder_sent_at does not rewrite search rows (D1 bills rows written).
-- Members are not copied here: people search reads member_profiles and
-- users directly, only for members with directory_opt_in = 1 (PIPEDA).

CREATE TABLE search_documents (
  id         INTEGER PRIMARY KEY,              -- rowid for the optional FTS5 external-content index
  doc_type   TEXT NOT NULL CHECK (doc_type IN ('feed_post','event','page','course','lesson')),
  doc_id     TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public','members')),
  group_id   TEXT,
  author_id  TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (doc_type, doc_id)
);
CREATE INDEX idx_search_documents_title ON search_documents (title COLLATE NOCASE);
CREATE INDEX idx_search_documents_recent ON search_documents (visibility, updated_at DESC);

-- Anonymous query log for "Popular right now" (L998). No user id, no IP.
CREATE TABLE search_queries_daily (
  day          TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  term         TEXT NOT NULL CHECK (length(term) BETWEEN 1 AND 60 AND term = lower(term)),
  count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  zero_results INTEGER NOT NULL DEFAULT 0 CHECK (zero_results >= 0),
  PRIMARY KEY (day, term)
) WITHOUT ROWID;

-- feed_posts -> search_documents
CREATE TRIGGER trg_search_feed_post_ins AFTER INSERT ON feed_posts
BEGIN
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'feed_post', NEW.id, '', substr(NEW.body, 1, 20000), 'members', NEW.group_id, NEW.author_id, NEW.created_at
  WHERE NEW.status = 'published' AND NEW.deleted_at IS NULL AND NEW.audience <> 'only_me';
END;
CREATE TRIGGER trg_search_feed_post_upd AFTER UPDATE OF body, status, deleted_at, audience, group_id ON feed_posts
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'feed_post' AND doc_id = OLD.id;
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'feed_post', NEW.id, '', substr(NEW.body, 1, 20000), 'members', NEW.group_id, NEW.author_id, NEW.created_at
  WHERE NEW.status = 'published' AND NEW.deleted_at IS NULL AND NEW.audience <> 'only_me';
END;
CREATE TRIGGER trg_search_feed_post_del AFTER DELETE ON feed_posts
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'feed_post' AND doc_id = OLD.id;
END;

-- backfill
INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'feed_post', id, '', substr(body, 1, 20000), 'members', group_id, author_id, created_at
  FROM feed_posts WHERE status = 'published' AND deleted_at IS NULL AND audience <> 'only_me';

-- events -> search_documents
CREATE TRIGGER trg_search_event_ins AFTER INSERT ON events
BEGIN
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'event', NEW.id, NEW.title, substr(coalesce(NEW.description_md, ''), 1, 20000), CASE NEW.visibility WHEN 'public' THEN 'public' ELSE 'members' END, NULL, NULL, NEW.created_at
  WHERE NEW.status = 'published';
END;
CREATE TRIGGER trg_search_event_upd AFTER UPDATE OF title, description_md, visibility, status ON events
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'event' AND doc_id = OLD.id;
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'event', NEW.id, NEW.title, substr(coalesce(NEW.description_md, ''), 1, 20000), CASE NEW.visibility WHEN 'public' THEN 'public' ELSE 'members' END, NULL, NULL, NEW.created_at
  WHERE NEW.status = 'published';
END;
CREATE TRIGGER trg_search_event_del AFTER DELETE ON events
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'event' AND doc_id = OLD.id;
END;

-- backfill
INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'event', id, title, substr(coalesce(description_md, ''), 1, 20000), CASE visibility WHEN 'public' THEN 'public' ELSE 'members' END, NULL, NULL, created_at
  FROM events WHERE status = 'published';

-- pages -> search_documents
CREATE TRIGGER trg_search_page_ins AFTER INSERT ON pages
BEGIN
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'page', NEW.id, NEW.title, substr(NEW.body_md, 1, 20000), 'public', NULL, NULL, NEW.updated_at
  WHERE NEW.status = 'published' AND NEW.trashed_at IS NULL AND NEW.noindex = 0;
END;
CREATE TRIGGER trg_search_page_upd AFTER UPDATE OF title, body_md, status, trashed_at, noindex ON pages
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'page' AND doc_id = OLD.id;
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'page', NEW.id, NEW.title, substr(NEW.body_md, 1, 20000), 'public', NULL, NULL, NEW.updated_at
  WHERE NEW.status = 'published' AND NEW.trashed_at IS NULL AND NEW.noindex = 0;
END;
CREATE TRIGGER trg_search_page_del AFTER DELETE ON pages
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'page' AND doc_id = OLD.id;
END;

-- backfill
INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'page', id, title, substr(body_md, 1, 20000), 'public', NULL, NULL, updated_at
  FROM pages WHERE status = 'published' AND trashed_at IS NULL AND noindex = 0;

-- courses -> search_documents
CREATE TRIGGER trg_search_course_ins AFTER INSERT ON courses
BEGIN
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'course', NEW.id, NEW.title, substr(NEW.tagline || ' ' || NEW.description_md, 1, 20000), CASE NEW.visibility WHEN 'public' THEN 'public' ELSE 'members' END, NULL, NULL, NEW.updated_at
  WHERE NEW.status = 'published';
END;
CREATE TRIGGER trg_search_course_upd AFTER UPDATE OF title, tagline, description_md, visibility, status ON courses
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'course' AND doc_id = OLD.id;
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'course', NEW.id, NEW.title, substr(NEW.tagline || ' ' || NEW.description_md, 1, 20000), CASE NEW.visibility WHEN 'public' THEN 'public' ELSE 'members' END, NULL, NULL, NEW.updated_at
  WHERE NEW.status = 'published';
END;
CREATE TRIGGER trg_search_course_del AFTER DELETE ON courses
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'course' AND doc_id = OLD.id;
END;

-- backfill
INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'course', id, title, substr(tagline || ' ' || description_md, 1, 20000), CASE visibility WHEN 'public' THEN 'public' ELSE 'members' END, NULL, NULL, updated_at
  FROM courses WHERE status = 'published';

-- lessons -> search_documents
CREATE TRIGGER trg_search_lesson_ins AFTER INSERT ON lessons
BEGIN
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'lesson', NEW.id, NEW.title, substr(NEW.body_md, 1, 20000), CASE NEW.is_preview WHEN 1 THEN 'public' ELSE 'members' END, NULL, NULL, NEW.updated_at
  WHERE NEW.status = 'published';
END;
CREATE TRIGGER trg_search_lesson_upd AFTER UPDATE OF title, body_md, is_preview, status ON lessons
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'lesson' AND doc_id = OLD.id;
  INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'lesson', NEW.id, NEW.title, substr(NEW.body_md, 1, 20000), CASE NEW.is_preview WHEN 1 THEN 'public' ELSE 'members' END, NULL, NULL, NEW.updated_at
  WHERE NEW.status = 'published';
END;
CREATE TRIGGER trg_search_lesson_del AFTER DELETE ON lessons
BEGIN
  DELETE FROM search_documents WHERE doc_type = 'lesson' AND doc_id = OLD.id;
END;

-- backfill
INSERT INTO search_documents (doc_type, doc_id, title, body, visibility, group_id, author_id, updated_at)
  SELECT 'lesson', id, title, substr(body_md, 1, 20000), CASE is_preview WHEN 1 THEN 'public' ELSE 'members' END, NULL, NULL, updated_at
  FROM lessons WHERE status = 'published';

