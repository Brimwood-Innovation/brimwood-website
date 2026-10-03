# Performance Baseline — 2026-10-03

First Lighthouse baseline for the Brimwood website (Phase C3).
Production: `https://brimwoodinnovation.com` (Cloudflare Pages + shared Worker API).

## Method

- Tool: Lighthouse 13.5.0, Chrome 154 (headless), simulated throttling.
- Form factor: **mobile** for all pages (Moto G4-class simulation); desktop sampled for `/` and `/blog`.
- Run from a VM in an unknown region via egress proxy; TTFB measured separately with curl.
- Each page measured once. INP was not measurable in lab (no real interaction); field data needed.

## Mobile results

| Page | Perf | LCP | CLS | INP | Total weight | JS | Img | CSS | Font | Requests |
|------|------|-----|-----|-----|--------------|----|-----|-----|------|----------|
| `/` | 72* | 1,253 ms | 0.076 | n/a | 785 KB* | 43 KB | 56 KB | 3 KB | 19 KB | 21 |
| `/blog` | 100 | 954 ms | 0 | n/a | 126 KB | 38 KB | 56 KB | 3 KB | 19 KB | 14 |
| `/blog/one-person-business` | 97 | 2,152 ms | 0 | n/a | 773 KB* | 38 KB | 63 KB | 3 KB | 19 KB | 24 |
| `/academy` | 99 | 979 ms | 0 | n/a | 125 KB | 38 KB | 56 KB | 3 KB | 19 KB | 14 |
| `/search/` | 100 | 1,429 ms | 0 | n/a | 126 KB | 38 KB | 56 KB | 3 KB | 19 KB | 13 |
| `/events/` | 86 | 934 ms | 0 | n/a | 126 KB | 38 KB | 56 KB | 3 KB | 19 KB | 14 |
| `/wall/` | 93 | **2,582 ms** | 0 | n/a | 125 KB | 38 KB | 56 KB | 3 KB | 19 KB | 13 |

\* `*` = inflated by a Cloudflare bot challenge (~650 KB of challenge-platform traffic) triggered by the datacenter test IP on the first two runs. Real visitors on residential IPs do not pay this cost; the site's true weight is ~125 KB.

## Desktop results (sampled)

| Page | Perf | LCP | CLS | Total weight | JS | Requests |
|------|------|-----|-----|--------------|----|----------|
| `/` | 99 | 348 ms | 0.054 | 779 KB* | 43 KB | 21 |
| `/blog` | 100 | 502 ms | 0 | 126 KB | 38 KB | 14 |

Desktop is essentially perfect. The `/` weight is again inflated by the bot-challenge artifact (`*`).

## TTFB (curl, document HTML, via egress proxy)

| Page | TTFB | HTML size |
|------|------|-----------|
| `/` | 382 ms | 10.9 KB |
| `/blog` | 589 ms | 5.9 KB |
| `/blog/one-person-business` | 573 ms | 11.4 KB |
| `/academy` | 364 ms | 4.9 KB |
| `/search/` | 309 ms | 7.5 KB |
| `/events/` | 536 ms | 6.2 KB |
| `/wall/` | 302 ms | 6.3 KB |

Measured from the test VM (not Toronto). Cloudflare edge serves Toronto visitors from the local PoP, so real-user TTFB should be lower. HTML payloads are tiny (5–11 KB) across the board.

## Reading the numbers

- **The site is genuinely light.** Excluding the bot-challenge artifact: ~125 KB total, ~38 KB JS, zero content images (SVG logos only), 13–14 requests per page. This is an excellent starting point for "engineered for speed."
- **Core Web Vitals: all green except one borderline.** LCP < 2.5 s on 6/7 pages; CLS = 0 everywhere except `/` (0.076, still passing). `/wall/` LCP is 2,582 ms — 82 ms over the threshold, flagged below.
- **Score drags are environmental or structural, not content:**
  - `/` score 72: caused by the bot-challenge scripts (TBT 1,560 ms from challenge evaluation). Not a real-user issue.
  - `/events/` score 86: TBT 560 ms from client-side rendering (the page fetches event data from the API and lays out on load: 707 ms style & layout).
  - `/blog/one-person-business` LCP 2,152 ms: close to the threshold; the post template renders comments/turnstile widgets below the fold but the LCP element (likely the headline) waits on the full render.

## Known measurement limits

1. Lab (simulated) throttling, not field data. Real-user CrUX data is the source of truth once traffic exists.
2. INP cannot be measured without interaction; needs field data or scripted flows.
3. One run per page — no variance data. Budgets below assume ±10% run-to-run noise.
4. Bot-challenge artifact on two runs (marked `*`); true weights are ~125 KB.
