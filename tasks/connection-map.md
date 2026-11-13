# Feature-connection map — social wiring (audit/social/wiring)

Branch: `audit/social/wiring` (base `audit/social-ux-deep`, 2026-10-08).
Base state: no feed/stories/polls/follow/chat on this checkout — those are built
by sibling agents (profiles, feed, stories, chat) on parallel branches. Where a
sibling endpoint does not exist here, wiring targets the documented contract and
is marked **CONTRACT** (feature-detected at runtime; safe when the sibling has
not landed yet).

Research basis (Phase 1): X notifications (mentions/replies/follows/likes
collected in one Notifications tab; deep links open the *thread with parent
context*, never an orphan reply; per-category toggles), Instagram share-to-DM
(paper-plane → recipient picker → DM message with a tappable post preview card;
story replies land in the DM thread), bell UX (unread badge capped; clicking a
row marks it read and follows the deep link; badge count must equal the rows the
list actually renders).

## Canonical profile URL decision

`/@username` is CANONICAL. The profile editor already declares it ("Your
shareable page: <origin>/@<username>"), it matches the X/Instagram handle
convention the community design targets, and it is human-meaningful.
`/u/<id>` remains as an alias (stable for username-less profiles; never breaks
when a username changes) — it carries `<link rel="canonical" href="/@username">`
and client-redirects to the canonical URL when a username is known.

Shared helper (the convention for all five agents):
- Astro/server: `site/src/lib/profile.ts` → `profileUrl({id, username})`.
- Client: `site/public/js/profile-url.js` → `Brimwood.profileUrl(user)`,
  `Brimwood.linkProfiles(scope)` (wraps existing avatar/name nodes).
- Mention rendering: `site/public/js/mentions.js` → `Brimwood.renderMentions(text)`
  (escapes HTML, linkifies `@handle` → `/@handle`).

## Status legend

- **EXISTS** — wired and verified on this checkout.
- **BUILT** — implemented on this branch.
- **PARTIAL** — one leg exists, the other is built on this branch.
- **MISSING** — neither leg exists here; may be CONTRACT (sibling-owned).
- **MISALIGNED** — exists but inconsistent; realigned on this branch.

## The map

| # | Connection | Status | Evidence / action |
|---|------------|--------|-------------------|
| 1 | avatar → profile | BUILT | No avatar render linked anywhere on base (avatars only on the profile pages themselves + the editor). This branch: every avatar/name render must go through `profileUrl()` / `Brimwood.linkProfiles()`. Bell + notifications page + profile pages use it. |
| 2 | name → profile | BUILT | Same as #1 — no name→profile links on base. New renders link. |
| 3 | post → author profile | MISSING (CONTRACT) | Blog posts show `post.data.author` as plain text (CMS authors are not members — correct as-is). Community post→author link is the feed sibling's surface; contract: feed post payloads MUST include `author: {id, username, display_name, avatar_url}` and render through `profileUrl()`. |
| 4 | comment → author | BUILT/PARTIAL | Blog comments are anonymous by design (name/email, moderated) — no author link, correct. Blog comment bodies now linkify `@mentions` (mentions.js). Community comment→author is the feed sibling's contract (same author-shape rule as #3). |
| 5 | @mention → profile link + notification | BUILT | Mentions were unparsed on base. This branch: `parseMentions()` (api) + `Brimwood.renderMentions()` (client) linkify `@handle` → `/@handle`; approving a blog comment (`PATCH /api/admin/comments/:id` approve) parses mentions and emits `mention` notifications (actor = commenter matched by email, else null). |
| 6 | reply → notification to parent author | MISSING (CONTRACT) | No threading on base (blog comments flat; feed does not exist). Feed sibling MUST call the exported `emitNotification(DB, {userId: parentAuthorId, kind:'reply', actorId, targetType:'comment'|'post', targetId, preview})` when creating a reply. Deep link: the parent post URL with thread context (never an orphan reply — per X finding). |
| 7 | share → DM (open/create conversation, quoted post) | BUILT (defensive) | No chat routes on base. `site/public/js/share-to-dm.js`: `Brimwood.shareToDM({targetType, targetId, title, url})` POSTs `POST /api/chat/conversations {with_user_id?}` then posts a `share` message with the quoted payload; on 404 (chat sibling not landed) it copies the link and shows a "chat is coming soon" notice instead of failing. Blog post pages get a share button wired to it. Contract for chat sibling: `POST /api/chat/conversations` → `{conversation_id}`; `POST /api/chat/conversations/:id/messages` accepts `{kind:'share', share:{target_type, target_id, title, url}}`; `/hub/messages` page honours `?with=<user_id>`. |
| 8 | profile → Message button (DM the member) | BUILT (defensive) | `Message` button on `/@username` and `/u/<id>` → `/hub/messages?with=<id>`; if chat routes are absent it still lands on the messages page contract. Anonymous-by-default preserved: button only initiates a conversation, reveals nothing new. |
| 9 | group → chat | MISSING (CONTRACT) | No groups on base. Contract: group pages link to their group conversation via the same `POST /api/chat/conversations {group_id}` shape; left to feed/chat siblings. |
| 10 | event → RSVP → reminder | PARTIAL → BUILT | RSVP + confirmation email EXISTED. Reminder was missing. This branch: `handleScheduled` gains an hourly job — events starting in 24h±30m → reminder email to confirmed RSVP emails + in-app `event_reminder` notification to the matching member (email→user lookup). RSVP thanks copy now promises the reminder. Deep link: `/events/<slug>`. |
| 11 | story → author + reply | MISSING (CONTRACT) | No stories on base (stories sibling). Contract: story payloads include author (rule #3); story replies route through chat (Instagram pattern: reply lands in the DM thread) and emit `story_reply` notifications via `emitNotification`. |
| 12 | poll → results | MISSING (CONTRACT) | No polls on base (feed sibling). Contract: poll close emits `poll_closed` to every voter via `emitNotification`; deep link `/hub/post/<id>` (results view). |
| 13 | search results → their targets | EXISTS | `/api/search` returns `{type,title,excerpt,url}`; `search.astro` renders each as a link. Gap noted: member profiles are not searchable (privacy-safe to add later — public profiles only). Not built here; profiles sibling owns member search. |
| 14 | notification → deep link target | BUILT | No notifications existed. Server computes `url` per kind: mention→`/blog/<slug>#comment-<id>` (blog) or `/hub/post/<id>` (feed); reply→parent post; follow→`/@actor`; story_reply→`/hub/stories`; poll_closed→`/hub/post/<id>`; event_reminder→`/events/<slug>`. Clicking a bell row marks read then navigates. Same-origin only. |
| 15 | follow → notification | MISSING (CONTRACT) | No follow API on base (profiles sibling owns the follow model). Contract: `POST /api/users/:id/follow` MUST call `emitNotification(DB,{userId: followedId, kind:'follow', actorId: followerId, targetType:'user', targetId: followerId})`. Bell row: "@x followed you" → actor profile. |
| 16 | profile URL scheme (/@user vs /u/id) | MISALIGNED → BUILT | Both pages existed with no declared canonical; nothing linked to either. Fixed: `/@username` canonical (editor already promised it); both pages emit `<link rel="canonical">`; `/u/<id>` client-redirects to `/@username` when a username is known; shared `profileUrl()` helper encodes the rule for all agents. |

## Contracts the siblings must honour (checklist for reconciliation)

Verified against the siblings' in-tree code (2026-10-08 ~21:50 EDT; note: the
chat agent's uncommitted `chat.ts`/`0019_chat.sql` vanished from the shared tree
after a branch switch — all chat wiring below is 404-defensive, so it is safe
whether chat has landed or not):

1. `api/src/routes/notifications.ts` exports `emitNotification(DB, n)`,
   `parseMentions(text)`, `resolveMentionedUsers(DB, handles)`, `deepLinkFor(n)`,
   `titleFor(n)` — import, do not reimplement.
2. User JSON embedded in posts/comments/stories includes
   `{id, username, display_name, avatar_url}`; all avatar/name renders use
   `profileUrl()` (Astro, `site/src/lib/profile.ts`) /
   `Brimwood.linkProfiles(scope)` (client, `site/public/js/profile-url.js`),
   or wrap the sibling-owned `<Avatar>` in `<a href={profileUrl(u)}>`.
   (`Avatar.astro` itself is presentational — it does not link.)
3. Chat (real contract, `api/src/routes/chat.ts`): `POST /api/chat/conversations`
   `{kind:'dm', user_id}` → `{ok, conversation:{id}}` (idempotent);
   `POST /api/chat/conversations/:id/messages` `{body}` (text; no share-kind —
   shares are sent as `"Shared: <title>\n<url>"`; a preview-card render is a
   chat-sibling follow-up); `GET /api/chat/conversations` →
   `{conversations:[{id,kind,title,participants,unread}]}` (DM title = other's
   display_name). `/hub/messages` honours `?conversation=<id>` and `?with=<user_id>`.
4. Feed (real contract, `api/src/routes/feed.ts`): `POST /api/posts` `{body}`;
   `GET /api/feed` embeds `author:{id,name,display_name,avatar_key}`;
   `POST /api/polls/:id/vote`, `GET /api/polls/:id/results`. No post comments
   or mentions yet — see snippets below.
5. Profiles: rich profiles landed; **no follow endpoint yet** — the follow →
   notification contract (row 15) is still open.
6. Stories (real contract, `api/src/routes/stories.ts`): `POST /api/stories/:id/reply`
   `{body}` (1–500 chars) — replies surface to the story author via chat;
   story payloads must carry the author shape (rule 2).

### Drop-in emission snippets (for the owning agent or reconciliation)

Feed — `POST /api/posts` (after insert, `postId` + `authorId` in scope):
```ts
import { emitNotification, parseMentions, resolveMentionedUsers } from "./notifications";
const mentioned = await resolveMentionedUsers(DB, parseMentions(body));
for (const u of mentioned)
  await emitNotification(DB, { userId: u.id, kind: "mention", actorId: authorId,
    targetType: "post", targetId: postId, preview: body.slice(0, 200) });
```

Feed — post comment create (parent post author + any @mentions):
```ts
await emitNotification(DB, { userId: postAuthorId, kind: "reply", actorId: commenterId,
  targetType: "comment", targetId: `${postId}:${commentId}`, preview: body.slice(0, 200) });
// plus the mention loop above with targetType "comment", targetId `${postId}:${commentId}`
```

Feed — poll close (cron or close endpoint, voters from `poll_votes`):
```ts
for (const voterId of voterIds)
  await emitNotification(DB, { userId: voterId, kind: "poll_closed",
    targetType: "poll", targetId: postId, preview: `Results are in: ${pollQuestion}` });
```

Profiles — `POST /api/users/:id/follow` (when the follow model lands):
```ts
await emitNotification(DB, { userId: followedId, kind: "follow", actorId: followerId,
  targetType: "user", targetId: followerId });
```

Stories — `POST /api/stories/:id/reply` (after storing the reply):
```ts
await emitNotification(DB, { userId: storyAuthorId, kind: "story_reply", actorId: replierId,
  targetType: "story", targetId: storyId, preview: body.slice(0, 200) });
```

Deep-link notes: feed comment notifications use `targetId "<postId>:<commentId>"`
so the bell lands on `/hub/post/<postId>#comment-<commentId>`; reply
notifications must open the parent post with thread context, never an orphan
reply (the X finding in research).

## Deliberately left out

- Email/push delivery for notifications (Resend only for the event reminder, where
  an email channel already existed). In-app first keeps C$0 and avoids a new
  preference surface; per-category toggles (X pattern) are a documented follow-up.
- Notification grouping/collapsing ("3 people replied") — bell lists latest 20
  chronologically; grouping is a fast follow once volume exists.
- Member profiles in `/api/search` — privacy review belongs with the profiles agent.
- Deleting notifications on source delete (post/comment removed) — rows become
  undrawable; the list filters them via target checks only where cheap. Documented
  as a follow-up (same reasoning as the langx finding in research: count and list
  share one pipeline so the badge can never disagree with the list).

## Reconciliation addendum (merge of the five area branches, 2026-10-09)

During the merge I found and closed these connections the area work left open.
Each is now implemented, tested, and verified green (549 API tests).

1. **Story replies → notification (closed).** The stories agent's contract said
   story replies should surface in chat; the wiring agent wrote an emission
   snippet but it never ran. `POST /api/stories/:id/reply` now emits a real
   `story_reply` notification to the story author (skips self-replies, best-effort
   so a notification failure can never break the reply). Deep link: `/hub/stories`.

2. **Feed-post @mentions → notification (closed).** The notifications module's
   emission contract named `post`/`comment` as valid mention target types, but
   no feed route called it. `POST /api/posts` now parses @handles from the body,
   resolves them to active members, and emits `mention` notifications (deduped
   by the partial unique index; never notifies the author about their own post).
   Feed bodies also render @handles as profile links via shared
   `site/public/js/mentions.js`.

3. **Poll close → voter notification (closed).** Polls had durations and results
   but nobody was told when one closed. New migration `0021_poll_close_notify.sql`
   adds `notified_closed_at` to `polls`; the 15-minute cron (`sendPollCloseNotifications`)
   notifies every voter once with a `poll_closed` notification deep-linking to the
   post permalink. Migration applies via the standard local/CI path; remote D1 is
   untouched per the local-first rule.

4. **Dead notification deep links → real permalink (closed).** `deepLinkFor`
   generated `/hub/post/<id>` for mentions/replies/poll notifications, but no
   such route existed — every one of those notifications landed on a 404. New
   `GET /api/posts/:id` (reuses the feed's `enrichPosts` shaper; members only)
   and a static permalink page `/hub/post/?id=<id>` (query-param form — the site
   is fully static with no SSR adapter, so a dynamic path segment was impossible).
   The page renders author (profile-linked), body (mention-linkified), media,
   poll (vote + results), reactions, and a share button. `deepLinkFor` updated.

5. **Feed post authors → profiles (closed).** Post author names/avatars were
   unlinked text. The feed API now returns `username` + `profile_url` per author
   and voter; the feed links both to the canonical `/@username` (falling back to
   `/u/<id>`).

6. **Share → DM on feed posts (closed).** The share-to-DM helper existed but was
   only wired to blog posts. Feed posts and the permalink page now have share
   buttons using `Brimwood.shareToDM` (recipient picker → message with quoted
   post → navigate to conversation; falls back to copying the link).

7. **Avatar unification (closed).** Three divergent avatar styles shipped across
   areas (hash-tint, blue-600 gradient, plain gray) and server/client drift
   (Avatar.astro vs feed's JS). New shared `site/public/js/avatar.js` is the
   client-side twin of `Avatar.astro` (hashed brand-green background, 2-letter
   initials); feed, messages, and stories tray all use it. Stories tray now
   prefers `avatar_r2_key` via the shared `publicAuthor` shape, and the tray API
   returns `avatar_url`.

8. **Chat profile links (closed).** DM thread header avatars and story-reply
   cards link to `/u/<id>` (stable alias → canonical redirect). Conversation
   list rows stay whole-row buttons (opening the thread), so the avatar inside
   was deliberately left unlinked to avoid nested interactive elements.

Still open (documented follow-ups, not regressions):
- Feed comment threads (replies to posts) do not exist yet — so `reply` emission
  for feed comments has no producer. When comments ship, wire `reply` per the
  contract above.
- Follow model does not exist — so `follow` emission has no producer. The
  notification kind and deep link are ready.
- Per-category notification toggles; grouping/collapsing; notifications on
  source delete (see "Deliberately left out" above).
