-- 0023_auth.sql: sign-in per D1 (passkey first, email code fallback), invite-only per D2.
--
-- Why: today email codes live in KV, there is no passkey table, no recovery
-- codes, sessions carry no factor or device data, and any caller of
-- INSERT INTO users can create a member without an invite (audit 06 P0-1, P0-2).
-- Secrets: every code and token is stored as a hash. Short codes (6 digits,
-- recovery codes) use HMAC-SHA256 with a Worker-held pepper (S4, S9); a plain
-- hash of a 6-digit code reverses in milliseconds.
-- Time columns use the repo ISO-8601 UTC text form, except sessions, which
-- already store epoch milliseconds (0011); new sessions columns follow that.

-- Email one-time codes (S4). One live code per (email, purpose): a fresh code
-- supersedes the old one. attempts is capped at 5 by CHECK, so the atomic
-- "UPDATE ... SET attempts = attempts + 1 ... AND attempts < 5" cannot overrun.
CREATE TABLE auth_email_codes (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL COLLATE NOCASE CHECK (email = lower(email) AND instr(email, '@') > 1),
  user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose          TEXT NOT NULL CHECK (purpose IN ('sign_in','step_up','invite_redeem','delete_account','lockdown','recovery')),
  code_hmac        TEXT NOT NULL CHECK (length(code_hmac) = 64),
  browser_binding_hash TEXT NOT NULL CHECK (length(browser_binding_hash) = 64),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at       TEXT NOT NULL,
  consumed_at      TEXT,
  superseded_at    TEXT,
  ip_hmac          TEXT,
  -- 10-minute life (L780, L913).
  CHECK ((julianday(expires_at) - julianday(created_at)) * 86400 BETWEEN 1 AND 600.5),
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);
CREATE UNIQUE INDEX idx_auth_codes_one_live ON auth_email_codes (email, purpose)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
-- Rate check: codes sent to one address in the last hour.
CREATE INDEX idx_auth_codes_rate ON auth_email_codes (email, created_at);
CREATE INDEX idx_auth_codes_purge ON auth_email_codes (created_at);

-- WebAuthn credentials (S8). credential_id is base64url text, like every other id.
CREATE TABLE webauthn_credentials (
  credential_id   TEXT PRIMARY KEY CHECK (length(credential_id) BETWEEN 16 AND 1400 AND credential_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rp_id           TEXT NOT NULL DEFAULT 'brimwoodinnovation.com' CHECK (rp_id = 'brimwoodinnovation.com'),
  public_key      BLOB NOT NULL,
  sign_count      INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  aaguid          TEXT,
  transports      TEXT CHECK (transports IS NULL OR json_valid(transports)),
  backup_eligible INTEGER NOT NULL DEFAULT 0 CHECK (backup_eligible IN (0,1)),
  backup_state    INTEGER NOT NULL DEFAULT 0 CHECK (backup_state IN (0,1)),
  nickname        TEXT CHECK (nickname IS NULL OR length(nickname) <= 60),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at    TEXT,
  revoked_at      TEXT
);
CREATE INDEX idx_webauthn_user_live ON webauthn_credentials (user_id) WHERE revoked_at IS NULL;

-- Random 32-byte WebAuthn user handle, never the email (P2-6). Separate table
-- so we do not widen users (D1 limit: 100 columns per table).
CREATE TABLE webauthn_user_handles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  user_handle BLOB NOT NULL UNIQUE CHECK (length(user_handle) = 32)
);

-- One-time challenges, 5-minute life (S8).
CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL UNIQUE,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('register','authenticate')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  CHECK ((julianday(expires_at) - julianday(created_at)) * 86400 BETWEEN 1 AND 300.5)
);
CREATE INDEX idx_webauthn_challenges_purge ON webauthn_challenges (expires_at);

-- Recovery codes (D1: 10 one-time codes). HMAC only. A trigger caps live codes at 10.
CREATE TABLE recovery_codes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hmac  TEXT NOT NULL CHECK (length(code_hmac) = 64),
  batch_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  used_at    TEXT,
  revoked_at TEXT,
  PRIMARY KEY (user_id, code_hmac)
);
CREATE TRIGGER trg_recovery_codes_max_10
BEFORE INSERT ON recovery_codes
WHEN (SELECT count(*) FROM recovery_codes
      WHERE user_id = NEW.user_id AND used_at IS NULL AND revoked_at IS NULL) >= 10
