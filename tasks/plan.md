# Implementation Plan: Brimwood Website Full-Stack Build

Source: `CAPABILITY-MAP.md` (approved by proceeding to /plan) + Framework Report v1.1.
Status: **Proposed — awaiting founder review.** No code until this plan is approved.

## Overview

Evolve brimwoodinnovation.com from the static v7 "coming soon" page into the full-stack platform the report designs — Astro content site, Hono API on Workers, D1 data, magic-link auth, Academy, Decap CMS — built module by module in dependency order, with every phase verified on staging/previews before anything touches production. Production deploys only on the founder's explicit approval.

## Architecture decisions

1. **Monorepo** in `brimwood-website`: `site/` (Astro), `api/` (Hono + TypeScript), `admin/` (Decap config), `docs/` (report, runbooks). One repo, one PR flow. (Report §4.3)
2. **Astro static-first + islands; TypeScript for the API only.** Speed budget and SEO demand minimal JS; the v7 hero drops in as an island unchanged. (Assumption 1 from the capability map — Astro+Hono stands unless the founder picks React/Next.js.)
3. **D1 = system of record; KV = sessions/rate-limits/cache; R2 = media.** Newsletter and introductions migrate KV→D1 row-for-row verified.
4. **Magic-link auth, no passwords.** 6-digit codes, 10-min expiry, sessions in KV. Invite-only enforced server-side; the word "signup" never appears on public pages.
5. **Markdown/MDX in git = content source of truth.** Decap CMS (MIT, $0) writes Markdown via git merges — no database-backed CMS, no paid seats.
6. **Performance budgets are CI gates.** LCP ≤ 2.5s (target 1.8s), INP ≤ 200ms, CLS ≤ 0.1; page-weight caps (home 200KB/60KB JS, post 150KB/20KB JS). Lighthouse CI fails PRs that break them.
7. **No secrets in the repo, ever.** Wrangler secrets and GitHub Actions secrets only.
8. **Git flow stands:** `main` = production (protected), `develop` = integration, feature branches = Pages previews. (Already documented in README.)

## Dependency graph

```
foundations (repo layout, wrangler, D1/KV/R2, Pages↔GitHub, CI, _headers, legal)
  ├── content-site (Astro scaffold, hero island, /about, blog+RSS, /newsletter, SEO/AEO/GEO)
  └── api-data (Hono scaffold, D1 migrations, D1-backed forms, KV→D1 migration,
                magic-link auth, /members shell, metrics endpoint)
        └── academy (courses/lessons, enrolment, progress, R2 video, dashboard, cron, digest)
              └── admin-cms (Decap at /admin, editorial guardrails, invites, subscribers, metrics, audit)
                    └── launch-hardening (Turnstile, headers audit, backup drill, monitoring, cutover)
```

## Task list

### Phase 1 — foundations
- [ ] T1: Monorepo skeleton (`site/`, `api/`, `admin/`, `docs/`), root README, .gitignore; report → `docs/`
- [ ] T2: Wrangler project for `brimwood-api` (staging + production environments)
- [ ] T3: Provision D1 + KV + R2 (staging first)
- [ ] T4: Connect Pages project to GitHub (**blocked:** owner sign-in — parked browser task)
- [ ] T5: `_headers`, privacy + terms pages on the current baseline
- [ ] T6: GitHub Actions CI — Lighthouse CI on PRs (free minutes)

**Checkpoint CP1 — foundations:** repo builds empty shells; `wrangler whoami` works; staging D1/KV/R2 reachable; CI runs on a test PR. Review with founder before proceeding.

### Phase 2a — content-site (parallel with 2b)
- [ ] T7: Scaffold Astro site in `site/`; migrate v7 `index.html` → Astro (vanilla, no framework JS)
- [ ] T8: v7 hero as `client:load` island, hero never blocks first paint
- [ ] T9: `/about` page (**needs:** founder copy approval)
- [ ] T10: Blog content collections + RSS + 3 seed posts (**needs:** founder posts or approval)
- [ ] T11: `/newsletter` page + archive (titles + excerpts)
- [ ] T12: Countdown retirement → evergreen hero (effective after 30 Oct 2026)
- [ ] T13: SEO/AEO/GEO layer: meta, OG/Twitter, sitemap.xml, robots.txt, llms.txt, JSON-LD

**Checkpoint CP2a — content-site:** staging renders home/about/blog/newsletter; Lighthouse CI green against §5 budgets; founder approves copy.

