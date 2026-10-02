# Cloudflare bootstrap runbook (T2)

**Account:** `Adamsayani@outlook.com's Account` (`0721f0b5175c685d56651e435d9a14dc`)
**Cost:** C$0 — D1, KV and R2 free tiers only. No paid upgrade without founder approval.

## 1. Authenticate wrangler

```bash
wrangler login
```

Opens a browser OAuth flow — the **founder** completes it (owner identity
`adamsayani@outlook.com`). Verify:

```bash
wrangler whoami
```

## 2. Create resources (all free tier)

```bash
# D1 database
wrangler d1 create brimwood_db

# KV namespaces
wrangler kv:namespace create NEWSLETTER_KV
wrangler kv:namespace create RATE_LIMIT_KV

# R2 bucket
wrangler r2 bucket create brimwood-media
```

Record the returned IDs below, then wire them into `api/wrangler.toml` (T8).

## Resource IDs

| Resource | Name | ID |
|---|---|---|
| D1 | `brimwood_db` | `b183738d-bd59-4198-a918-e3303516ed85` |
| KV | `NEWSLETTER_KV` | `ec0746dc3e924a00b601f6b83f6dea57` |
| KV | `RATE_LIMIT_KV` | `5e5c7b6a74c14f6ca2969b587797daa9` |
| R2 | `brimwood-media` | `brimwood-media` (name; Standard class, public access disabled) |

Created 2026-10-01 via dashboard by the account owner (the assistant's
browser session was owner-signed-in at the time). All free tier, defaults.
Existing resources untouched: `brimwood-coming-soon` Pages project,
`brimwood-introduction` Worker, `brimwood-newsletter` KV namespace, DNS/SSL.

Note: `wrangler login` OAuth was abandoned (browser-takeover disconnects ×2).
CLI auth still pending — an API token will be needed for `wrangler deploy`
and `d1 migrations apply --remote` (later tasks). The IDs above are enough
for `api/wrangler.toml` bindings (T8).

## Production-safety

- This creates **new** resources only. It does not touch the live
  `brimwood-introduction` Worker, its KV bindings, its secrets, or the
  `brimwood-coming-soon` Pages project.
- The live v7 site stays up until the founder explicitly approves cutover (T34).

## Pages preview project (T4)

- Project: `brimwood-website-preview` → https://brimwood-website-preview.pages.dev
- Connected to GitHub repo `Brimwood-Innovation/brimwood-website`
  (Cloudflare Workers and Pages GitHub App installed on the org, all repos).
- Production branch: `develop`. Build: root `site`, `npm run build`, output `dist`.
- Preview deployments: ON for all non-production branches (PR previews automatic).
- No custom domain attached. `brimwood-coming-soon` (production) untouched.
- First build failed as expected — `site/` scaffold lands in T7.
