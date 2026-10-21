# Stories area — research, findings, and the chat-system contract

Branch: `audit/social/stories` (from `audit/social-ux-deep`).
Status: schema 0018 + API + UI shipped; tests green; **not merged** (per instructions).

## 1. Research (Instagram / Facebook / X stories)

Sources: Instagram feature teardowns and story-viewer guides (Oct 2026),
the system-design literature on ephemeral content, and the v3.0 UX design
mock (`~/workspace/your_files/brimwood-ux-ui-design/index.html`, §19).

- **24h ephemeral lifecycle.** Stories expire 24 hours after posting. The
  system-design guidance is to treat expiry as a *property of the row*
  (`expires_at`), not as a batch job someone must remember to run — a
  once-a-night sweep silently stretches "24 hours" into "24–36 hours".
  Brimwood follows this: every read filters on `expires_at > now`, so
  expiry is exact even if cleanup never runs.
- **Tray UI.** Top-of-feed horizontal tray of round avatars; a coloured
  (gradient/emerald) ring means unseen stories, grey means all seen. The
  §19 mock already specifies this for Brimwood:
  `.story .ring{background:conic-gradient(var(--emerald),var(--signal),var(--emerald))}`
  and `.ring.seen{background:var(--line)}`. Own stories ("You") sit first.
- **Progress segments.** Thin bars across the top of the viewer, one per
  story, filling as each plays; tap/‹ › to move; ✕ or swipe to close.
- **Viewer list.** Instagram shows the story owner who viewed — a list the
  owner alone can see (swipe-up; named list kept ~48h there). Ordering on
  big platforms drifts into engagement-ranking folklore; Brimwood stays
  calm and honest: most-recent-first, no ranking.
- **Replies route to DMs.** A story reply is *not* a public comment — it
  lands in the author's inbox as a direct message, shown with the story
  attached ("x replied to your story"). The §19 mock caption says it
  plainly: "Stories expire in 24h · replies land as DMs".
- **Highlights (deliberately deferred).** Instagram keeps expired stories in
  Highlights/Archive. The §19 caption mentions "demo-night highlights
  auto-save" — that is *not* built in this area. Stories simply disappear;
  highlights are a named follow-up, not silent scope creep.

## 2. Findings → Brimwood adaptations

| Platform behaviour | Brimwood decision |
|---|---|
| Algorithmic tray ranking | Chronological, self-first. Calm over engagement. |
| Viewer list ranked by "interest" | Most-recent-first, author-only. No stalker-meter folklore. |
| Screenshots/replays tracked | Not tracked, full stop. Views are one row per (story, viewer). |
| Replies = DMs | Replies stored in `story_replies`; the chat system surfaces them to the author (contract below). |
| Highlights archive | Deferred — stories vanish after 24h. |
| Public stories | Members-only (401 without a session). Anonymous-by-default: author labels are `display_name` else initials (`K.`); emails and real names never leave the API. |
| SVG/sticker uploads | SVG excluded from story uploads — a story SVG could carry scripts. Photos: PNG/JPG/WEBP/GIF. Video: MP4. 10 MB cap, 10 uploads/user/day, 60 replies/user/day. |
| Expired-story oracle | `GET /api/stories/:id` returns 404 for expired *and* unknown ids — no way to probe whether a story id ever existed. |

## 3. What shipped (this branch)

- `api/migrations/0018_stories.sql` — `stories` (id, author_id, r2_key,
  kind photo|video, created_at, expires_at), `story_views`
  (story_id, viewer_id, viewed_at; composite PK = one view per viewer),
  `story_replies` (id, story_id, from_user_id, body, created_at). Lazy
  expiry everywhere; cleanup documented as a future cron
  (`pruneStories` alongside `pruneSessions`, in `api/src/cron.ts`).
