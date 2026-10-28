# Phase 5 grading run, cycle 33

Date: 2026-10-28. Base: develop at d2f26a4 (merge of PR 72, cycle 32 loop
state). Scope: the phase map's first Phase 5 step, a hardening and full
grading run over the whole build. No production work was done, no migration
was applied to any live database, and no money was spent. The founder
walkthrough and the production launch stay founder-gated behind this run.

## Step 1, sync

Origin fetched. No open loop pull request: the only open pull request is
22, the founder-tapped README glow-up, which is not loop work. Develop
HEAD CI is green across every reported check: build, secrets, audit,
analyze, lighthouse, and Cloudflare Pages.

## Step 2, verification evidence

All of the following ran against the cycle 33 worktree on develop HEAD,
except where a line names CI as the source.

- API test suite: 796 tests pass, 40 files, 0 failures.
- API typecheck: clean.
- Site build: clean, 36 pages, completed in about 5 seconds.
- Migration chain: all 37 migration files (0001 to 0037) apply cleanly to a
  fresh local SQLite database, producing 139 tables and 116 triggers, with
  0 failures. No migration change was needed.
- Route inventory: 29 API route modules. Two of them have no dedicated
  test file: media and metrics. The metrics route is admin only and
  returns aggregates; the media route is covered only indirectly through
  the upload library tests. This is a coverage gap, not a failure: the
  suite is green, but these two modules deserve direct tests.
- Secret scan: gitleaks 8.18.4 run locally over the worktree scanned 188
  commits and found no leaks. The CI secrets job on develop HEAD is also
  green.
- Dependency audit: the local npm audit endpoint is blocked by this
  sandbox's registry policy, so no local audit result exists. The
  evidence used instead is the CI audit job, green on develop HEAD at the
  high level and above. This limit is recorded, not hidden.
- Lighthouse: not rerun locally. The evidence used is the CI lighthouse
  job, green on develop HEAD. Its scope limit is recorded: CI gates the
  homepage URL, not every one of the 36 pages, so the accessibility and
  performance scores below rest on the homepage gate plus the clean
  build, not on a per-page audit.
- TODO and FIXME scan over api/src and site/src: none found.
- Console logging scan: no console.log in site/src. The console.log calls
  in api/src/cron.ts are operational worker logs (reminders, digests,
  purges, deletions), not browser debug output.
- Mixed content and external link scan: the only http link in site/src
  outside the usual namespaces is the sitemap XML namespace declaration,
  which is correct by specification.
- External link safety spot check: the footer social links and the
  profile website link carry rel noopener with target blank. The
  multi-line anchor in ProfileView looked, at first glance, like a
  missing rel, but the rel attribute is present on the same anchor, so
  there is no finding there.
- Client-side HTML spot check: StoriesTray escapes display names through
  its esc helper before building markup. A full client-side HTML
  injection audit was not completed in this cycle and is listed below as
  a later Phase 5 slice; no confirmed injection issue was found.

## Step 3, the one confirmed hardening gap

The em dash character appears 709 times across tracked files:

- tasks working notes: 387 (not shipped, excluded from any fix)
- api: 132 (comments, test fixtures, and email copy)
- site: 126 (pages, components, styles, public scripts, and content)
- docs: 33
- worker-introduction.js: 24
- CONSTRAINTS.md: 3, .gitignore: 3, workflows: 1

Earlier cycles scrubbed the character only from files they touched, so the
standing "no em dash anywhere" constraint is not satisfied repo-wide, and
shipped site copy still contains it. A repo-wide scrub is a real slice of
work, not a search and replace: email fixtures carry expected copy that
must change with the templates, the vendor Decap bundle in
site/public/cms must never be touched, and copy punctuation needs a
per-occurrence choice (comma, period, or sentence break). That slice is
the named next improvement. This cycle introduced no new occurrence.

## Step 4, open items carried forward

- Phase 5 slice 2 (next): repo-wide em dash scrub of shipped code and
  copy, excluding the vendor bundle and the tasks working notes.
- Phase 5 slice 3: full client-side HTML injection audit across the
  components that build markup from API data.
- Phase 5 slice 4: dedicated tests for the media and metrics route
  modules.
- Unchanged and still blocked: the Phase 1 preview smoke flows and
  applying migration 0037 to preview D1 (no Cloudflare token in the
  environment).
- Unchanged and still founder-gated: live certificate issuance needs the
  two signing secrets plus the matching signing_keys row; until then a
  completed course reports certificate_pending, which is the intended
  fail-closed state.
- Unchanged and still founder-gated: the founder walkthrough of every
  panel and flow on preview, then the production launch.
- Cross-phase follow-ups still open: proposing a new group, live
  verification of the /hub/g/* rewrite on a branch preview, a rituals
  read API, the deck command palette, the /hub route renaming, the feed
  header notices, and the staff spotlight post type.

## Step 5, grade

Scored from the evidence above, never from impression. Dimensions the
grading run covered are scored; none is scored from a rerun that did not
happen, and each limit above is part of the score's basis.

- Functional 2,500/2,500: suite green at 796 tests, site build clean at
  36 pages, migration chain clean, develop CI green.
- Schema and API 2,000/2,000: 37 migrations apply cleanly, 139 tables,
  116 triggers, no schema change needed.
- Accessibility 1,250/1,250: CI Lighthouse gate green on develop HEAD;
  no UI change in this cycle. Scope limit: the CI gate covers the
  homepage, not all 36 pages.
- Performance 1,250/1,250: CI Lighthouse budgets green on develop HEAD;
  clean build, no new dependency, no new runtime fetch. Same homepage
  scope limit as accessibility.
- Security 1,250/1,250: CodeQL analyze green, CI secrets green, local
  gitleaks scan of 188 commits with no leaks, no confirmed injection or
  unsafe link issue in the spot checks.
- Code quality 950/1,000: typecheck clean, build clean, no TODO or FIXME
  in source, but two route modules (media, metrics) lack dedicated test
  files.
- Brand and copy 500/750: Canadian spelling and kit assets untouched, no
  new occurrence introduced, but the em dash count in shipped copy
  (126 site, 132 api) means the standing constraint is not met
  repo-wide.

Pro-rated total: 9,700/10,000, no zero dimension, no open P0.
Verdict: ACCEPT. Next improvement: Phase 5 slice 2, the repo-wide em
dash scrub of shipped code and copy, as specified in step 3.
