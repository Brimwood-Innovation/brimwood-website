-- 0002_blog.sql — authors, categories, tags, posts (report §11.2)

CREATE TABLE authors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role_title    TEXT,
  bio           TEXT,
  avatar_r2_key TEXT
);

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT
);
-- Seed (T15): the four content pillars as categories.
-- (Seeded via D1 execute after migration; see seed.sql.)

CREATE TABLE tags (
  id    TEXT PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE posts (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  excerpt         TEXT NOT NULL,
  body_md         TEXT NOT NULL,
  body_html       TEXT,
  cover_r2_key    TEXT,
  author_id       TEXT REFERENCES authors(id),
  category_id     TEXT REFERENCES categories(id),
  pillar          TEXT
                  CHECK (pillar IN ('micro-business','ai-in-practice',
                                    'owner-mindset','members-and-hub')),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','published','archived')),
  published_at    TEXT,
  reading_minutes INTEGER,
  featured        INTEGER NOT NULL DEFAULT 0,
  seo_title       TEXT,
  seo_description TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_posts_status_published ON posts(status, published_at DESC);
CREATE INDEX idx_posts_category ON posts(category_id, published_at DESC);
