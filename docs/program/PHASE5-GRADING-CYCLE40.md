# Phase 5 grading run, cycle 40 (slice 8)

Date: 2026-10-29. Base: develop at 6af7d1e (merge of PR 79, cycle 39 loop
state). Scope: a fresh full grading run over the hardened surface from
cycles 34 to 39, feeding the founder walkthrough: the repo-wide em dash
scrub (34), the full client-side HTML audit (35), dedicated media and
metrics tests (36), the canonical escaper (37), server-id escaping (38),
and scheme allowlists for href and src fields (39). The diff from the
cycle 33 grading base (2b74559) to this base covers 130 files,
1530 insertions and 480 deletions. No production work was done, no
migration was applied to any live database, and no money was spent. The
founder walkthrough and the production launch stay founder-gated behind
this run.

## Step 1, sync

Origin fetched. No open loop pull request: the only open pull request is
22, the founder-tapped README glow-up, which is not loop work. Develop
HEAD CI is green across every reported check at the PR 79 merge: build,
secrets, audit, analyze, lighthouse, CodeQL, and Cloudflare Pages.

## Step 2, verification evidence

All of the following ran against the cycle 40 worktree on develop HEAD,
except where a line names CI as the source.

- API test suite: 822 tests pass, 42 files, 0 failures.
- API typecheck: clean.
- Site build: clean, 36 pages, completed in 5.09 seconds. The built
  output carries dist/js/escape.js and dist/js/safe-url.js.
- Migration chain: all 37 migration files (0001 to 0037) apply cleanly
  to a fresh local SQLite database, producing 139 tables and 116
  triggers, with 0 failures. No migration change was needed.
- Em dash scan: 0 tracked files contain the character in shipped code,
  excluding the vendor Decap bundle and the tasks working notes. The
  only remaining occurrences are site/public/cms/vendor/decap-cms-3.16.3.js
  (must never be touched) and the tasks working notes (not shipped).
  The cycle 34 scrub holds.
- TODO and FIXME scan over api/src and site/src: none found.
- Console logging scan: no console.log in site/src.
- Public JS syntax: every file under site/public/js passes node syntax
  check.
- Canonical escaper: site/public/js/escape.js holds the single
  escapeHtml definition. No duplicate function esc exists in the public
  scripts or in any Astro file. The cycle 37 unification holds.
- Client-side HTML spot check: academy-lesson.js, blog-comments.js,
  notifications-bell.js, and profile-refresh.js all interpolate API
  values through esc() when building markup. The notification safeUrl
  helpers are aliases to the canonical safeMediaUrl. The cycle 35 audit
  holds.
- Scheme allowlists: Base.astro loads escape.js and then safe-url.js
  as classic inline scripts, before every module and deferred footer
  script. The server twin site/src/lib/safeUrl.ts is present and
  ProfileView renders member website and social links through it. The
  only javascript: strings in site source are in comments
  (ProfileView, studio). The cycle 39 gates hold.
- Media and metrics tests: media.test.ts carries 21 it() cases and
  metrics.test.ts carries 5, covering admin gates, listing, prefix
  filtering, pagination, and unsafe prefix rejection. The cycle 36 gap
  from cycle 33 stays closed.
- Server-id escaping: the cycle 38 files (admin EventsTab and FormsTab,
  admin page, hub feed, hub post page) still carry the escaped
  attribute form, and feed URLs still encode ids with
  encodeURIComponent. The cycle 38 fix holds.

## Step 3, items checked and cleared (not gaps)

Two href and src assignments outside the canonical gates were examined
and cleared as safe by construction, the same class cycle 39 audited and
left alone:

- profile-refresh.js assigns avatar_url straight to an img src. The
  API builds avatar_url only from a stored avatar_key as
  /api/media/ plus an encoded key (profiles, people, chat,
  notifications, saved, stories routes all agree), never from a
  member-supplied raw URL, so no member value can reach that src.
- profile-url.js assigns a.href from profileUrl(), which builds only
  "/@" plus a username matched by USERNAME_RE, or "/u/" plus an id.
  No stored value flows into the href unshaped.

No new gap was found in this run, and no P0 is open.

## Step 4, open items carried forward

- Next, per the phase map: the founder walkthrough of every panel and
  flow on preview, then production only on the green signal. Both stay
  founder-gated.
- Until the walkthrough starts, the loop's fallback work is the open
  cross-phase follow-ups: proposing a new group, live verification of
  the /hub/g/* rewrite on a branch preview, a rituals read API, the
  deck command palette, the /hub route renaming, the feed header
  notices, and the staff spotlight post type.
- Unchanged and still blocked: the Phase 1 preview smoke flows and
  applying migration 0037 to preview D1 (no Cloudflare token in the
  environment).
- Unchanged and still founder-gated: live certificate issuance needs
  the two signing secrets plus the matching signing_keys row; until
  then a completed course reports certificate_pending, which is the
  intended fail-closed state.

## Step 5, grade

Scored from the evidence above, never from impression. Every dimension
is scored, and each limit below is part of the score's basis. Limits
recorded, not hidden: gitleaks is not installed in this environment,
so the secret evidence is the CI secrets job (green on develop HEAD);
the local npm audit endpoint is blocked by this sandbox's registry
policy, so the audit evidence is the CI audit job (green on develop
HEAD); Lighthouse was not rerun locally, so the accessibility and
performance evidence is the CI lighthouse job (green on develop HEAD,
homepage scope only, not all 36 pages).

- Functional 2,500/2,500: suite green at 822 tests, site build clean
  at 36 pages, migration chain clean, develop CI green.
- Schema and API 2,000/2,000: 37 migrations apply cleanly, 139 tables,
  116 triggers, no schema change needed, media and metrics routes now
  directly tested.
- Accessibility 1,250/1,250: CI Lighthouse gate green on develop HEAD;
  no UI change in cycles 34 to 39 beyond escaping and link gating,
  which preserve rendered output. Same homepage scope limit as cycle 33.
- Performance 1,250/1,250: CI Lighthouse budgets green on develop
  HEAD; clean build in 5.09 seconds, no new dependency, no new
  runtime fetch.
- Security 1,250/1,250: CodeQL analyze green, CI secrets green, em
  dash scrub holds at zero in shipped code, single canonical escaper,
  every client href and src sink gated or cleared as safe by
  construction, no confirmed injection or unsafe scheme path.
- Code quality 1,000/1,000: one canonical client escaper module plus
  one canonical safe-url module and one server helper, duplicated
  helpers replaced by aliases, no TODO or FIXME, no console.log in
  site source, no new dependency.
- Brand and copy 750/750: em dash count in shipped code and copy is
  zero; no copy change in this run, Canadian spelling untouched.

Pro-rated total 10,000/10,000, no zero dimension, no open P0. Verdict:
ACCEPT. Next improvement: the founder walkthrough of every panel and
flow on preview, feeding the production green signal; until it starts,
the next loop cycle takes the first open cross-phase follow-up.