BEGIN
  SELECT RAISE(ABORT, 'a member holds at most 10 live recovery codes');
END;

-- Devices for the trusted-device list and new-device alerts (S7). No raw IP.
CREATE TABLE devices (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_cookie_hash TEXT NOT NULL UNIQUE CHECK (length(device_cookie_hash) = 64),
  label              TEXT CHECK (label IS NULL OR length(label) <= 80),
  city               TEXT,
  first_seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  trusted_until      TEXT,
  revoked_at         TEXT
);
CREATE INDEX idx_devices_user ON devices (user_id, last_seen_at DESC);

-- Sessions (S6): add factors used and device info. Nullable or defaulted so the
-- current 5-column INSERT in api/src/lib/auth.ts keeps working.
-- amr: JSON array of factors used, for example ["passkey"] or ["email_code"].
ALTER TABLE sessions ADD COLUMN amr TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(amr) AND json_type(amr) = 'array');
ALTER TABLE sessions ADD COLUMN auth_time INTEGER;            -- epoch ms of the last real sign-in; step-up uses it
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;         -- epoch ms of the last request, for "last active"
ALTER TABLE sessions ADD COLUMN device_id TEXT REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN ua_summary TEXT;              -- "iPhone, Safari"; never the full UA string
ALTER TABLE sessions ADD COLUMN city TEXT;                    -- from request.cf.city; no raw IP
ALTER TABLE sessions ADD COLUMN is_staff INTEGER NOT NULL DEFAULT 0 CHECK (is_staff IN (0,1));
ALTER TABLE sessions ADD COLUMN revoked_at INTEGER;           -- epoch ms; set with revoked_reason
ALTER TABLE sessions ADD COLUMN revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN
  ('sign_out','sign_out_all','passkey_change','email_change','lockdown','suspension','deletion','role_change','admin'));
CREATE TRIGGER trg_sessions_revoke_pair
BEFORE UPDATE OF revoked_at, revoked_reason ON sessions
WHEN (NEW.revoked_at IS NULL) <> (NEW.revoked_reason IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'revoked_at and revoked_reason are set together');
END;
-- Staff sessions live at most 12 hours (P1-7). Times here are epoch ms.
CREATE TRIGGER trg_sessions_staff_ttl
BEFORE INSERT ON sessions
WHEN NEW.is_staff = 1 AND NEW.expires_at - NEW.created_at > 43200000
BEGIN
  SELECT RAISE(ABORT, 'staff sessions expire within 12 hours');
END;

-- Member security trail (S11), shown under "Recent activity". Append-only.
CREATE TABLE security_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('sign_in','sign_in_failed','code_sent','code_locked',
                'passkey_added','passkey_removed','recovery_codes_created','recovery_code_used',
                'session_revoked','sign_out_all','new_device','lockdown','email_changed',
                'export_requested','export_downloaded','deletion_requested','deletion_cancelled')),
  amr         TEXT CHECK (amr IS NULL OR json_valid(amr)),
  device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
  city        TEXT,
  ua_summary  TEXT,
  ip_hmac     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  purge_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+396 days'))  -- 13 months (S24)
);
CREATE INDEX idx_security_events_user ON security_events (user_id, created_at DESC);
CREATE INDEX idx_security_events_purge ON security_events (purge_after);
CREATE TRIGGER trg_security_events_no_update
BEFORE UPDATE ON security_events
BEGIN
  SELECT RAISE(ABORT, 'security_events is append-only');
END;
-- DELETE stays allowed: the retention purge and account deletion need it.

-- Exact account-level locks (S25). IP limits stay in rate_limits (0011).
CREATE TABLE account_locks (
  subject      TEXT PRIMARY KEY,           -- user id or email HMAC
  locked_until TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('code_failures','code_sends','lockdown','admin')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID;

-- D1 (decision): passwords only for accounts that already have one. No new
-- password at sign-up, and no first password for a passwordless account.
CREATE TRIGGER trg_users_no_password_at_signup
BEFORE INSERT ON users
WHEN NEW.password_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'passwords are not offered at sign-up (D1)');
END;
CREATE TRIGGER trg_users_no_new_password
BEFORE UPDATE OF password_hash ON users
WHEN OLD.password_hash IS NULL AND NEW.password_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'only accounts that already have a password may change it (D1)');
END;

