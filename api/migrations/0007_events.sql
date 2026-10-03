-- Migration 0007: events + RSVPs (Phase B).
-- Brimwood runs Friday demo nights; this is their home.
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description_md TEXT,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT,
  location      TEXT,
  capacity      INTEGER,
  status        TEXT NOT NULL DEFAULT 'published'
                CHECK (status IN ('draft', 'published', 'cancelled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);

CREATE TABLE IF NOT EXISTS event_rsvps (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  guests     INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'confirmed'
              CHECK (status IN ('confirmed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rsvps_event_email ON event_rsvps(event_id, email);
CREATE INDEX IF NOT EXISTS idx_rsvps_event ON event_rsvps(event_id);
