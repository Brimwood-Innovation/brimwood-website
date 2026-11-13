# Site frontend audit — 2026-10-08

Branch: `audit/site` (worktree `~/workspace/wt-audit/site`), scope: `site/` frontend only.
Build baseline: `npm run build` passes clean (20 pages). Page weight well under
`.lighthouserc.json` budgets (home ≈ 128 KB total incl. both logo SVGs, ≈ 28 KB JS).

Severity: **critical** = broken/visible to visitors or blocking SEO; **major** =
real UX/a11y/SEO harm; **minor** = best-practice gap, cheap to fix.

## Errors found (critical + major)

1. **(critical) Favicons referenced but missing.** `Base.astro` links
   `/favicon.svg`, `/favicon-32.png`, `/favicon-16.png`, `/apple-touch-icon.png`;
   none exist in `site/public/`. Broken tab icons, no Apple touch icon, and
   Lighthouse best-practices dings. The exact kit files exist in
   `Brimwood-Brand-Kit-v1.0/04-Favicon/`.
2. **(critical) `og:image` is an SVG.** Social scrapers (Facebook, X, LinkedIn)
   do not render SVG `og:image` — link shares show no image. Also missing
   `twitter:image`, and `twitter:card` is `summary` instead of `summary_large_image`.
3. **(critical) Draft blog posts are built and listed publicly.**
   `blog/[...slug].astro#getStaticPaths`, `blog/index.astro`, and `sitemap.xml.js`
   do not filter `draft: true`. `config.ts` says draft = "seed copy awaiting
   founder approval" — i.e. unapproved copy is live today (currently no drafts
   exist, so this is latent, but the "DRAFT" badge path renders on the public index).
4. **(major) Sitemap omits public routes.** `/events`, `/invite`, `/search` are
   missing from `sitemap.xml.js`; no `<lastmod>` anywhere. (Other agents'
   routes `/members`, `/dashboard`, `/wall`, `/newsletter` are also absent —
   `/newsletter` and `/academy` are present; owners should add theirs.)
5. **(major) `.admin-card` / `.admin-muted` unstyled on public pages.**
   Defined only in `admin.astro`'s scoped `<style>`; used by `events.astro`,
   `blog-comments.js`, and `event-rsvp.js`. Event cards and comment cards render
   with no background/border/padding on the public site.
6. **(major) Touch targets < 44 px.** Header nav text links (`padding: 8px 0`,
   ≈36 px tall) and the search icon link (≈20 px) fail the 44 px gate; footer
   links have no padding at all (≈21 px). Lighthouse a11y ≥ 0.95 at risk.
7. **(major) Dead footer auth script.** The inline script looks for
   `#footMember`, which does not exist in the footer markup — "Member sign in"
   never becomes "Dashboard" for signed-in users (rename silently no-ops).
8. **(major) Blog grid breaks on mobile.** `blog/index.astro` sets
   `style="grid-template-columns:repeat(3,1fr)"` inline, which overrides the
   responsive `.cards` media queries — phones get three cramped columns.
9. **(major) `robots.txt` allows crawling app routes.** `/cms/`, `/admin`,
   `/dashboard`, `/members/` should be disallowed.
10. **(major) `llms.txt` route coverage incomplete.** Missing `/events/`,
    `/invite/`, `/search/`.
11. **(major) Event pages are SEO-empty.** `events.astro` and
    `events/[slug].astro` render titles client-side; crawlers see "Loading…"
    and a generic title/description, and there is no Event JSON-LD. (Structural;
    noted, minimal mitigations applied.)
12. **(critical) Organization JSON-LD never rendered.** `{JSON.stringify(...)}`
    inside `<script>` bodies is emitted literally by Astro (expressions are not
    evaluated there) — every page shipped a broken JSON-LD block containing
    source code instead of schema. Fixed with `set:html`.
13. **(critical) RSS feed had `undefined` links.** `rss.xml.js` used `p.slug`,
    which does not exist on glob-loader entries — every item linked to
    `/blog/undefined/`. Fixed with `p.id.replace(/\.md$/, "")`.

## Minor findings

- No `<meta name="theme-color">`.
- `lang="en-ca"` should be canonical `en-CA`.
- `og:type` hardcoded `website` — blog posts should be `article` with
  `article:published_time`/`article:author`/`article:tag`; BlogPosting JSON-LD
  sits in `<body>` instead of `<head>`.
- Canonical for blog posts built without trailing slash while internal links
  and sitemap use trailing slash (`/blog/x` vs `/blog/x/`).
- Brand violations: `.cta form.intro .btn` uses Signal Green **behind text**
  (kit: signal = small highlights only, never behind text); hover colour
  `#5ceba3` and hero gradient stop `#15b57a` are hardcoded non-kit colours.
- No `aria-live`/`role="status"` on: intro form thanks/error, comment form
  thanks/error, RSVP thanks/error, invite error, search status/results.
- Countdown digits update every second with no screen-reader guard — noise for
  assistive tech.
- `HeroDots.astro` disables the ArrowLeft key globally (except in form fields)
  — leftover that harms keyboard users.
- `events.astro` has no `<noscript>` fallback — JS-off users see "Loading…" forever.
- `esc()` in `events.astro`, `blog-comments.js`, `event-rsvp.js` escapes only
  `<`/`>` (sufficient for text-node injection, but `&`/quotes harden it).
- `_headers` CSP `connect-src` lists stale `https://brimwood-api.adamsayani.workers.dev`;
  `PUBLIC_API_BASE` defaults to `""` (same-origin, covered by `'self'`). The
  stale host also leaks the founder's account name in a public file.