-- Invite-only (D2, S1, S2).
-- invite_codes.code: the API stores HMAC-SHA256(code) here from now on, never
-- the plain code (S2). The column stays; only the value changes.
-- email binds an invite to one address (S2). Nullable for rows made before 0023.
ALTER TABLE invite_codes ADD COLUMN email TEXT CHECK (email IS NULL OR email = lower(email));
ALTER TABLE invite_codes ADD COLUMN intro_request_id TEXT REFERENCES introduction_requests(id) ON DELETE SET NULL;
ALTER TABLE invite_codes ADD COLUMN revoked_at TEXT;
ALTER TABLE invite_codes ADD COLUMN revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_invite_codes_creator ON invite_codes (created_by, created_at);
-- One open, email-bound invite per address.
CREATE UNIQUE INDEX idx_invite_codes_open_email ON invite_codes (email)
  WHERE email IS NOT NULL AND revoked_at IS NULL AND uses < max_uses;

-- One row per redemption. Written first, with user_id NULL; the new user row
-- then claims it by email (trigger below). This order works in a D1 batch
-- (one transaction) and also statement by statement, so no deferred key is needed.
CREATE TABLE invite_redemptions (
  id             TEXT PRIMARY KEY,
  invite_code_id TEXT NOT NULL REFERENCES invite_codes(id),
  user_id        TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL CHECK (email = lower(email) AND instr(email, '@') > 1),
  redeemed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_invite_redemptions_invite ON invite_redemptions (invite_code_id);
-- At most one unclaimed redemption per address.
CREATE UNIQUE INDEX idx_invite_redemptions_unclaimed ON invite_redemptions (email) WHERE user_id IS NULL;

-- The redemption itself checks the invite and consumes one use atomically.
CREATE TRIGGER trg_invite_redemption_valid
BEFORE INSERT ON invite_redemptions
WHEN NEW.user_id IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM invite_codes i
  WHERE i.id = NEW.invite_code_id
    AND i.revoked_at IS NULL
    AND i.uses < i.max_uses
    AND (i.expires_at IS NULL OR i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND (i.email IS NULL OR i.email = NEW.email))
BEGIN
  SELECT RAISE(ABORT, 'invite is not valid for this email');
END;
CREATE TRIGGER trg_invite_redemption_consume
AFTER INSERT ON invite_redemptions
BEGIN
  UPDATE invite_codes SET uses = uses + 1 WHERE id = NEW.invite_code_id;
END;
CREATE TRIGGER trg_invite_redemption_claim_once
BEFORE UPDATE OF user_id, email, invite_code_id ON invite_redemptions
WHEN OLD.user_id IS NOT NULL OR NEW.email <> OLD.email OR NEW.invite_code_id <> OLD.invite_code_id
BEGIN
  SELECT RAISE(ABORT, 'a redemption is claimed once and never changes');
END;

-- Every NEW user needs an unclaimed redemption for the same email.
-- Rows that exist today predate this rule; the trigger only fires on INSERT.
-- One exception (S1): the very first admin, while no admin exists yet
-- (bootstrap). After that, an admin also joins by invite and is then promoted,
-- which needs a passkey (0024). The bootstrap admin cannot hold a passkey
-- before the user row exists, so the founder adds one right after (README).
CREATE TRIGGER trg_users_invite_only
BEFORE INSERT ON users
WHEN NOT (NEW.role = 'admin' AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin'))
 AND NOT EXISTS (
  SELECT 1 FROM invite_redemptions r WHERE r.email = lower(NEW.email) AND r.user_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invite-only: a new member needs a redeemed invite (D2)');
END;
CREATE TRIGGER trg_users_claim_redemption
AFTER INSERT ON users
BEGIN
  UPDATE invite_redemptions SET user_id = NEW.id WHERE email = lower(NEW.email) AND user_id IS NULL;
END;

-- Revoke, never delete (S2, P1-2 of review R3). A redeemed invite is history:
-- the redemption row points at it. Revoking needs who did it.
CREATE TRIGGER trg_invite_codes_no_delete_after_use
BEFORE DELETE ON invite_codes
WHEN EXISTS (SELECT 1 FROM invite_redemptions WHERE invite_code_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'a used invite cannot be deleted; set revoked_at and revoked_by instead');
END;
CREATE TRIGGER trg_invite_codes_revoke_pair
BEFORE UPDATE OF revoked_at, revoked_by ON invite_codes
WHEN NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'revoking an invite needs revoked_by');
END;
