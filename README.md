# brimwoodinnovation.com website

Source of the Brimwood Innovation "coming soon" site, deployed via Cloudflare Pages
project `brimwood-coming-soon` (custom domains brimwoodinnovation.com and
www.brimwoodinnovation.com).

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

```bash
cd build && zip -r ../site.zip . -x '*.DS_Store'
```

Upload `site.zip` in the Cloudflare Pages dashboard → `brimwood-coming-soon` →
"Upload assets". Production rule: never deploy without the founder's sign-off.

## Brand

Branding follows the Brimwood Brand Kit v1.0
(`~/workspace/company/brand/Brimwood-Brand-Kit-v1.0/`), the final authority for
all public-facing content. Use kit assets exactly as delivered — never redraw,
recolour, stretch, or add effects.
