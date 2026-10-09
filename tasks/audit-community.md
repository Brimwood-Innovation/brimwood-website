# Community features audit — built vs designed (section 19)

Date: 2026-10-08. Worktree `audit/community` @ e67ff4e.
Area: `api/src/routes/comments.ts`, `api/src/routes/profiles.ts` (+ tests),
`site/src/pages/members.astro`, `members/profile.astro`, `@[username].astro`, `u/[id].astro`,
`wall.astro`. Reference: `~/workspace/your_files/brimwood-ux-ui-design/index.html` §19 (read-only).

## 1a. Built-vs-designed gap analysis

| Section-19 feature | Status | Evidence |
|---|---|---|
| Feed `/hub/feed` | MISSING | No posts table, no `/api/posts` route, no feed page |
| Composer (text/photo/video/file/poll) + audience selector | MISSING | — |
| Calm 4-reaction set (👍🎉💡🤝) | MISSING | No reactions API or UI |
| Repost vs quote (X semantics) | MISSING | — |
| Threaded comments (2 levels) | MISSING | Blog comments are flat; community post comments don't exist |
| Post detail `/hub/post/[id]` | MISSING | — |
| Groups (create/open/closed/secret, roles, group feed, pinned) | MISSING | — |
| DMs `/hub/messages` (1:1 + group chats, media, read receipts, share-to-DM) | MISSING | — |
| Block / mute | MISSING | — |
| Report post / comment / member | MISSING | No report endpoint; no report UI |
| `/admin/reports` moderation queue | MISSING | Only blog-comment queue exists (see below) |
| Group-level mod tools | MISSING | — |
| Anonymous-by-default identity | BUILT | `show_profile=0` default; public endpoints never return email/real name/DOB; display-name-or-initials fallback |
| Chronological order | PARTIAL | Blog comments `ORDER BY created_at ASC`; no feed exists to order |
| Member profiles (identity core) | PARTIAL | `/users/me` GET/PATCH, avatar upload, username handles, `/@username` + `/u/[id]` prerendered pages, profile editor — all built. Design's profile v2 (cover, pinned post, follow model) missing |
| Blog comments + moderation queue | PARTIAL | POST held `pending`, Turnstile (fails closed), 5/hr IP rate limit, `GET /api/admin/comments` queue + approve/spam PATCH with audit log. Matches "human-reviewed moderation" for blog comments only; no queue UI at `/admin/reports` |
| Members auth shell | BUILT | `/members` sign-in (magic code), gated home; no community features behind it yet |
| Wall of builders | BUILT | `/wall` testimonials, initials + role attribution (Phase B, social-loops section) |
| Round-two (Stories, broadcast channel, polls, calm feed controls, mute words) | MISSING | Explicitly future; not counted as gaps for this pass |

**Counts:** 3 BUILT, 2 PARTIAL, 14 MISSING (of 19 tracked items; round-two items excluded).

Deliberate non-builds (correct): downvotes, voice/video calls, live video, vanish mode —
design rejected these too.

## 1b. Critical pass on what IS built — errors found

### Critical
1. **Revoked public profile stays live (consent violation).** `u/[id].astro` and
   `@[username].astro` are statically prerendered at build time. When a member turns OFF
   "Make my profile public", the static HTML file keeps serving their display name, bio,
   avatar, work/education history until the next site build. `profile-refresh.js`
   re-fetches the profile but on 404 it returns early and leaves the stale content
   visible. "Never expose identity without consent" — revoking consent must take effect.
   **Fixed** (see §3): refresh script now replaces the section with a "profile is private"
   notice when the API no longer returns the profile.

