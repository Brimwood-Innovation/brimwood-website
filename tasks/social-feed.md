# Social: feed, posts, polls, media (agent: feed)

Branch: `audit/social/feed`. Migration: **0017** (`api/migrations/0017_feed_polls.sql`).

## Phase 1 — Research (Instagram / Facebook / X patterns, distilled for Brimwood)

### In-post polls
- **X**: 2–4 options, duration 5 min → 7 days (default 24h), one vote per user, votes anonymous, results shown after voting; published polls can't be edited.
- **Facebook (groups)**: up to 25 options, 1 day / 1 week / custom end, multiple-answers and member-added options possible; results visible to members in real time.
- **Calm Brimwood adaptation**: 2–4 options (matches X; avoids choice overload), duration picker **1h / 1d / 3d / 7d** (matches X's max), one vote per member **changeable until close** (X is one-and-done; Brimwood lets members change their mind — calmer, matches the "nothing is irreversible" safety rule), voter list private by default with a per-poll **show_voters** opt-in (private polls show counts only), results visible to all members immediately (no engagement-gate; voting is not required to see counts).
- Locked after first vote only in the sense that question/options/duration can't change post-create (matches FB: no edits once voting starts).

### Media posts
- Photos: single or grid (2–4 per post — kept at 4 to stay lightweight).
- Video: MP4; member cap 10 minutes; ≤90s is a **reel** (matches Facebook Reels 3s–90s and Instagram's recommendation sweet spot of ≤90s).
- Reels surface twice: inline in the chronological feed plus a dedicated horizontal **reels rail** above the feed.

### Reels / short video (2026 specs)
- Instagram/Facebook Reels: 9:16 vertical, 1080×1920, MP4/H.264, ≤90s for recommendation; FB hard cap 90s. Brimwood adopts ≤90s ⇒ reel flag, server-verified from stored R2 metadata on attach (client claims are hints only).

## Phase 2 — Audit findings (what existed, what was missing)

Read: `api/src/routes/comments.ts` (moderated blog comments), `media.ts` (admin-only R2 upload, 10MB, PNG/JPG/WEBP/GIF/SVG/MP4), `forms.ts`, `site/src/pages/wall.astro` (public testimonials wall — **not** a member feed; no feed page existed), design doc §19 "Community" (`~/workspace/your_files/brimwood-ux-ui-design/index.html`).

Gaps found and filled by this work:
1. **No feed API at all** — no posts table, no `/api/feed`, no chronological member feed page.
2. **No poll support** — §19 says "Polls: Yes — in composer", but nothing implemented. Built: schema + API + poll builder + poll cards.
3. **No member media upload** — `media.ts` was admin-only. Added member-scoped `POST /api/media/upload` (no SVG — never render member uploads inline).
4. **No reels concept** — video ≤90s flagged `kind='reel'`, surfaced in feed + reels rail.
5. **No reactions backend** — §19 defines the 4 calm reactions (👍🎉💡🤝, no angry/sad). Added `post_reactions` + toggle endpoint + counts in feed. (Not in the original API spec; added because the UI spec requires calm reactions and faking them client-side would be dishonest.)

Left for other agents (not my area):
- Stories (0018, stories agent), chat/DMs (0019, chat agent), groups (separate area), notifications (0020, notifications agent), share-to-DM, repost/quote — §19 features outside feed/posts/polls/media.

## Phase 3 — Implementation

### Schema (`0017_feed_polls.sql`)
- `posts(id, author_id, body, created_at)` — chronological via `created_at DESC`.
- `post_media(post_id, r2_key, kind photo|video|reel, width, height, duration_s, position)`.
- `polls(post_id UNIQUE, question, closes_at, show_voters 0/1)` — one poll per post.
- `poll_options(id, poll_id, label, position)`.
- `poll_votes(poll_id, option_id, voter_id, voted_at; UNIQUE(poll_id, voter_id))` — one vote per member, changeable until close (SQLite UPSERT).
- `post_reactions(post_id, member_id, kind like|celebrate|insightful|support, reacted_at; PK(post_id, member_id))` — one reaction per member per post; same kind again removes it.

### API (`api/src/routes/feed.ts`, mounted at `/api` in `api/src/index.ts`)
- `POST /api/media/upload` — member multipart upload. 10MB cap; PNG/JPG/WEBP/GIF/MP4 only (no SVG). Video needs client-reported `duration_s` (0 < d ≤ 600); ≤90s ⇒ `kind=reel`, else `video`. Keys server-generated (`feed-…`), unguessable.
- `POST /api/posts` — members-only, rate-limited. Body 1–2000 chars; up to 4 media refs (existence + content-type re-verified from R2; kind re-derived server-side); optional poll `{question ≤140, options 2–4 unique labels ≤60, duration 1h|1d|3d|7d, show_voters}`. Rejects empty posts.
- `GET /api/feed` — members-only, chronological DESC, `limit` 1–50 + `cursor` pagination. Embeds: author (display_name or initials — never email/real name), media (signed URLs), poll state (counts, `my_vote`, `closed`), reactions (counts + `my_reaction`). All reads batched (no N+1).
- `POST /api/polls/:id/vote` — 404 unknown, 400 closed or foreign option; UPSERT so votes are changeable until close.
- `GET /api/polls/:id/results` — counts always; `voters[]` (public-safe author shape) only when `show_voters=1`.
- `POST /api/posts/:id/react` — validates kind against the 4 calm reactions; toggle semantics (same kind removes, different kind changes).

### UI (`site/src/pages/hub/feed.astro`)
- Member-gated (401 ⇒ sign-in prompt). Composer: text, photo/video file inputs (video duration read client-side via `<video>` metadata → `duration_s` sent with upload), poll builder (question, 2–4 options, duration picker, show-voters toggle). Uploads happen first; the post submits refs — kind badges ("Reel"/"Video") shown in the preview.
- Reels rail (hover-to-preview, vertical cards), chronological post list, poll cards (vote buttons → live result bars with %; "Who voted" expander for public polls), media grid + inline `<video controls>`, calm reaction bar with counts and active state (re-reads feed after each toggle for honest counts).
- Avatars: round initials or avatar image. No Avatar.astro existed at build time — used the design-doc's round avatar convention (a sibling owns Avatar.astro; the markup is a plain round span/img they can swap).
- All user text escaped client-side. Canadian spelling.

### Tests (`api/src/routes/feed.test.ts`, 28 tests)
Upload (auth, type, size, photo/reel/video flags, duration validation), posts (auth, empty, text, missing R2 ref, kind re-derivation, 4-attachment cap, poll validation, poll creation, dedupe), feed (auth, chronological embed with anonymous author + media + poll state), votes (auth, 404, closed, upsert SQL), results (counts-only vs voter list), reactions (auth, kind validation, change, remove, 404).

## Verification
- `npx vitest run` (api/): **543/543 pass, 29 files** (28 new feed tests; baseline was 405 — remainder is sibling areas on the shared base).
- `npx tsc --noEmit` (api/): clean for all feed files. Remaining errors are in the sibling-owned `src/routes/notifications.test.ts` (`d` typed unknown) — pre-existing, untouched by this work.
- `npm run build` (site/): **22 pages, complete** — includes `/hub/feed/index.html`.
- Migration `0017_feed_polls.sql` applied against a local sqlite3 database: schema valid, UNIQUE(poll_id, voter_id) enforced as designed.
- `wrangler dev --local` could not start a smoke test in the shared tree: the bundled worker throws a global-scope I/O error at module load (pre-existing in the sibling-laden tree; `feed.ts` performs no global-scope I/O). Unit tests cover all endpoints instead.

## Deliberately left out
- **Repost/quote, share-to-DM, groups posting, comment threads on feed posts** — other areas (chat/groups agents); post detail route `/hub/post/[id]` not built.
- **Edit/delete own posts** (§19 lists it) — left out to keep the migration surface tight; posts are append-only for now. Recommend a follow-up (edit window + audit log entry).
- **Poll analytics beyond counts** (who-voted is binary) — deliberate; calm, no surveillance feel.
- **Scheduled posts, multi-question surveys, multiple-answer polls** — out of scope; the 2–4 option single-question poll matches X's proven pattern.
- **Server-side video metadata inspection** — Workers can't probe video bytes cheaply; duration is client-reported and sanity-bounded (≤600s), kind re-derived from R2 content-type at attach.
