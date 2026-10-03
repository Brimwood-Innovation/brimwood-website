# Performance Budgets — Brimwood Website

Set 2026-10-03 (Phase C3), from the [baseline](PERF_BASELINE_2026-10-03.md).
Founder constraint: "engineered for speed." Budgets are set **tighter than
Google's "good" thresholds** to leave headroom for lab-vs-field variance.

## The budgets

| Metric | Budget | Rationale |
|--------|--------|-----------|
| Lighthouse perf score (mobile, lab) | ≥ 90 | Every page should clear 90; most already score 97–100 |
| LCP (mobile, lab) | < 2,000 ms | 500 ms headroom under the 2.5 s CWV "good" line |
| CLS (mobile, lab) | < 0.05 | Half the 0.1 CWV line; layout is already stable |
| INP (field) | < 200 ms | Matches CWV; needs real-user data (not lab-measurable) |
| TBT (mobile, lab) | < 300 ms | Keeps main thread free for interaction |
| Total page weight | < 200 KB | Current ~125 KB; room for one hero image later |
| JavaScript (per page) | < 60 KB | Current 38–43 KB; third-party scripts are the risk |
| Images (per page) | < 100 KB | Current 56–63 KB (SVG logos only) |
| CSS (per page) | < 20 KB | Current 3 KB |
| Fonts (per page) | < 30 KB | Current 19 KB (single variable woff2) |
| HTTP requests (per page) | < 25 | Current 13–14 |
| HTML document | < 15 KB | Current 5–11 KB |
| TTFB (Toronto, p75) | < 300 ms | Measured 300–590 ms from test VM via proxy; Cloudflare Toronto PoP should beat this for real users |

### Rules of thumb for new work

1. **No new third-party script** without a budget review. Third-party is the #1 budget risk (see Turnstile note below).
2. **Images:** prefer SVG for graphics; photos must be WebP/AVIF, sized to display, lazy-loaded below the fold. Any single image > 100 KB needs justification.
3. **Client-side fetching** (events, search) must show content within the LCP budget — skeleton or SSR preferred over blank-then-populate.
4. **Fonts:** the single variable woff2 is the entire font budget. No additional weights, styles, or families without replacing it.
5. Re-measure any page that gains a new section, widget, or integration, before merge.

## Current breaches (2026-10-03)

| Page | Breach | Measured | Budget |
|------|--------|----------|--------|
| `/wall/` | **LCP over budget AND over CWV** | 2,582 ms | < 2,000 ms (CWV 2,500 ms) |
| `/blog/one-person-business` | LCP over budget (passes CWV) | 2,152 ms | < 2,000 ms |
| `/events/` | TBT over budget | 560 ms | < 300 ms |
| `/` | Perf score under budget* | 72 | ≥ 90 |

\* `/` score is a **measurement artifact**: a Cloudflare bot challenge (~650 KB, 1,560 ms TBT) fired on the datacenter test IP. True user experience is represented by the desktop run (99) and the challenge-free pages. Re-run mobile `/` from a residential IP to confirm; do not "fix" based on this number.

### Breach notes

- **`/wall/` LCP 2,582 ms** is the only genuine CWV breach. The page is fully static (build-time content), TBT is 0 ms, FCP is 1.9 s — the LCP element (likely the display headline + webfont) simply renders late under simulated throttling. Smallest fix wins: audit what the LCP element is and why it waits (see optimizations).
- **`/events/` TBT 560 ms** comes from client-side rendering: the page fetches `/api/events` then lays out (707 ms style & layout). Consider prerendering the list at build time or shipping a skeleton.
- **`/blog/<post>` LCP 2,152 ms** is within CWV but over our stricter budget — watch it as posts gain richer content (comments widget, embeds).

## Top optimization opportunities (report only — not implemented)

1. **Turnstile loads on every page.** `https://challenges.cloudflare.com/turnstile/v0/api.js` (~28 KB + a third-party connection + the Cloudflare Insights beacon) is in the shared `<head>`, but only ~5 pages use a captcha (introduction, newsletter, comments, RSVP, form submit). Load it only on pages that render a widget. Impact: ~30 KB and one third-party origin off every other page; also removes a render-adjacent script from the critical path.
2. **Prerender or skeleton the `/events/` list.** Client-side fetch + layout costs 560 ms TBT. The event list changes rarely — prerender at build time (or ISR-style revalidate) and hydrate RSVP counts client-side. Impact: TBT back under 300 ms, score 86 → 95+.
3. **Find `/wall/`'s LCP element.** With 0 ms TBT the delay is render/resource ordering, not JS. Candidate causes: the LCP headline waiting on the preloaded font (already `swap` + preloaded, so likely fine), or the first paint blocked by the external CSS. Consider inlining critical CSS for above-the-fold on this template. Impact: LCP back under 2 s.
4. **Footer auth check on every page.** `fetch("/api/auth/me")` runs on all pages to toggle member links. It's async and non-blocking, but it's a same-origin API round-trip on every navigation. Defer it until after `load` or cache the result in `sessionStorage`. Impact: small; mostly cleanliness.
5. **Evaluate the Cloudflare Insights beacon** (`beacon.min.js`, ~10 KB on every page). If its analytics aren't being read, remove it. If they are, keep — it's the cheapest way to get real-user (field) data for INP, which lab tests cannot measure.

## Enforcement

- Add these budgets to the PR checklist: any page touching JS, images, fonts, or third-party scripts gets a Lighthouse run before merge.
- Re-baseline quarterly, or after any redesign.
- When real-user (CrUX / Insights) data exists, field INP/LCP/CLS replace lab numbers as the source of truth.
