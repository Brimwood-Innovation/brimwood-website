# Capability Map: Brimwood Website Full-Stack Build

Source: Brimwood Full-Stack Framework Report v1.1 (30 Sep 2026) — the standing spec input.
Status: **Proposed — awaiting founder review.** No module spec is written until this map is approved.

## Assumptions I'm making

Drawn from the report's recommendations. Correct me now or I proceed with these:

1. **Stack: Astro + Hono.** Static-first Astro frontend on Cloudflare Pages, Hono API in Workers. (If you want React/Next.js instead, say so — it changes `foundations`.)
2. **CMS timing:** Git-managed Markdown first (inside `content-site`); Decap CMS (MIT, $0) lands with `admin-cms`. No paid CMS — rejected under C$0.
3. **Academy access:** members-only lessons with public previews. (Affects auth scope in `api-data`.)
4. **Comments:** off by default; database schema ships ready.
5. **Academy pricing:** included with membership; never published without your explicit approval.
6. **Countdown:** retired after 30 Oct 2026; home hero becomes evergreen.
7. **Admin seed:** your email address(es) seed the admin allowlist — still needed from you before the `api-data` spec.
8. **Newsletter archive:** past letters published at /newsletter (titles + excerpts).
9. **Analytics:** dashboard points at the new API metrics endpoint (replaces the CLI-scrape job).
10. **Video:** R2 to start (free tier, zero egress — fits C$0); Cloudflare Stream only if you explicitly approve spend later.

## Module map

| Module id | Responsibility | Depends on |
|---|---|---|
| `foundations` | Monorepo layout; GitHub flow (`main` = production, branches = previews); Git-connected Pages project; wrangler project; D1/KV/R2 provisioning; `_headers`; privacy/terms pages; staging + production environments | — |
| `content-site` | Astro migration of the current page; v7 hero as an island; `/about`; blog via content collections + RSS; `/newsletter` page + archive; countdown retirement | `foundations` |
| `api-data` | Hono `brimwood-api`; D1 migrations 0001–0004; legacy endpoints (introduction, newsletter) D1-backed; KV→D1 newsletter migration; magic-link auth; `/members` shell; API metrics endpoint | `foundations` |
| `academy` | Courses/modules/lessons; enrolment + progress; R2 video; member dashboard; scheduled-post cron; weekly digest email | `api-data` |
| `admin-cms` | Decap CMS (MIT, $0) at `/admin`: posts, academy tree, media library, invites, subscribers, metrics, audit log; editorial guardrails (Canadian spelling, banned phrases, anonymity check, SEO/AEO/GEO checklist) | `content-site`, `api-data`, `academy` |
| `launch-hardening` | Turnstile everywhere; security headers audit; backup/restore drill; monitoring + uptime checks; runbooks; docs handover; retire the zip-upload workflow | all of the above |

**Build order:** `foundations` → `content-site` + `api-data` (parallel) → `academy` → `admin-cms` → `launch-hardening`

Dependency arrows point one way; no cycles. Interfaces between modules (e.g. what `api-data` exposes to `academy`) belong in the provider module's spec.

## Already in place (not rebuilt)

- GitHub org `Brimwood-Innovation`, repo `brimwood-website`, `main`/`develop` branches, SSH access — most of `foundations`' git half is done.
- Live v7 site on `brimwood-coming-soon` (brimwoodinnovation.com) — the starting point `content-site` migrates.
- `brimwood-introduction` Worker (introduction + double opt-in newsletter via Resend, KV rate limiting) — the legacy endpoints `api-data` absorbs.

## Blocked (outside this map, needs you)

- Connecting the Pages project to GitHub needs the owner sign-in (`adamsayani@outlook.com`) — the browser session still shows the restricted identity. Take over the browser, log out, sign back in as the owner, say "done". This gates the Git-connected half of `foundations`.

## Next step after approval

Recurse per module in build order: Specify → Plan → Tasks → Implement, one module at a time. Each module gets `SPEC-<module-id>.md` beside this map. Then `/plan` turns the approved spec into tasks.