- `api/src/routes/stories.ts` — POST /api/stories (multipart upload to R2
  `brimwood-media`, `story-<uuid>.<ext>` keys), GET /api/stories/tray
  (grouped by author, self first, seen/unseen per requester),
  GET /api/stories/:id (marks viewed via INSERT OR IGNORE; viewer list
  author-only), POST /api/stories/:id/reply (1–500 chars). All
  members-only. Registered in `api/src/index.ts` at `/api/stories`.
- `api/src/routes/stories.test.ts` — 21 tests: auth gates, upload
  validation (type/size/SVG), 24h `expires_at`, rate limits, tray
  grouping + seen flags + lazy expiry, view marking, author-only viewer
  list, reply validation + storage.
- `site/src/components/StoriesTray.astro` — tray (round avatars, emerald
  ring = unseen, grey = seen, "You" tile with upload), viewer modal
  (progress segments, ‹ ›/Esc/arrows, close, viewer count + list for the
  author, reply input). Mounted on the members home page; the feed area
  can move `<StoriesTray />` to `/hub/feed` — it is self-contained.
- Media serving reuses the existing `GET /api/media/:key` endpoint; the
  tray returns full URLs, no new serving code.

## 4. CONTRACT FOR THE CHAT AGENT (DM system)

**`story_replies` rows are conversation starters the chat system MUST
surface to the story author.** The stories area stores replies; it does
not deliver them.

Table: `story_replies`

| Column | Type | Semantics |
|---|---|---|
| `id` | TEXT (uuid) | Reply id. |
| `story_id` | TEXT | FK → `stories.id`. The story that was replied to (may since have expired — the chat system should still show the reply; join defensively). |
| `from_user_id` | TEXT | FK → `users.id`. Who wrote the reply. Render with the same anonymous-by-default label as profiles (`display_name`, else initials). |
| `body` | TEXT | 1–500 chars, already trimmed server-side. |
| `created_at` | TEXT | ISO-8601 UTC (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`). |

Semantics:
- One row = one DM-worthy event for the **story's author** (`stories.author_id`).
  Nobody else sees it — stories have no public comment thread.
- Suggested surfacing: a DM thread between `from_user_id` and the author,
  opened (or bumped) with the reply body quoted against the story's media
  (`stories.r2_key` → `GET /api/media/:key`). The author never asked for
  these DMs, so message-request/consent rules still apply per the chat
  area's design — but the row itself is the signal to act on.
- Replies keep arriving after the story expires (24h). Expiry hides the
  *story*, never the reply: `story_replies` has no expiry. Do not join
  with an `expires_at > now` filter when surfacing replies.
- Idempotency: poll/process by `story_replies.id` (or `created_at`
  watermark). The same reply must not notify twice.
- Deletion cascades: deleting a story deletes its replies
  (`ON DELETE CASCADE`). Deleting a user deletes their replies.
- If the chat system wants a "replied to your story" preview it can fetch
  the story row, but must tolerate a missing story (expired + pruned).

Related tables (read-only for chat): `stories(id, author_id, r2_key,
kind, created_at, expires_at)`, `story_views` (author-only analytics;
not needed for DMs).

## 5. Deliberately left out (with reasons)

- **Highlights / archive** — named in the §19 caption but a separate
  feature; stories vanishing cleanly is the v1 promise.
- **Polls/questions/stickers in stories** — interactive layers need UI +
  federation-style support; out of scope for the area brief.
- **Hold-to-pause, tap zones, story likes/reactions** — calm scope; ‹ ›
  navigation and auto-advance cover v1.
- **Push/email notification on reply** — the chat area owns notification
  policy (quiet hours, per-thread controls); stories only store the row.
- **Cron hard-delete of expired stories** — documented in 0018 with a
  suggested `pruneStories`; expiry correctness does not depend on it, and
  cron changes are a separately reviewable unit.
- **Turnstile on upload/reply** — member session + per-user D1 rate limits
  (10 uploads/day, 60 replies/day) are the established member-endpoint
  pattern; Turnstile is for public/anonymous endpoints.