- No cache policy for `/js/*` and `/img/*` in `_headers`.
- Privacy policy omits blog comments (name/email collected) and Turnstile
  (bot check on forms).
- `event-rsvp.js` sets `document.title` but leaves the generic meta description.
- Countdown uses `Math.round(diff / 864e5)` (should be `Math.floor`); the intro
  form's error-reset path hardcodes the button label instead of using `ctaText`.
- RSS: no `atom:link rel="self"`, no `lastBuildDate`, `guid` lacks `isPermaLink`.
- Footer social links omit TikTok/Reddit (8 profiles exist) — URLs not verified,
  so not added; flagged for the socials owner.
- Copy is Canadian-spelling clean; no hype/"10x"/income-promise language found.
- Secret scan: clean (Turnstile sitekeys are public by design; no keys/tokens).
- Accepted as-is (within budgets): logo SVGs embed a base64 font (~40 KB each,
  ~80 KB/page) — required because `<img>` SVGs can't use page fonts; converting
  text to outlines would violate the kit.

## Research notes (fix approach per finding)

- Favicons/OG: copy kit files verbatim; compose the 1200×630 OG PNG from kit
  assets only (forest flat + stacked reversed logo + tagline in kit typeface),
  mirroring the approved cover-banner precedent. No redrawing/recolouring.
- Drafts: filter at the data layer (`getCollection(blog, ({data}) => !data.draft)`)
  in `getStaticPaths`, index, sitemap — same pattern `pages-index.json.ts`
  already uses.
- Touch targets: `min-height: var(--brimwood-touch-min)` + `inline-flex`
  centering on nav/footer links (visual design unchanged).
- Signal-behind-text: white button + emerald-deep text (matches hero `.btn`
  pattern); non-kit hexes replaced with kit tokens or `color-mix()` derivations.
- Event SEO: without SSR this can't be fully fixed statically; cheap wins are
  client-side title/meta updates and no-JS fallbacks.
- Sitemap/robots/llms: additive, no behaviour change.

## Implemented (this branch)

- `site/public/`: added `favicon.svg`, `favicon-16.png`, `favicon-32.png`,
  `apple-touch-icon.png` (kit `04-Favicon`, verbatim); new
  `img/brimwood-og.png` (1200×630, composed from kit assets).
- `Base.astro`: `lang="en-CA"`; `theme-color`; OG image default → PNG;
  `twitter:card` = `summary_large_image` + `twitter:image`; `og:locale` en_CA;
  new `ogType` / `articleMeta` / `jsonld` props (extra JSON-LD rendered in
  `<head>`); footer `/members` link gets `id="footMember"` so the auth script works.
- `blog/[...slug].astro`: drafts excluded from build; canonical with trailing
  slash; `og:type=article` + article meta tags; BlogPosting JSON-LD moved to
  head via prop; `role="status"` on comment thanks/error.
- `blog/index.astro`: drafts excluded; 3-col layout via new `.cards-3` class
  (responsive) instead of inline style.
- `brand.css`: shared `.admin-card`/`.admin-muted`; 44 px nav + footer link
  targets; `.cards-3`; `.visually-hidden`; hero gradient stop derived from kit
  via `color-mix()`; intro submit button no longer signal-behind-text
  (white/emerald-deep, hover mint); basic print stylesheet.
- `index.astro`: countdown digits `aria-hidden` + visually-hidden static text;
  `Math.floor` for days; error-reset uses `ctaText`.
- `search.astro`: `role="status"` on the status line.
- `events.astro`: `<noscript>` fallback; hardened `esc()`.
- `events/[slug].astro` + `event-rsvp.js`: meta description updated client-side;
  hardened `esc()`; `role="status"` on RSVP thanks/error.
- `invite.astro`, `forms/[slug].astro`: `role="status"` on error/done regions.
- `sitemap.xml.js`: added `/events`, `/invite`, `/search`; drafts filtered;
  `<lastmod>` on posts (publishDate) and static routes; event detail URLs
  included from the API at build time (best-effort, build never fails on it).
- `robots.txt`: disallow `/cms/`, `/admin`, `/dashboard`, `/members/`, `/api/`.
- `llms.txt`: added Events, Invite, Search entries.
- `_headers`: removed stale workers.dev from `connect-src`; added day-long
  caching for `/js/*` and `/img/*`.
- `privacy.astro`: mentions blog comments and Turnstile.
- `rss.xml.js`: fixed `undefined` item links (`p.slug` → `p.id`); `atom:link rel="self"`, `lastBuildDate`, `isPermaLink` guids.
- `HeroDots.astro`: removed the global ArrowLeft keydown hijack.
- `Base.astro`: Organization JSON-LD (and the new `jsonld` prop) now render via
  `set:html` — previously every page shipped the literal `{JSON.stringify(...)}`
  source as its schema block.

## Open / not changed (needs founder or another agent)

- "Toronto · Coming soon" eyebrow + "Expected to launch" countdown on `/`
  may be stale post-cutover — copy call for the founder.
- Event JSON-LD / server-rendered event content needs SSR or build-time API
  data (structural; client-side title/meta is the cheap mitigation, done).
- `/members`, `/dashboard`, `/wall` sitemap entries belong to their page owners.
- Footer TikTok/Reddit links need verified URLs (socials owner).
- Invite redeem has no Turnstile/honeypot (server rate-limits; auth-flow call).
- Countdown target (Fri 2026-10-30 19:00 local) is hardcoded; after it passes
  the digits sit at zero — content maintenance, not a code bug.
