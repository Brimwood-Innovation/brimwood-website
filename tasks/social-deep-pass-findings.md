# Social-UX deep pass — consolidated findings (coordinator, 2026-10-09)

Branch: `audit/social-ux-deep` (from `origin/audit/all-features`; stacks on PR #14).
Five area agents (profiles, feed/posts/polls/media, stories, chat, connections-wiring)
researched, audited, designed, and implemented in parallel; I merged and reconciled.

Per-area research notes (the deep platform studies) live in:
- `tasks/social-profiles.md` — Instagram/Facebook/X profile field models → per-field visibility
- `tasks/social-feed.md` — X/Facebook polls, Instagram/Facebook reels, calm reactions
- `tasks/social-stories.md` — Instagram/Facebook/X stories (24h, viewers, replies→DM)
- `tasks/social-chat.md` — WhatsApp/iMessage/Discord/Telegram chat patterns
- `tasks/connection-map.md` — the full feature-connection map + reconciliation addendum

## Cross-cutting patterns (distilled from all five research tracks)

1. **Audience control lives next to the field, not in a global page.**
   (Instagram pronouns toggle; Facebook per-field audience.) Adopted: every
   profile field carries its own public / members / only-me selector.

2. **Sensitive identity data is opt-in by design.**
   (Instagram hides birthday/gender from the public profile by default; X
   defaults birthday visibility to mutuals.) Adopted: DOB and gender default
   to only-me; the public profile stays anonymous-by-default per brand rule.

3. **Ephemerality is a viewer contract, not just a TTL.**
   (Instagram stories: 24h, viewer list, replies route to DMs — never public
   comments.) Adopted: stories expire at 24h server-side, viewer tracking is
   author-visible, replies land in chat + notify the author.

4. **Polls are calm when results are ungated and votes are changeable.**
   (X gates results behind voting; Facebook allows member-added options.)
   Adopted: results visible to all members immediately, votes changeable until
   close, voter list private unless the poll opts into `show_voters`.

5. **Every notification is a promise of a landing place.**
   (X's orphan-reply problem.) Adopted: `deepLinkFor` covers every kind; the
   merge found `/hub/post/<id>` links pointed nowhere and built the permalink.

6. **Share is a first-class action, not a copy-link fallback.**
   (Instagram paper plane.) Adopted: `Brimwood.shareToDM` — recipient picker,
   quoted post, navigate to conversation — on blog posts, feed posts, permalink.

## Audit: what was missing vs the section-19 designs

The UX/UI design doc (§19 "Community") specified: member feed with composer and
calm reactions, post detail, groups, 1:1 + group messages with read receipts,
stories (24h, replies→DMs), profile v2 (cover, pinned post), calm feed controls.
What actually existed before this pass: moderated blog comments only; the
"wall" was a public testimonials page; no member feed, no stories, no polls,
no chat, no rich profiles, no notifications. Everything below was built new.

## What was built (per area)

- **Profiles** (`0016_rich_profiles.sql`): DOB, gender (incl. custom / prefer-not-to-say),
  location, hobbies, achievements, education, life events/milestones — all editable,
  per-field visibility (DOB/gender default only-me). Avatar upload via R2; shared
  `Avatar.astro`; canonical `/@username` + `/u/<id>` alias. 30 tests.
- **Feed/posts/polls/media** (`0017_feed_polls.sql`): `/hub/feed` — composer (photo,
  video, reel ≤90s, poll), reels rail, in-post polls (1h/1d/3d/7d, changeable votes,
  per-poll voter visibility), calm 4-reaction set (Like/Celebrate/Insightful/Support),
  28 tests.
- **Stories** (`0018_stories.sql`): 24h ephemeral photo/video, tray + viewer modal,
  viewer tracking, replies → chat + author notification. 21 tests.
- **Chat** (`0019_chat.sql`): `/messages` — conversation list (search, unread pills,
  timestamps), thread (media, read receipts), group chats, story-replies inbox. 31 tests.
- **Connections** (`0020_notifications.sql` + `0021_poll_close_notify.sql`):
  notifications API + bell + inbox, @mention linkify + notifications, share-to-DM,
  event reminders, poll-close cron. 28 tests.

## Merge reconciliation (my work)

Resolved one `api/src/index.ts` merge conflict (chat's sweep of sibling mounts)
and one committed conflict marker in `api/src/lib/csrf.ts` (leftover from the
prior audit's security-ci merge). Closed 8 connection gaps (see
`tasks/connection-map.md` "Reconciliation addendum"): story-reply notifications,
feed @mention emissions + linkification, poll-close voter notifications + cron,
the missing `/hub/post` permalink (API + page), author/voter → profile links,
share buttons on feed posts, avatar unification (shared `avatar.js`), chat
profile links. Fixed 2 stories test failures caused by a mock/SQL drift.

## Verification

- API suite: **549/549 tests pass** (baseline was 405; +144 new).
- `tsc --noEmit`: clean. Astro build: clean, **24 pages**.
- Secret scan on the full branch diff: clean (no keys/tokens/passwords).
- Migrations 0016–0021 ship with the branch, unapplied; remote D1 untouched
  (local-first rule). Nothing merged to develop/main.

## Deliberately left out (with reasons)

- **Feed comment threads** — the feed agent scoped them out; posts are the unit.
  The `reply` notification kind and contract are ready for when comments ship.
- **Follow model** — no follower graph yet; `follow` notifications are specced
  but have no producer. Kept out to avoid half-built social-graph semantics.
- **Downvotes, leaderboards, algorithmic feed** — excluded per brand rule
  (calm, chronological, no engagement-bait); consistent with the v3.0 audit.
- **Email/push notification delivery** — in-app only (C$0); Resend stays for
  the event reminder where the channel already existed.
- **Voice/video calls, live video, vanish mode** — excluded in the v1.8 design
  research with reasons; unchanged.
- **Stories archive/highlights** — Instagram has them; skipped for scope.
  Stories are view-and-expire; a highlights follow-up is documented.
- **Cover photos on profiles** — the design's profile v2 shows a cover; the
  avatar + rich fields shipped first. Cover upload is a small follow-up.
