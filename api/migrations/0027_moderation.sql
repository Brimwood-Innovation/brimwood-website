-- 0027_moderation.sql: rules, reports, sanctions ladder, content actions, appeals.
--
-- Why: the safety centre promises a written rule for every action, a ladder
-- of sanctions (warn, restrict 7 days, suspend 30 days, remove; L2066), and
-- appeals that go to a different reviewer (D5, S15, P1-12). Sanctions must
-- stop writes in the database, not only in the UI (S14).

-- Rule text is versioned (C27): a report and a sanction name the exact version.
CREATE TABLE community_rules (
  id         TEXT PRIMARY KEY,
  number     INTEGER NOT NULL CHECK (number BETWEEN 1 AND 20),
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 10 AND 2000),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (number, version)
);
CREATE UNIQUE INDEX idx_community_rules_one_active ON community_rules (number) WHERE active = 1;

-- Reporter identity never goes into member-facing notices (L2067).
CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','message','profile','story','group','project')),
  target_id   TEXT NOT NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  rule_id     TEXT NOT NULL REFERENCES community_rules(id),
  note        TEXT CHECK (note IS NULL OR length(note) <= 1000),
  content_quote TEXT CHECK (content_quote IS NULL OR length(content_quote) <= 4000),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK (decided_by IS NULL OR reporter_id IS NULL OR decided_by <> reporter_id)
);
CREATE UNIQUE INDEX idx_reports_one_per_reporter ON reports (reporter_id, target_type, target_id)
  WHERE reporter_id IS NOT NULL;
-- Moderation queue, oldest first (48-hour SLA).
CREATE INDEX idx_reports_queue ON reports (status, created_at);
CREATE INDEX idx_reports_target ON reports (target_type, target_id);

-- Sanctions ladder. step: 1 warn, 2 restrict (7 days), 3 suspend (30 days), 4 remove.
CREATE TABLE sanctions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level        TEXT NOT NULL CHECK (level IN ('warn','restrict','suspend','remove')),
  step         INTEGER NOT NULL CHECK (step = CASE level WHEN 'warn' THEN 1 WHEN 'restrict' THEN 2
                                                       WHEN 'suspend' THEN 3 ELSE 4 END),
  rule_id      TEXT NOT NULL REFERENCES community_rules(id),
  report_id    TEXT REFERENCES reports(id) ON DELETE SET NULL,
  content_quote TEXT CHECK (content_quote IS NULL OR length(content_quote) <= 4000),
  reason       TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  issued_by    TEXT NOT NULL REFERENCES users(id),
  issued_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  starts_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ends_at      TEXT,
  notice_sent_at TEXT,
  lifted_at    TEXT,
  lifted_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  lifted_reason TEXT,
  CHECK (issued_by <> user_id),
  CHECK (level <> 'restrict' OR abs((julianday(ends_at) - julianday(starts_at)) - 7) < 0.001),
  CHECK (level <> 'suspend'  OR abs((julianday(ends_at) - julianday(starts_at)) - 30) < 0.001),
  CHECK (level NOT IN ('warn','remove') OR ends_at IS NULL),
  CHECK (lifted_at IS NULL OR coalesce(length(trim(lifted_reason)), 0) > 0)
);
CREATE INDEX idx_sanctions_user ON sanctions (user_id, issued_at DESC);
CREATE INDEX idx_sanctions_active ON sanctions (user_id, level, ends_at) WHERE lifted_at IS NULL;
CREATE TRIGGER trg_sanctions_moderator_only
BEFORE INSERT ON sanctions
WHEN NOT EXISTS (SELECT 1 FROM user_effective_roles WHERE user_id = NEW.issued_by AND role IN ('admin','moderator'))
BEGIN
  SELECT RAISE(ABORT, 'only moderators issue sanctions');
END;

