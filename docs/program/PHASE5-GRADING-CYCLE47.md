# Phase 5 grading run, cycle 47

Date: 2026-10-31. Base: develop at ebbb92b (merge of PR 88, cycle 46 loop
state). Scope: a fresh full grading run over cycles 41 to 46, the same
slice 8 pattern as cycle 40, feeding the founder walkthrough: group
proposals with three co-founders plus staff approval (41), the rituals
read API (42), the deck command palette (43), the /hub route renaming
(44), the feed header notices (45), and the staff spotlight post type
(46). One gap was found and fixed in this cycle: a test-harness timeout
fragility in the password login tests (see Step 3). No production work
was done, no migration was applied to any live database, and no money
was spent. The founder walkthrough and the production launch stay
founder-gated behind this run.

## Step 1, sync

Origin fetched. No open loop pull request: the only open pull request is
22, the founder-tapped README glow-up, which is not loop work. Develop
HEAD CI is green across every reported check at the PR 88 merge: build,
secrets, audit, analyze, lighthouse, CodeQL, and Cloudflare Pages.

## Step 2, verification evidence

All of the following ran against the cycle 47 worktree on develop HEAD,
except where a line names CI as the source.

- API test suite: 839 tests pass, 43 files, 0 failures, with the default
  test command and no timeout flag, after the Step 3 fix.
- API typecheck: clean.
- Site build: clean, 36 pages, completed in 9.99 seconds.
- Migration chain: all 38 migration files (0001 to 0038) apply cleanly
  to a fresh local SQLite database, producing 140 tables and 116
  triggers, with 0 failures. The count is up one table from cycle 40
  (139), exactly the 0038 group_proposal_supporters table from cycle 41.
  No migration change was needed.
- Em dash scan: 0 tracked files contain the character in shipped code,
  excluding the vendor Decap bundle and the tasks working notes. The
  only remaining occurrences are site/public/cms/vendor/decap-cms-3.16.3.js
  (must never be touched) and 18 files under tasks/ (not shipped).
  The cycle 34 scrub holds.
- TODO and FIXME scan over api/src and site/src: none found.
- Console logging scan: no console.log in site/src.
- Public JS syntax: every file under site/public/js passes node syntax
  check.
- Canonical escaper: site/public/js/escape.js holds the single
  escapeHtml definition, exposed as window.Brimwood.escapeHtml, and
  page scripts alias it. The cycle 37 unification holds.
- Cycle 41 holds: migration 0038 and the group_proposal_supporters
  table are present, the proposal endpoints enforce the proposer plus
  two endorsers rule and the leak rule for proposed and rejected
  groups, and the groups tests still cover creation, endorsement,
  approval seating, and rejection hiding.
- Cycle 42 holds: the rituals routes are mounted behind requireUser and
  the rituals tests are present.
- Cycle 43 holds: site/public/js/command-palette.js is loaded by the
  HubShell and is present in the built output.
- Cycle 44 holds: Messages and Notifications live under /hub, the old
  /messages and /notifications pages are gone, and
  site/public/_redirects sends both old URLs to their /hub homes with
  301, with the /hub/g/* rewrite still in place.
- Cycle 45 holds: GET /api/feed/notices is present in the feed routes,
  the /hub/feed page carries the labelled notices region above the
  composer, and the built feed page carries it.
- Cycle 46 holds: POST /api/posts accepts intent spotlight for staff
  only with the role re-read from D1 on every call, the feed composer
  carries the hidden Spotlight chip revealed for admins, the feed
  renders the Spotlight badge, and the built feed page carries it.

## Step 3, gap found and fixed in this cycle

The default full-suite run failed before the fix with 3 failures, all in
api/src/routes/password.test.ts, all in the POST /login group:

- "rate-limits by IP" timed out at the 5 second default. The test runs
  11 sequential logins, each doing a real 600k PBKDF2 verify, and on
  this 4-CPU VM under a 43-worker parallel run it runs past 5 seconds
  (4,021 ms for that test alone in an isolated run, close to the limit).
- The two dummy-verify tests then reported deriveBits called 2 times
  instead of 1. Those are downstream pollution, not a second gap: the
  timed-out test's orphaned verifies still land after the next test
  installs its spy.

Evidence that the product code is not at fault: the password file passes
all 32 tests in isolation, and the full suite passes all 839 tests when
run with a 60 second timeout flag, in the same 47 seconds of wall time.
The CI suite on develop HEAD is green, which agrees.

Fix, in this cycle's diff and nowhere else: the rate-limits test now
carries an explicit 30 second timeout, with a comment naming the cause.
The timeout is harness only. The F8 CPU budget test (hash plus verify
inside 5,000 ms) is untouched, and no product code, route, or assertion
changed. After the fix, the default command passes 839 of 839 locally.
This is the cycle's only code change.

## Step 4, open items carried forward

- Next, per the phase map: the founder walkthrough of every panel and
  flow on preview, then production only on the green signal. Both stay
  founder-gated.
- With the spotlight type shipped in cycle 46, no recorded cross-phase
  follow-up remains open. Until the walkthrough starts, the next loop
  cycle has no named improvement left in this slice; the loop then
  either re-runs a grading pass like this one or waits on the
  walkthrough, and the loop state records that choice.
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

- Functional 2,500/2,500: suite green at 839 tests, site build clean
  at 36 pages, migration chain clean, develop CI green, and all six
  cycles 41 to 46 features verified in place.
- Schema and API 2,000/2,000: 38 migrations apply cleanly, 140 tables,
  116 triggers, no schema change needed, the one test-only change
  touches no API surface.
- Accessibility 1,250/1,250: CI Lighthouse gate green on develop HEAD;
  no UI change in this cycle beyond a test timeout, which cannot
  change rendered output. Same homepage scope limit as cycle 40.
- Performance 1,250/1,250: no new dependency, no new script, page
  count unchanged, build time 9.99 seconds.
- Security 1,250/1,250: the fixed test still asserts the IP rate limit
  and the dummy-verify timing-oracle guard; the product login code is
  untouched, and CI and CodeQL are green.
- Code quality 1,000/1,000: typecheck clean, the timeout fix is
  commented with its cause, tests stay in the existing style, no new
  dependency, no em dash in the diff.
- Brand and copy 750/750: Canadian spelling, no new em dash, no member
  named, no copy change at all.

Pro-rated total 10,000/10,000, no zero dimension, no open P0.
Verdict: ACCEPT.
