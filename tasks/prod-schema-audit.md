# F2 — Production D1 schema audit (read-only)

Date: 2026-10-03. Method: Cloudflare D1 REST query API against the
production database. No writes were made; no wrangler migrations were run.

- Account: 0721f0b5175c685d56651e435d9a14dc (Adamsayani@outlook.com's Account)
- Database: brimwood_db_v2 (e8c57b50-ae14-4773-ab9b-08172c6609a6)
- Tool: POST /client/v4/accounts/{id}/d1/database/{db}/query
  (`SELECT name, sql FROM sqlite_master ...`)

## Result

26 tables present: 25 application tables + the `_cf_KV` system table.
The application tables match migrations 0001 through 0008 plus 0009
exactly. No drift, no extra tables, no missing tables.

Migration-by-migration status:

| Migration | File | Remote status | Evidence |
|-----------|------|---------------|----------|
| 0001_init | users, invite_codes | APPLIED | both tables present, users schema matches |
| 0002_blog | authors, categories, tags, posts | APPLIED | all present |
| 0003_academy | courses, modules, lessons, enrollments, lesson_progress | APPLIED | all present |
| 0004_leads | introduction_requests, newsletter_subscribers, email_log, media_assets, audit_log | APPLIED | all present (media_assets is 0004, not 0010) |
| 0005_health | health_checks, kv_meta | APPLIED | both present |
| 0006_comments | comments | APPLIED | present |
| 0007_events | events, event_rsvps | APPLIED | both present |
| 0008_forms | forms, form_fields, form_submissions | APPLIED | all present |
| 0009_passwords | users.password_hash/salt/set_at, password_resets | APPLIED | password columns on users; password_resets schema matches 0009_passwords.sql verbatim (idx_resets_user / idx_resets_token indexes present) |
| 0010_profiles | users.display_name, bio, avatar_key, show_profile, username, ... | NOT APPLIED | none of the 0010 columns exist on users; idx_users_username absent |
| 0011_d1_limits | rate_limits, sessions | NOT APPLIED | neither table exists (still on PR #8, stacked on PR #5) |

## Row counts (F1 acceptance baseline — production, 2026-10-03)

Total rows across application tables: 1651.

users: 1, invite_codes: 1, authors: 0, categories: 0, tags: 0, posts: 0,
courses: 2, modules: 3, lessons: 5, enrollments: 1, lesson_progress: 3,
introduction_requests: 1, newsletter_subscribers: 0, email_log: 7,
media_assets: 0, audit_log: 3, health_checks: 1623, kv_meta: 1,
comments: 0, events: 0, event_rsvps: 0, forms: 0, form_fields: 0,
form_submissions: 0, password_resets: 0.

Note: health_checks (1623 rows) is written by the cron trigger; small
fluctuations there between the before/after snapshots are expected and do
not indicate a cross-environment leak. The F1 acceptance compares all
other tables exactly and health_checks within cron-tick tolerance.

## What this unblocks

- F9 (PR #8): migration 0011 can be applied to the preview database as
  soon as F1 creates it. It must NOT be applied to production until the
  approved deployment sequencing runs.
- Phase D: 0009 being live on production while its code is not on main
  is now independently confirmed (was previously only a commit message
  claim). 0010 remains unapplied, matching the parked Phase D state.
- The audit's schema claims are now verified against the live database.
