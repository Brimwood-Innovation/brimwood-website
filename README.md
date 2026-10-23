<!-- PREPEND to brimwood-website/README.md, above the existing "# brimwoodinnovation.com website" heading -->

<p align="center">
  <strong>Brimwood Innovation</strong> — Build a business. Build yourself.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Site-brimwoodinnovation.com-0C9463" alt="Live site" />
  <img src="https://img.shields.io/badge/Stack-Astro%20%2B%20Cloudflare-0C9463" alt="Astro + Cloudflare" />
  <img src="https://img.shields.io/badge/Cost-C%240%20open%20source-0C9463" alt="C$0, open source" />
  <img src="https://img.shields.io/badge/Licence-MIT%20OR%20AGPL--3.0-0C9463" alt="MIT OR AGPL-3.0" />
</p>

<p align="center">
  The public platform for a selective Toronto builder community and venture foundry.<br/>
  Lightweight, fast, fully open source. Every change flows through GitHub — no zip uploads.
</p>

---
# brimwoodinnovation.com website

Monorepo for the Brimwood Innovation website. Public repo:
`Brimwood-Innovation/brimwood-website` - every change flows through
GitHub; there are no more zip uploads.

## Workflow (enforced)

- `main` → **production**. Cloudflare Pages auto-deploys `main` to
  brimwoodinnovation.com on every push. Never push or merge to `main`
  without the founder's explicit sign-off.
- Any other branch (or pull request) → **preview**. Cloudflare Pages
  builds a preview URL automatically, e.g.
  `brimwood-website-<hash>.pages.dev`. Develop and review there first.
- Push access: SSH key "Brimmy VM" on the brimwoodai GitHub account.

```bash
git checkout -b feature/my-change   # develop here
git push -u origin feature/my-change # get a preview URL from Cloudflare
# founder reviews the preview, then:
git checkout main && git merge feature/my-change && git push  # ships to production
```

## Layout

- `site/` - Astro public website (Cloudflare Pages). Being built; see
  `tasks/plan.md`.
- `api/` - Hono `brimwood-api` Worker (TypeScript): forms, newsletter,
  auth, members, admin endpoints. Being built.
- `admin/` - Decap CMS (MIT) config, served at `/admin`. Being built.
- `docs/` - runbooks, perf budgets and CMS notes.
- `worker-introduction.js` - live Cloudflare Worker `brimwood-introduction`
  (route `brimwoodinnovation.com/api/*`): introduction form endpoint,
  newsletter double opt-in, Resend delivery, KV rate limiting. Absorbed
  into `api/` during the build; until then it stays untouched.
- `CONSTRAINTS.md`, `tasks/` - spec, build constraints,
  implementation plan and task list (the `/spec` → `/plan` → `/build` trail).

## Deploying

Deployments are automatic from GitHub - do not upload zips by hand.
Pushing to `main` redeploys production within a minute or two; pushing
any other branch produces a preview URL on the Cloudflare Pages dashboard.

The old zip-upload flow is retired. `brimwood-coming-soon-*.zip` files in
this directory are kept for history only.

## Licence

Code in this repo is dual-licensed under the MIT License OR the GNU
Affero General Public License v3.0, at your choice. See `LICENSE`,
`LICENSE-MIT` and `LICENSE-AGPL-3.0`. Brand assets, fonts and site
content are not covered by the code licence - see `NOTICE`.

## Brand

Branding follows the Brimwood Brand Kit v1.0
(`~/workspace/company/brand/Brimwood-Brand-Kit-v1.0/`), the final authority for
all public-facing content. Use kit assets exactly as delivered - never redraw,
recolour, stretch, or add effects.
