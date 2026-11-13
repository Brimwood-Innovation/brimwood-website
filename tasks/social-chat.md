# Social chat — research + audit + implementation notes
Branch: `audit/social/chat` (from `audit/social-ux-deep`), 2026-10-08.

## 1. Research: what makes WhatsApp / Messenger / Instagram DMs feel clean

Sources: browser research (Medium chat-UI rules, UXCel chat best practices,
WhatsApp inbox rebuild notes, Bizzmark in-app messaging guide).

**Conversation list** — WhatsApp/Messenger grammar:
- Each row carries exactly five things: avatar, name, last-message preview,
  relative timestamp, unread signal. Nothing else. The two-second glance test:
  which conversation needs attention, who it is from, roughly what it is about.
- Unread reads from the coloured timestamp + a single count pill — no accent
  bars, no row tint. Full-bleed rows divided by hairline dividers inset past
  the avatar.
- Search sits at the very top; chats sort strictly by latest activity.
- Messenger/Instagram inbox adds "seen states" in the list itself, and group
  chats show the last sender's name inside the preview.

**Thread** — the calm timeline:
- Bubbles small radius (~7–8px) with a tail only on the first of a run;
  consecutive messages collapse so the eye sees runs, not rectangles.
- Day dividers ("Today", "Yesterday", date) group messages; the thread canvas
  is narrower than the screen for comfortable reading.
- Composer stays anchored to the bottom; media opens deliberately and never
  hijacks the timeline.
- Read receipts are one quiet cue: WhatsApp double-tick, Instagram "Seen",
  group chats show small reader avatars under the newest message. Instagram
  keeps receipts reciprocal and quiet — Brimwood does the same (derived from
  `last_read_at`, nothing extra to configure).

**Group chats**:
- Title + member count in the header; member list with admin badges;
  message preview prefixes the sender's name; coloured names rather than
  coloured bubbles keep groups readable.

**Guardrails for a community app** (Bizzmark guide): permissions on who can
start a chat, caps on unaccepted outreach, privacy toggles for receipts.
Brimwood's version: chat is members-only, DMs are between existing members,
no cold outreach from outside the community.

## 2. What Brimwood adapts (and drops)

Keep: five-item rows, hairline dividers, single emerald unread pill, day
dividers, anchored composer, quiet "Seen", relative timestamps
(now / 5m / 2h / Yesterday / weekday / date), strict activity ordering,
search-first list.

Adapt to the brand: Emerald #0C9463 as the single accent, Paper #F6F8F7
canvas, Plus Jakarta Sans only, Canadian spelling ("organise", "favourite"),
round avatars with initials fallback (stable emerald-tint per user),
anonymous-by-default — participant cards show `display_name` (initials
fallback), never email or real name.

Drop: online/typing indicators (noise the founder's "messy" comment targets),
message editing/deletion (v1 keeps it simple; additive later), voice notes,
pinned chats, per-chat themes.

## 3. Audit of current state (2026-10-08)

- `api/src/routes/`: 17 route files, none chat-related. Grep for
  `conversation|/chat|direct message` across `api/src` and `site/src` hits
  nothing except a blog slug file. A prior audit already found DMs/groups
  deliberately unbuilt — verified true on this checkout.
- `site/src/pages/`: no messages page; members area shell at `/members`,
  dashboard at `/dashboard`, no DM entry point.
- Migration 0018 (`story_replies`) was **absent at the start of this task**
  (migrations stopped at 0015) and **landed mid-task** via the sibling stories
  agent: `stories(id, author_id, r2_key, kind, created_at, expires_at)` and
  `story_replies(id, story_id, from_user_id, body, created_at)` — exactly the
  assumed shape. `GET /api/chat/story-replies` now joins on `s.author_id`
  concretely; the `sqlite_master` feature-detect remains as cheap insurance
  for checkouts that predate 0018.

## 4. What was built

- `api/migrations/0019_chat.sql` — `conversations` (dm|group, title NULL for
  DMs), `conversation_members` (role member|admin, `last_read_at`, unique
  pair), `messages` (body TEXT, `r2_key` NULL for media). Read receipts derive
  from `last_read_at`; no per-message receipt rows.
- `api/src/routes/chat.ts` — mounted at `/api/chat`, every route behind
  `requireUser` (members-only), CSRF-guarded by the global middleware:
  - `GET /chat/conversations?q=` — participants, last-message preview, unread
    count (messages newer than `last_read_at`, not from self), ordered by
    activity.
  - `POST /chat/conversations` — DM (one other member; idempotent: returns the
    existing DM instead of duplicating) or group (≥2 others, title optional,
    creator is admin).
  - `GET /chat/conversations/:id/messages?cursor=&limit=` — cursor pagination,
    sender display info, media URLs, plus `read_receipts` map
    (`user_id → last_read_at`) so the UI can render "Seen"/"Seen by N".
  - `POST /chat/conversations/:id/messages` — text and/or media. Media goes to
    the `brimwood-media` R2 bucket as a flat `chat-<uuid>.<ext>` key
    (png/jpg/webp/gif ≤10MB, mp4 ≤10MB); served back via `/api/media/:key`.
  - `POST /chat/conversations/:id/read` — bumps `last_read_at`.
  - `POST /chat/conversations/:id/members` — group admins add/remove; DMs and
    non-admins get 400/403; nobody can remove themselves.
  - `GET /chat/people?q=` — member directory search for starting chats
    (display_name/username/avatar only; no email, no real name).
  - `GET /chat/story-replies` — as described above.
- `api/src/routes/chat.test.ts` — 21 tests, including non-member → 404 on
  every read/write path.
- `site/src/pages/messages.astro` — members-only two-pane chat: search,
  conversation list with round avatars / unread pills / relative timestamps /
  previews, thread with day dividers / collapsed bubble runs / inline media /
  "Seen" receipts, story-reply cards at the top of the list, group info with
  member list + admin badges, new-DM / new-group flow with member search.

## 5. Deliberately left out (reasons)

- Typing / online indicators — noise; the "looks messy" directive.
- Message edit/delete — additive later; migration-friendly (messages table
  carries no status column yet, add `edited_at`/`deleted_at` when needed).
- Push/email notifications for new messages — the digest worker owns
  notification cadence; real-time delivery is a post-launch decision.
- Pagination of the conversation list — capped at 60, matching the media
  route's list cap; a community of 16 people will not hit it.
- Story-reply *threads inside the conversation list* — until migration 0018
  lands there is no data; the `story-replies` endpoint + UI card slot is the
  integration seam, no dead UI shipped.
