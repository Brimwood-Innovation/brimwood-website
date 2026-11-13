-- 0030_projects.sql: member projects, project members, updates (R2: /hub/projects/SLUG).
--
-- Why: the v5 people area adds a project showcase (SPEC 3.2). Projects are
-- members-only by default. A public page needs every member's opt-in,
-- because public pages never name a member without it (R1, X9).

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 60 AND slug NOT GLOB '*[^a-z0-9-]*'),
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  summary     TEXT NOT NULL CHECK (length(summary) BETWEEN 10 AND 300),
  stage       TEXT NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea','prototype','first_users','launched','paused')),
  visibility  TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('members','public')),
  public_since TEXT,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT,
  CHECK ((visibility = 'public') = (public_since IS NOT NULL))
);
CREATE INDEX idx_projects_owner ON projects (owner_id);
CREATE INDEX idx_projects_list ON projects (visibility, updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE project_members (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  public_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (public_opt_in IN (0,1)),
  joined_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_project_members_user ON project_members (user_id);

-- Going public needs every current member's opt-in.
CREATE TRIGGER trg_projects_public_needs_opt_in
BEFORE UPDATE OF visibility ON projects
WHEN NEW.visibility = 'public' AND EXISTS (
  SELECT 1 FROM project_members WHERE project_id = NEW.id AND public_opt_in = 0)
BEGIN
  SELECT RAISE(ABORT, 'every project member must opt in before the project goes public');
END;
CREATE TRIGGER trg_projects_public_on_insert
BEFORE INSERT ON projects
WHEN NEW.visibility = 'public'
BEGIN
  SELECT RAISE(ABORT, 'create the project as members-only, then opt in to public');
END;
-- A member who opts out makes the project members-only again.
CREATE TRIGGER trg_project_members_opt_out
AFTER UPDATE OF public_opt_in ON project_members
WHEN NEW.public_opt_in = 0
BEGIN
  UPDATE projects SET visibility = 'members', public_since = NULL WHERE id = NEW.project_id;
END;
CREATE TRIGGER trg_project_members_join_public
BEFORE INSERT ON project_members
WHEN NEW.public_opt_in = 0 AND (SELECT visibility FROM projects WHERE id = NEW.project_id) = 'public'
BEGIN
  SELECT RAISE(ABORT, 'a new member of a public project must opt in first');
END;

CREATE TABLE project_updates (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_project_updates_list ON project_updates (project_id, created_at DESC);
CREATE TRIGGER trg_project_updates_member_only
BEFORE INSERT ON project_updates
WHEN NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = NEW.project_id AND user_id = NEW.author_id)
BEGIN
  SELECT RAISE(ABORT, 'only project members post updates');
END;

-- Demo submissions can point at a project.
ALTER TABLE demo_submissions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
