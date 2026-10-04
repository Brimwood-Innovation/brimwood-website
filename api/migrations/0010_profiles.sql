-- 0010_profiles.sql — user profiles (Phase D2, extended with founder additions)
-- display_name: user-controlled public name; NULL → derived from initials (e.g. "J.")
-- bio: free text, max 500 chars enforced in API
-- avatar_key: R2 object key in brimwood-media (member-scoped uploads)
-- show_profile: 0 = private (default, anonymous), 1 = public opt-in
-- username: public handle, UNIQUE, nullable; 3-30 chars [a-z0-9_], starts with letter
-- username_changed_at: enforces the 1-change-per-30-days anti-squatting rule
-- location/website/hobbies: free text, nullable
-- social_links/work_history/education: JSON text, nullable, validated in API
-- Brand rule: members are anonymous by default; public endpoints must never
-- expose email, real name, or date of birth.

ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN show_profile INTEGER NOT NULL DEFAULT 0
  CHECK (show_profile IN (0, 1));
ALTER TABLE users ADD COLUMN username TEXT;
-- Separate unique index (SQLite can't ADD COLUMN with inline UNIQUE).
-- NULLs are not considered equal, so multiple NULL usernames are fine.
CREATE UNIQUE INDEX idx_users_username ON users(username);
ALTER TABLE users ADD COLUMN username_changed_at TEXT;
ALTER TABLE users ADD COLUMN location TEXT;
ALTER TABLE users ADD COLUMN website TEXT;
ALTER TABLE users ADD COLUMN social_links TEXT;
ALTER TABLE users ADD COLUMN work_history TEXT;
ALTER TABLE users ADD COLUMN education TEXT;
ALTER TABLE users ADD COLUMN hobbies TEXT;