-- Who may not write right now. One view, used by the write gates below.
CREATE VIEW active_write_bans AS
  SELECT user_id FROM sanctions
   WHERE lifted_at IS NULL AND level IN ('restrict','suspend','remove')
     AND starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND (ends_at IS NULL OR ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TRIGGER trg_gate_feed_posts BEFORE INSERT ON feed_posts
WHEN EXISTS (SELECT 1 FROM active_write_bans WHERE user_id = NEW.author_id)
BEGIN SELECT RAISE(ABORT, 'posting is paused for this member'); END;
CREATE TRIGGER trg_gate_feed_comments BEFORE INSERT ON feed_comments
WHEN EXISTS (SELECT 1 FROM active_write_bans WHERE user_id = NEW.author_id)
BEGIN SELECT RAISE(ABORT, 'posting is paused for this member'); END;
CREATE TRIGGER trg_gate_messages BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM active_write_bans WHERE user_id = NEW.sender_id)
BEGIN SELECT RAISE(ABORT, 'posting is paused for this member'); END;
CREATE TRIGGER trg_gate_post_reactions BEFORE INSERT ON post_reactions
WHEN EXISTS (SELECT 1 FROM active_write_bans WHERE user_id = NEW.member_id)
BEGIN SELECT RAISE(ABORT, 'posting is paused for this member'); END;
CREATE TRIGGER trg_gate_stories BEFORE INSERT ON stories
WHEN EXISTS (SELECT 1 FROM active_write_bans WHERE user_id = NEW.author_id)
BEGIN SELECT RAISE(ABORT, 'posting is paused for this member'); END;

-- Content actions by moderators. A moderator edit keeps the original text
-- (P1-12) and needs a reason.
CREATE TABLE moderation_actions (
  id            TEXT PRIMARY KEY,
  action        TEXT NOT NULL CHECK (action IN ('hide','remove','restore','release_hold','edit')),
  target_type   TEXT NOT NULL CHECK (target_type IN ('post','comment','message','story','group','project')),
  target_id     TEXT NOT NULL,
  report_id     TEXT REFERENCES reports(id) ON DELETE SET NULL,
  rule_id       TEXT REFERENCES community_rules(id),
  actor_id      TEXT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  original_text TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (action <> 'edit' OR original_text IS NOT NULL),
  CHECK (action NOT IN ('hide','remove') OR rule_id IS NOT NULL)
);
CREATE INDEX idx_moderation_actions_target ON moderation_actions (target_type, target_id, created_at);
CREATE TRIGGER trg_moderation_actions_append_only
BEFORE UPDATE ON moderation_actions
BEGIN SELECT RAISE(ABORT, 'moderation_actions is append-only'); END;

-- Appeals (S15). outcome uses plain words (C21): the decision stands, or not.
CREATE TABLE appeals (
  id           TEXT PRIMARY KEY,
  sanction_id  TEXT NOT NULL UNIQUE REFERENCES sanctions(id) ON DELETE CASCADE,
  appellant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement    TEXT NOT NULL CHECK (length(trim(statement)) BETWEEN 1 AND 2000),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  due_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+48 hours')),
  reviewer_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  outcome      TEXT CHECK (outcome IS NULL OR outcome IN ('decision_stands','overturned','reduced')),
  decision_note TEXT,
  decided_at   TEXT,
  CHECK (reviewer_id IS NULL OR reviewer_id <> appellant_id),
  CHECK ((outcome IS NULL) = (decided_at IS NULL)),
  CHECK (outcome IS NULL OR reviewer_id IS NOT NULL)
);
CREATE INDEX idx_appeals_open ON appeals (due_at) WHERE outcome IS NULL;
-- The reviewer must differ from the moderator who issued the sanction, and
-- the appellant must be the sanctioned member. CHECK cannot read another
-- table, so triggers do it on insert and on update.
CREATE TRIGGER trg_appeals_rules_insert
BEFORE INSERT ON appeals
WHEN NEW.appellant_id <> (SELECT user_id FROM sanctions WHERE id = NEW.sanction_id)
  OR NEW.reviewer_id = (SELECT issued_by FROM sanctions WHERE id = NEW.sanction_id)
  OR (NEW.reviewer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM user_effective_roles WHERE user_id = NEW.reviewer_id AND role IN ('admin','moderator')))
BEGIN
  SELECT RAISE(ABORT, 'appeal reviewer must be a moderator other than the original one');
END;
CREATE TRIGGER trg_appeals_rules_update
BEFORE UPDATE OF reviewer_id, outcome ON appeals
WHEN NEW.reviewer_id = (SELECT issued_by FROM sanctions WHERE id = NEW.sanction_id)
  OR (NEW.reviewer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM user_effective_roles WHERE user_id = NEW.reviewer_id AND role IN ('admin','moderator')))
BEGIN
  SELECT RAISE(ABORT, 'appeal reviewer must be a moderator other than the original one');
END;