### Phase 2b — api-data (parallel with 2a)
- [ ] T14: Scaffold Hono `brimwood-api` Worker (TS); absorb `worker-introduction.js` routes unchanged
- [ ] T15: D1 migrations 0001–0004; apply to staging
- [ ] T16: Introduction + newsletter endpoints D1-backed (behaviour parity with live worker)
- [ ] T17: KV→D1 newsletter migration script — **row-for-row verified**
- [ ] T18: Magic-link auth (6-digit codes, 10-min expiry, KV sessions)
- [ ] T19: `/members` shell page (behind auth)
- [ ] T20: API metrics endpoint (feeds the analytics dashboard)

**Checkpoint CP2b — api-data:** auth reviewed; test member signs in on staging; intro request lands in D1 + admin inbox; migration counts match. Review with founder.

### Phase 3 — academy (needs: Phase 2b)
- [ ] T21: Course/module/lesson reads (public previews static; member content via API)
- [ ] T22: Enrolment + lesson progress endpoints + UI
- [ ] T23: R2 video (720p, range requests) + lesson player
- [ ] T24: Member dashboard
- [ ] T25: Scheduled-post cron + weekly digest email

**Checkpoint CP3 — academy:** founder completes a full course end-to-end as a test member on staging.

### Phase 4 — admin-cms (needs: Phases 2a, 2b, 3)
- [ ] T26: Decap CMS (MIT) at `/admin` + GitHub OAuth worker
- [ ] T27: Editorial guardrails (Canadian spelling, banned phrases, anonymity check, SEO/AEO/GEO checklist)
- [ ] T28: Invites + subscriber management screens
- [ ] T29: Metrics + audit log screens

**Checkpoint CP4 — admin-cms:** founder publishes a blog post with zero developer help.

### Phase 5 — launch-hardening (needs: all)
- [ ] T30: Turnstile on all public forms
- [ ] T31: Security headers audit
- [ ] T32: Backup/restore drill (D1 export + restore on staging)
- [ ] T33: Monitoring + uptime checks + runbooks; docs handover
- [ ] T34: **Production cutover — founder approval gate**; retire the zip-upload workflow

**Checkpoint CP5 — launch:** checklist signed; production verified on brimwoodinnovation.com; old workflow retired.

## Parallelization

- Safe in parallel: Phase 2a ↔ 2b (contract: API base URL + endpoint paths, defined in T14 before T21); T28/T29 screens; docs/runbooks anytime.
- Must be sequential: migrations (T15) before anything reading D1; T17 before decommissioning KV reads; T34 last.
- Needs coordination: `content-site` ↔ `api-data` share the API contract — T14 defines it, both sides build against it.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Cloudflare owner sign-in still pending → T4 blocked | High | Parked browser task resumes on sign-in; dev continues via wrangler + direct upload; staging unaffected |
| SSH push route blocked by egress proxy (today) | Med | Commit a3901df queued locally; retry each turn; fallback: founder mints fine-grained PAT → HTTPS push |
| Wrangler auth needs interactive login / API token | Med | Founder action via browser; token scoped to the account, stored in vault |
| Stack assumption (Astro+Hono) unconfirmed | High | Flagged in map; if founder picks Next.js, replan foundations before T7/T14 |
| Admin seed email unknown | Med | Blocks T18/T28 testing; founder provides before Phase 2b checkpoint |
| About copy + 3 seed posts need founder input | Med | T9/T10 proceed with clearly-marked draft copy; founder approves at CP2a |
| Free-tier quotas (Resend 3k/mo, D1/KV/R2) | Low | Guardrails per report §20; monthly usage check in runbooks (T33) |
| Scope creep into live production | High | Hard rule: staging/preview only until T34; `main` stays on v7 until founder says go |

## Open questions

- Astro+Hono confirmed, or React/Next.js? (blocks T7/T14 as specified)
- Which email address(es) seed the admin allowlist? (needed before CP2b)
- About page copy + 3 seed blog posts: founder drafts or approves mine? (needed before CP2a)
- Newsletter archive public (titles + excerpts) — confirmed? (T11)
- Academy: members-only with public previews — confirmed? (affects T18 scope)

## Verification (Definition of Done, every task)

Per `~/workspace/skills/references/definition-of-done.md`: tests pass, no regressions, behaviour verified at runtime (staging URL or preview deployment), docs updated, no secrets committed, Lighthouse budgets hold for site tasks. A task is not done on "seems right".
