-- 0012_audit_immutable.sql - audit_log is append-only.
-- No UPDATE or DELETE may ever touch audit rows; the API only INSERTs.
-- Triggers abort the statement with a clear error.
CREATE TRIGGER trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE not allowed');
END;

CREATE TRIGGER trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: DELETE not allowed');
END;