### Major
2. **Blog comments allow impersonation of member display names.** `POST /comments`
   takes a free-form `name`; anyone can comment as "K." next to a real member's
   initials. Mitigated by held-for-moderation + Turnstile + rate limit, and the queue
   API + `comments-tab.js` exist — but there is no `/admin/reports` UI surfacing it.
   Severity: major if unmoderated, minor with active moderation. Recommendation: fold
   pending comments into the planned `/admin/reports` queue (small follow-up; out of
   this area's pages).
3. **Turnstile unconfigured = comments fully broken (fail closed).** `verifyTurnstile`
   rejects when `TURNSTILE_SECRET_KEY` is unset — correct behaviour, but if the secret
   was never set in production, the public comment form can never succeed. Open
   question: confirm the secret is set in the production worker env.

### Minor
4. `members/profile.astro` `esc()` only escaped `<` but is used inside quoted HTML
   attribute values (`value="…"` in `entryRow`) — a quote in work/school titles broke
   out of the attribute (self-XSS only; data renders to the owner's own editor).
   **Fixed**: esc() now escapes `& < > "`.
5. `GET /users/:id` binds the raw (non-lowercased) param for the id match and a
   lowercased copy for the username match — harmless (UUIDs and usernames are
   lowercase-only) but inconsistent. Left as-is; no behaviour change.
6. First username claim sets `username_changed_at`, so a typo'd first username can't
   be fixed for 30 days. UX wart; no change (rule as designed).
7. `GET /users/public` has no rate limit and exposes id+username of all public
   profiles — needed for build-time prerender; low risk. No change.
8. Avatar R2 keys embed the raw user id (`avatars/<user-id>/…`), visible in public OG
   image URLs. Cosmetic; no change.
9. `GET /api/admin/comments` has `LIMIT 100` with no pagination — fine at current
   scale; revisit if comment volume grows.
10. `PATCH /admin/users/:id` lets an admin demote/suspend themselves with no
    confirmation — admin tooling concern, not a vulnerability. No change.

### Verified sound (no action)
- Route ordering: `/users/me`, `/users/public` registered before `/users/:id` — "me"
  and "public" can never be treated as ids.
- Anonymity enforced server-side: public SELECTs exclude email/name/DOB; private and
  nonexistent profiles both 404 (no enumeration); suspended users excluded.
- Avatar upload: auth-required, 5MB cap, MIME allowlist, member-scoped R2 key, old
  object deleted.
- Username rules: format regex, reserved-word list, uniqueness, 30-day anti-squatting.
- Comments: emails stored but never selected publicly; client renderer escapes
  `<`/`>`; Turnstile fails closed; moderation state never revealed to submitters.
- No secrets in any area file (scanned); Canadian spelling clean (matches were CSS
  `text-align:center`).

## 2. Research — smallest shippable improvements

Per the brief: fix bugs in built features first, then only genuinely small gaps.
No new tables/services proposed (full social build stays out of scope).

1. **Privacy self-healing (implemented)** — `profile-refresh.js` degrades a revoked
   profile to a private notice. Workers + Pages only, C$0. Residual risk: edge-cached
   HTML until cache expiry; a rebuild drops the page entirely. Acceptable for now.
2. **Attribute-escape hardening (implemented)** — one-function fix in the profile
   editor.
3. **Not implemented (correctly out of scope):** report flow, `/admin/reports` UI,
   reactions, repost/quote, DMs, groups — each needs new D1 tables + routes + UI;
   none is "genuinely small". Left as gaps with the design spec as the build order.

## 3. Implemented

- `site/public/js/profile-refresh.js`: on non-ok API response, the whole
  `#profileSection` is replaced with a "This profile is private" notice (brand
  styling, Canadian spelling); on ok, all fields now reconcile (clears removed bio,
  hides removed avatar) instead of only filling present values.
- `site/src/pages/members/profile.astro`: `esc()` hardened to `& < > "`.

## 4. Verification

- `npx vitest run` in `api/` — full suite green (236 tests).
- `npx tsc --noEmit` in `api/` — clean.
- `npm run build` in `site/` — clean (pages touched: `members/profile.astro`;
  `profile-refresh.js` is a static asset, no build step).
- Pre-commit scans: no secrets in area files; no new dependencies (C$0, licence
  gates unaffected).
