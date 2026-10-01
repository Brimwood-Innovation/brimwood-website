# brimwoodinnovation.com website

Source of the Brimwood Innovation "coming soon" site. Public repo:
`Brimwood-Innovation/brimwood-website` — every change to the site flows
through GitHub; there are no more zip uploads.

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

- `build/` — the deployable site root. Zip this directory (contents, not the
  folder) for Cloudflare Pages direct upload. **v7 is the current live deploy.**
- `worker-introduction.js` — Cloudflare Worker `brimwood-introduction`
  (route `brimwoodinnovation.com/api/*`): introduction form endpoint,
  newsletter double opt-in, Resend delivery, KV rate limiting.
- `framework/` — full-stack web framework design report (v1.1) for the future
  Brimwood site: Astro, Hono, Decap CMS, D1 schemas, SEO/AEO/GEO plan.
- `preview/` — discarded hero animation experiments (reverted; kept for reference).

## Deploying

Deployments are automatic from GitHub — do not upload zips by hand.
Pushing to `main` redeploys production within a minute or two; pushing
any other branch produces a preview URL on the Cloudflare Pages dashboard.

The old zip-upload flow is retired. `brimwood-coming-soon-*.zip` files in
this directory are kept for history only.

## Brand

Branding follows the Brimwood Brand Kit v1.0
(`~/workspace/company/brand/Brimwood-Brand-Kit-v1.0/`), the final authority for
all public-facing content. Use kit assets exactly as delivered — never redraw,
recolour, stretch, or add effects.
