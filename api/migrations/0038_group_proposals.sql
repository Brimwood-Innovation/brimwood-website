-- 0038_group_proposals.sql: co-founder endorsements for proposed groups.
--
-- Why: proposing a new group needs three co-founders plus admin approval
-- (the recorded Phase 3 follow-up). The groups table already carries the
-- proposal itself (status 'proposed', proposed_by, approved_by,
-- approved_at from 0026); what was missing was the endorsement store.
-- One row per supporter per proposal. The proposer is supporter one at
-- creation; two more distinct members endorse before staff can approve.
-- Supporter rows are kept after approval or rejection, so the proposal
-- history stays auditable. No group member count is ever exposed: the API
-- returns only the supporter count and the caller's own flags.

CREATE TABLE group_proposal_supporters (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_group_proposal_supporters_user ON group_proposal_supporters (user_id);
