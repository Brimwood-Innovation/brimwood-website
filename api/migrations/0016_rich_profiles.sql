-- 0016_rich_profiles.sql — rich profiles: personal fields + per-field visibility
-- (profiles area, social-UX overhaul).
--
-- dob: ISO date string (YYYY-MM-DD), nullable. API validates format and
--   rejects future dates. Default visibility: only-me.
-- gender: free text (<= 60 chars in API), nullable. Default visibility: only-me.
-- achievements: JSON list of {title, date, description}, nullable.
-- life_events: JSON list of {title, date, description} (milestones), nullable.
-- profile_visibility: JSON map of field -> "public" | "members" | "only-me",
--   nullable. Defaults are enforced in the API (dob/gender -> only-me, all
--   other fields -> public, preserving the pre-0016 public-profile contract).
-- avatar_r2_key: canonical R2 object key for the avatar in brimwood-media.
--   Kept in sync with avatar_key (0010) by the API; reads prefer it.
--
-- Brand rule: members are anonymous by default; the API must never leak
-- only-me fields to other viewers. All filtering happens server-side.
--
-- Additive and nullable: safe to apply on preview/prod via wrangler.

ALTER TABLE users ADD COLUMN dob TEXT;
ALTER TABLE users ADD COLUMN gender TEXT;
ALTER TABLE users ADD COLUMN achievements TEXT;
ALTER TABLE users ADD COLUMN life_events TEXT;
ALTER TABLE users ADD COLUMN profile_visibility TEXT;
ALTER TABLE users ADD COLUMN avatar_r2_key TEXT;
