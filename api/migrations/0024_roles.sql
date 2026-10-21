-- 0024_roles.sql: staff roles per D5 (admin, editor, moderator, member).
--
-- Why additive: users.role has CHECK (role IN ('admin','member')) from 0001.
-- Widening that CHECK needs a full rebuild of users, and 20+ tables point at
-- users with ON DELETE CASCADE, so a rebuild risks cascade deletes. Instead,
-- staff roles live in user_roles. users.role keeps its meaning: 'admin' is the
-- bootstrap founder flag; everyone else is 'member' there.
-- Effective roles = users.role 'admin' plus live rows here (view below).
-- Group admin is per group and lives in group_members.role (0026).
--
-- Staff must hold a passkey (D1, S5): enforced on grant and on passkey revoke.

CREATE TABLE user_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin','editor','moderator')),
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason     TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  PRIMARY KEY (user_id, role, granted_at)
);
CREATE UNIQUE INDEX idx_user_roles_one_live ON user_roles (user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_roles_role ON user_roles (role) WHERE revoked_at IS NULL;

-- One place for "what roles does this person hold now".
CREATE VIEW user_effective_roles AS
  SELECT id AS user_id, 'admin' AS role FROM users WHERE role = 'admin' AND status = 'active'
  UNION
  SELECT r.user_id, r.role FROM user_roles r JOIN users u ON u.id = r.user_id
   WHERE r.revoked_at IS NULL AND u.status = 'active'
  UNION
  SELECT id, 'member' FROM users WHERE status = 'active';

CREATE TRIGGER trg_user_roles_need_passkey
BEFORE INSERT ON user_roles
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM webauthn_credentials WHERE user_id = NEW.user_id AND revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'staff role requires an active passkey (D1)');
END;

CREATE TRIGGER trg_users_admin_needs_passkey
BEFORE UPDATE OF role ON users
WHEN NEW.role = 'admin' AND OLD.role <> 'admin' AND NOT EXISTS (
  SELECT 1 FROM webauthn_credentials WHERE user_id = NEW.id AND revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'staff role requires an active passkey (D1)');
END;

-- Staff cannot remove their last passkey.
CREATE TRIGGER trg_webauthn_staff_keep_last
BEFORE UPDATE OF revoked_at ON webauthn_credentials
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
 AND (EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.user_id AND revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role = 'admin'))
 AND (SELECT count(*) FROM webauthn_credentials WHERE user_id = NEW.user_id AND revoked_at IS NULL) <= 1
BEGIN
  SELECT RAISE(ABORT, 'staff cannot remove their last passkey');
END;
CREATE TRIGGER trg_webauthn_staff_keep_last_delete
BEFORE DELETE ON webauthn_credentials
WHEN OLD.revoked_at IS NULL
 AND (EXISTS (SELECT 1 FROM user_roles WHERE user_id = OLD.user_id AND revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id AND role = 'admin' AND status = 'active'))
 AND (SELECT count(*) FROM webauthn_credentials WHERE user_id = OLD.user_id AND revoked_at IS NULL) <= 1
BEGIN
  SELECT RAISE(ABORT, 'staff cannot remove their last passkey');
END;

-- Members get 3 invites (L1618). Staff are not limited. Revoked invites
-- give the slot back.
CREATE TRIGGER trg_invite_codes_member_quota
BEFORE INSERT ON invite_codes
WHEN NEW.created_by IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM user_effective_roles
                 WHERE user_id = NEW.created_by AND role IN ('admin','editor','moderator'))
 AND (SELECT count(*) FROM invite_codes WHERE created_by = NEW.created_by AND revoked_at IS NULL) >= 3
BEGIN
  SELECT RAISE(ABORT, 'members can send at most 3 invites');
END;
