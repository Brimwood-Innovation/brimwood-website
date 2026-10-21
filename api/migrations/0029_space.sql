-- 0029_space.sql: the physical hub at 1365 Gerrard St E, Toronto.
--
-- Why: v5 adds room booking (2-hour slots, capacity, cancel), daily check-in,
-- guest passes and house info (SPEC 3.2). The database stops double
-- booking and over-capacity, because two members can book at the same time.
-- Opening hours are local wall times (America/Toronto); the API converts a
-- booking to local time and checks it against them (DST makes this hard in SQL).
-- Guests: first name and last initial only (PIPEDA minimisation).

CREATE TABLE space_resources (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE CHECK (slug NOT GLOB '*[^a-z0-9-]*'),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  kind         TEXT NOT NULL CHECK (kind IN ('room','desk_area','booth','equipment')),
  -- exclusive: one booking at a time. shared: overlapping bookings up to capacity.
  booking_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK (booking_mode IN ('exclusive','shared')),
  capacity     INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  bookable     INTEGER NOT NULL DEFAULT 1 CHECK (bookable IN (0,1)),
  floor        TEXT,
  accessibility_notes TEXT CHECK (accessibility_notes IS NULL OR length(accessibility_notes) <= 1000),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Weekly opening hours, local to tz. weekday 0 = Sunday.
CREATE TABLE space_opening_hours (
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at   TEXT NOT NULL CHECK (opens_at GLOB '[0-2][0-9]:[0-5][0-9]' AND opens_at < '24:00'),
  closes_at  TEXT NOT NULL CHECK (closes_at GLOB '[0-2][0-9]:[0-5][0-9]' AND closes_at <= '24:00'),
  tz         TEXT NOT NULL DEFAULT 'America/Toronto',
  PRIMARY KEY (weekday, opens_at),
  CHECK (closes_at > opens_at)
) WITHOUT ROWID;

-- Closures: holidays and maintenance. resource_id NULL = whole hub.
CREATE TABLE space_closures (
  id          TEXT PRIMARY KEY,
  resource_id TEXT REFERENCES space_resources(id) ON DELETE CASCADE,
  starts_at   TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts_at) = starts_at),
  ends_at     TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at) = ends_at),
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_space_closures_time ON space_closures (starts_at, ends_at);

