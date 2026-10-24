-- 0037_deleted_status.sql: account-deletion marker for the S20 completion job.
--
-- S20 says "set status = 'deleted'", but widening the users.status CHECK
-- needs a full table rebuild, which 0024 explicitly ruled out (100+ tables
-- reference users(id); a rename-based rebuild rewrites every child FK and
-- trigger body on D1, where PRAGMA legacy_alter_table is disabled). Instead
-- the completion job nulls the PII columns, sets status = 'suspended' (so
-- every existing status = 'active' filter keeps excluding the account with
-- no query changes), and stamps deleted_at. A deleted account is therefore
-- status = 'suspended' AND deleted_at IS NOT NULL; staff tooling renders
-- "Deleted" from deleted_at, never from status alone.

ALTER TABLE users ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;
