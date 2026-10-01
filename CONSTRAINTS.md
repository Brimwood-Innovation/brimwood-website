# CONSTRAINTS.md — Brimwood Website Build

The founder's hard constraints. Written once, enforced at every gate (`/plan` → `/build` → `/test` → `/review` → `/ship`). A task that violates any of these is not done.

## 1. C$0 operating cost
- Every component is open-source or on a free tier with a documented open alternative. No paid tier is adopted without the founder's explicit approval.
- Gate: dependency/PR review rejects paid services, per-seat meters, usage-priced APIs. (Report §4.4, §20)

## 2. Fully open source
- All code MIT (or equivalent permissive) licensed; no proprietary binaries, no closed SDKs in the build path.
- Gate: licence check on every new dependency.

## 3. Lightweight and fast
- Core Web Vitals: LCP ≤ 2.5s (target 1.8s), INP ≤ 200ms, CLS ≤ 0.1 — Moto G4 / 4G lab profile.
- Page-weight caps: home 200KB total / 60KB JS; blog post 150KB / 20KB JS; lesson 200KB / 40KB JS; admin 400KB / 250KB JS; CSS ≤ 30–50KB per page.
- Gate: Lighthouse CI fails PRs that break budgets. No framework runtime ships for static content.

## 4. Responsive and accessible
- Mobile-first breakpoints (560 / 860 / 1200px container); touch targets ≥ 44px; no hover-dependent actions on touch.
- `prefers-reduced-motion` respected everywhere (static hero frame, no autoplay).
- Gate: manual mobile + reduced-motion check per UI task; axe-level issues block merge.

## 5. SEO, AEO, GEO throughout
- Every public page: meta, OG/Twitter, canonical, JSON-LD, sitemap.xml, robots.txt, llms.txt; blog posts as BlogPosting schema; content structured for featured snippets and AI citability.
- Gate: T13 checklist + validator passes; new public routes must add themselves to sitemap/llms.txt.

## 6. Brimwood Brand Kit v1.0 is final authority
- Emerald-led palette (#0C9463 etc.), Plus Jakarta Sans (self-hosted woff2), exact logo files, Canadian spelling, short sentences.
- Never redraw, recolour, stretch, or add effects to kit assets. No income promises, no hype/"10x" language, no competitor criticism — including sample copy and schemas.
- Members anonymous by default: share the what, never the how; written permission + draft review before naming anyone.
- Gate: brand review on every visual/content PR.

## 7. Dev-first; production only on explicit approval
- All work lands on `develop` / feature branches and is verified on staging or preview deployments.
- `main` (production) changes only at T34 with the founder's explicit go-ahead. Nothing auto-deploys to production.
- Gate: branch protection on `main`; the cutover task never runs without written approval.

## 8. No secrets in code, repos, or chat-visible storage
- No passwords, API keys, tokens, or private keys in files, commits, artifacts, or chat. Wrangler secrets and GitHub Actions secrets only.
- Gate: pre-commit secret scan; review rejects any committed credential on sight.