-- Bookings: at most 2 hours, UTC instants in one fixed text form so string
-- comparison equals time comparison. The form is checked by a strftime round
-- trip, because D1 caps LIKE/GLOB patterns at 50 bytes (D1 limits page).
CREATE TABLE space_bookings (
  id           TEXT PRIMARY KEY,
  resource_id  TEXT NOT NULL REFERENCES space_resources(id) ON DELETE RESTRICT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts_at) = starts_at AND substr(starts_at, 18) = '00.000Z'),
  ends_at      TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at) = ends_at AND substr(ends_at, 18) = '00.000Z'),
  party_size   INTEGER NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 100),
  purpose      TEXT CHECK (purpose IS NULL OR length(purpose) <= 140),
  -- Event hold: the room an event uses is blocked by a normal booking row,
  -- so the same overlap rule protects it (Demo Night in the Forge Room).
  event_id     TEXT REFERENCES events(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','checked_in','no_show')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cancelled_at TEXT,
  CHECK (ends_at > starts_at),
  CHECK (round((julianday(ends_at) - julianday(starts_at)) * 1440) BETWEEN 15 AND 120),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- Partial index with the same WHERE as the triggers below, so the overlap
-- check is an index SEARCH, not a table scan.
CREATE INDEX idx_space_bookings_resource ON space_bookings (resource_id, starts_at)
  WHERE status IN ('confirmed','checked_in');
CREATE INDEX idx_space_bookings_event ON space_bookings (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_space_bookings_user ON space_bookings (user_id, starts_at DESC);

-- No-overlap, capacity and closure rules, on insert and on any change that
-- moves or re-activates a booking. Overlap test: a.start < b.end AND b.start < a.end.
-- shortcut: for shared resources the sum counts every overlapping booking,
-- not the peak at one instant, so it can refuse a booking that would fit;
-- upgrade to a per-slot sum if members hit it.
CREATE TRIGGER trg_space_bookings_rules_insert
BEFORE INSERT ON space_bookings
WHEN NEW.status IN ('confirmed','checked_in')
BEGIN
  SELECT RAISE(ABORT, 'resource is not bookable')
   WHERE NOT EXISTS (SELECT 1 FROM space_resources WHERE id = NEW.resource_id AND bookable = 1 AND active = 1);
  SELECT RAISE(ABORT, 'party is larger than the room capacity')
   WHERE NEW.party_size > (SELECT capacity FROM space_resources WHERE id = NEW.resource_id);
  SELECT RAISE(ABORT, 'booking overlaps another booking')
   WHERE (SELECT booking_mode FROM space_resources WHERE id = NEW.resource_id) = 'exclusive'
     AND EXISTS (SELECT 1 FROM space_bookings b
                 WHERE b.resource_id = NEW.resource_id AND b.status IN ('confirmed','checked_in')
                   AND b.starts_at < NEW.ends_at AND NEW.starts_at < b.ends_at);
  SELECT RAISE(ABORT, 'booking is over capacity for that time')
   WHERE (SELECT booking_mode FROM space_resources WHERE id = NEW.resource_id) = 'shared'
     AND NEW.party_size + (SELECT coalesce(sum(b.party_size), 0) FROM space_bookings b
                 WHERE b.resource_id = NEW.resource_id AND b.status IN ('confirmed','checked_in')
                   AND b.starts_at < NEW.ends_at AND NEW.starts_at < b.ends_at)
         > (SELECT capacity FROM space_resources WHERE id = NEW.resource_id);
  SELECT RAISE(ABORT, 'the hub is closed then')
   WHERE EXISTS (SELECT 1 FROM space_closures c
                 WHERE (c.resource_id IS NULL OR c.resource_id = NEW.resource_id)
                   AND c.starts_at < NEW.ends_at AND NEW.starts_at < c.ends_at);
END;
CREATE TRIGGER trg_space_bookings_rules_update
BEFORE UPDATE OF resource_id, starts_at, ends_at, party_size, status ON space_bookings
WHEN NEW.status IN ('confirmed','checked_in')
BEGIN
  SELECT RAISE(ABORT, 'resource is not bookable')
   WHERE NOT EXISTS (SELECT 1 FROM space_resources WHERE id = NEW.resource_id AND bookable = 1 AND active = 1)
     AND (NEW.resource_id <> OLD.resource_id OR OLD.status NOT IN ('confirmed','checked_in'));
  SELECT RAISE(ABORT, 'party is larger than the room capacity')
   WHERE NEW.party_size > (SELECT capacity FROM space_resources WHERE id = NEW.resource_id);
  SELECT RAISE(ABORT, 'booking overlaps another booking')
   WHERE (SELECT booking_mode FROM space_resources WHERE id = NEW.resource_id) = 'exclusive'
     AND EXISTS (SELECT 1 FROM space_bookings b
                 WHERE b.id <> NEW.id AND b.resource_id = NEW.resource_id AND b.status IN ('confirmed','checked_in')
                   AND b.starts_at < NEW.ends_at AND NEW.starts_at < b.ends_at);
  SELECT RAISE(ABORT, 'booking is over capacity for that time')
   WHERE (SELECT booking_mode FROM space_resources WHERE id = NEW.resource_id) = 'shared'
     AND NEW.party_size + (SELECT coalesce(sum(b.party_size), 0) FROM space_bookings b
                 WHERE b.id <> NEW.id AND b.resource_id = NEW.resource_id AND b.status IN ('confirmed','checked_in')
                   AND b.starts_at < NEW.ends_at AND NEW.starts_at < b.ends_at)
         > (SELECT capacity FROM space_resources WHERE id = NEW.resource_id);
  -- Closures matter only when the time or room moves, or a booking comes back;
  -- a check-in during a closure added later must still work.
  SELECT RAISE(ABORT, 'the hub is closed then')
   WHERE (NEW.resource_id <> OLD.resource_id OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at
          OR OLD.status NOT IN ('confirmed','checked_in'))
     AND EXISTS (SELECT 1 FROM space_closures c
                 WHERE (c.resource_id IS NULL OR c.resource_id = NEW.resource_id)
                   AND c.starts_at < NEW.ends_at AND NEW.starts_at < c.ends_at);
END;

-- Daily check-in: one per member per local day (local_date is America/Toronto).
CREATE TABLE space_checkins (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date     TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  checked_in_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  checked_out_at TEXT,
  booking_id     TEXT REFERENCES space_bookings(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, local_date),
  CHECK (checked_out_at IS NULL OR checked_out_at > checked_in_at)
) WITHOUT ROWID;
CREATE INDEX idx_space_checkins_day ON space_checkins (local_date);

-- Guest passes. The host is responsible; the guest accepts the house rules
-- before entry. The pass code is a bearer secret: HMAC only.
CREATE TABLE guest_passes (
  id                TEXT PRIMARY KEY,
  host_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_first_name  TEXT NOT NULL CHECK (length(trim(guest_first_name)) BETWEEN 1 AND 40),
  guest_last_initial TEXT NOT NULL CHECK (length(guest_last_initial) = 1 AND upper(guest_last_initial) GLOB '[A-Z]'),
  visit_date        TEXT NOT NULL CHECK (visit_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  code_hmac         TEXT NOT NULL UNIQUE CHECK (length(code_hmac) = 64),
  status            TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','checked_in','expired','revoked')),
  house_rules_version TEXT,
  house_rules_accepted_at TEXT,
  checked_in_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  purge_after       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days')),
  CHECK (status <> 'checked_in' OR (house_rules_accepted_at IS NOT NULL AND house_rules_version IS NOT NULL
                                    AND checked_in_at IS NOT NULL))
);
CREATE INDEX idx_guest_passes_host ON guest_passes (host_user_id, visit_date DESC);
CREATE INDEX idx_guest_passes_day ON guest_passes (visit_date, status);
CREATE INDEX idx_guest_passes_purge ON guest_passes (purge_after);
-- A host may hold at most 2 live passes for one day.
CREATE TRIGGER trg_guest_passes_per_day
BEFORE INSERT ON guest_passes
WHEN NEW.status IN ('issued','checked_in') AND (SELECT count(*) FROM guest_passes WHERE host_user_id = NEW.host_user_id
      AND visit_date = NEW.visit_date AND status IN ('issued','checked_in')) >= 2
BEGIN
  SELECT RAISE(ABORT, 'a host can bring at most 2 guests per day');
END;

CREATE TRIGGER trg_guest_passes_per_day_update
BEFORE UPDATE OF status, visit_date, host_user_id ON guest_passes
WHEN NEW.status IN ('issued','checked_in')
 AND (SELECT count(*) FROM guest_passes WHERE id <> NEW.id AND host_user_id = NEW.host_user_id
      AND visit_date = NEW.visit_date AND status IN ('issued','checked_in')) >= 2
BEGIN
  SELECT RAISE(ABORT, 'a host can bring at most 2 guests per day');
END;

-- House info: Wi-Fi, access, accessibility, rules. Edited in Studio.
CREATE TABLE house_info (
  key        TEXT PRIMARY KEY CHECK (key NOT GLOB '*[^a-z0-9_]*'),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  body_md    TEXT NOT NULL CHECK (length(body_md) <= 8000),
  section    TEXT NOT NULL CHECK (section IN ('getting_here','access','accessibility','house_rules','amenities','safety')),
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  sort_order INTEGER NOT NULL DEFAULT 0,
  members_only INTEGER NOT NULL DEFAULT 1 CHECK (members_only IN (0,1)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
