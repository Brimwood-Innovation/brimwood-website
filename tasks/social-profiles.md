# Rich Profiles — research & audit (PROFILES area, social-UX overhaul)

Branch: `audit/social/profiles` (base `audit/social-ux-deep`). Migration number: **0016**.

## Phase 1 — Research: how Instagram / X / Facebook structure rich profiles

Sources: public web research, 2026-10-08.

### Instagram (edit-profile model)
- Edit Profile has dedicated fields: name, username, pronouns, bio, links, profile picture.
- **Pronouns field has a per-field audience toggle: "Show to followers only"** — the
  pattern to steal: audience control lives *next to the field*, not in a global page.
- Gender and birthday live in *personal information settings*, NOT on the public
  profile. Birthday is never displayed by default — sensitive identity data is
  opt-in by design. Gender offers a free-text "custom" option plus "Prefer not to say".
- Everything is optional: you can run an account with nothing filled in.

### Facebook (per-field audience model)
- The About tab is split into sections: Contact & basic info, Places lived,
  Work & education, Life events, Family & relationships.
- **Every single field carries its own audience selector**: Public / Friends /
  Friends except… / Specific friends / Only me. This is the direct ancestor of our
  per-field visibility map.
- Birthday is split: birth *day+month* vs birth *year* have separate visibility —
  granular even within a field.
- "View As" tool lets you preview your profile as a stranger would.

### X (minimal model)
- Name, bio, location, website, birthday (with day/year visibility options), photo.
- Deliberately thin; birthday defaults to "you follow each other".

## Patterns distilled → Brimwood adaptations

| Pattern | Brimwood adaptation |
|---|---|
| Per-field audience selector (FB) | `profile_visibility` JSON map: `public \| members \| only-me` per field. FB's "friends" tier has no analogue (no friend graph) — the trusted tier is **members**. |
| Pronouns' followers-only toggle (IG) | Per-field dropdown next to each edit field, with a short note of who sees what. |
| Birthday never public by default (IG/X) | `dob` and `gender` default to **only-me**, even when the profile is public. |
| "View As" (FB) | Client-side preview panel on the editor: "How members see you" / "How the public sees you", computed from the current visibility selections. No server round-trip, no data risk. |
| Everything optional (IG) | All new fields nullable; empty sections never render on public pages. |
| About sections (FB) | Public page renders clean sections: About, Hobbies, Achievements, Education, Milestones. |
| Calm tone | No counts-as-status (no follower counts), no engagement bait, no downvotes. |

## Phase 2 — Audit: gaps in the current implementation

Read: `api/src/routes/profiles.ts` (+test), `api/migrations/0010_profiles.sql`,
`site/src/pages/members/profile.astro`, `site/src/pages/@[username].astro`,
`site/src/pages/u/[id].astro`, and §19 "Community" of the UX/UI design v3.0.

1. **No per-field privacy.** Visibility is one global switch (`show_profile`) — a member
   who wants a public portfolio must expose location, work history, hobbies, etc. to
   *everyone*. FB/IG both prove per-field control is the expectation.
2. **No date of birth or gender fields.** `0010_profiles.sql` has no `dob`/`gender`;
   the public shape never exposes them (good), but members can't record them either.
3. **Hobbies is free text** (500-char string) — no structure for rendering as chips.
4. **No achievements / life events (milestones).** FB's "Life events" is a core rich-profile
   section; Brimwood has nothing comparable for builder milestones.
5. **Education shape is `{school, degree, period}`** — degree-centric; the founder's brief
   asks for school-vs-college distinction (`{school, kind, years}`).
6. **No avatar component.** Three pages hand-roll `<img style="width:120px;height:120px;border-radius:50%">`
   with no initials fallback — a member without an avatar renders a broken/empty image.
7. **The public endpoint (`GET /users/:id`) is all-or-nothing** — anyone with
   `show_profile=1` exposes the full rich set to anonymous viewers; no middle tier for
   signed-in members vs strangers.
8. **The editor has no preview** — members can't see what others see before saving
   (cf. FB "View As").
9. **Avatar key naming** — `avatar_key` is the R2 key; brief asks for an explicit
   `avatar_r2_key` column. New canonical column, kept in sync with the legacy one.

Out of scope (deliberate): cover photo, pinned post, follow/following counts from the
design-doc "profile v2" mockup — those need feed/follow schema owned by the COMMUNITY
area agent; noted here so nothing is silently dropped.

## Phase 3 — Implementation (this branch)

- `api/migrations/0016_rich_profiles.sql` — additive, nullable columns:
  `dob`, `gender`, `achievements` (JSON), `life_events` (JSON),
  `profile_visibility` (JSON map), `avatar_r2_key`.
- `api/src/routes/profiles.ts` — new `/api/profiles/*` routes with relationship-aware,
  server-side field filtering; visibility-validated `PATCH /profiles/me`;
  avatar upload writing both `avatar_r2_key` and `avatar_key`.
- `site/src/components/Avatar.astro` — round avatar, sm/md/lg/xl sizes, initials
  fallback in brand colours.
- Profile pages re-rendered with clean sections per visibility; editor gains every
  new field + per-field visibility dropdowns + a members/public preview panel.
- Tests: visibility matrix (owner/admin/member/anonymous), leak-proofing
  (dob/gender never reach non-owners), validation of all new fields, avatar upload.

### Relationship model (server-side, the single source of truth)

- **owner** (or admin): everything, including `email`, `dob`, `gender`, the visibility map.
- **member** (signed-in, active): fields whose visibility is `public` or `members`;
  target must be active. No `only-me` fields. Email/real name never.
- **anonymous**: only `public` fields, and only when the target opted in
  (`show_profile=1`) and is active. Otherwise 404 (no enumeration signal).

Defaults: `dob` and `gender` → `only-me`; everything else → `public`
(preserves the pre-0016 public-profile contract for `show_profile=1` users).
