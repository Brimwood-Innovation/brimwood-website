# Environment & secrets strategy (T5)

**Rule: no secret ever enters the git repo.** `.gitignore` blocks `.env`,
`.env.*`, `.dev.vars`, `secrets/`, `*.pem`, `*.key`. CI and builds use
platform secret stores only.

## Local development

- Copy `api/.dev.vars.example` → `api/.dev.vars` and fill values locally.
  `.dev.vars` is gitignored. `wrangler dev` reads it automatically.
- The example file documents every variable with empty values — it is the
  contract of what the API expects.

## Staging / production (Cloudflare)

- Worker secrets: dashboard → Workers & Pages → `brimwood-api` →
  Settings → Variables & Secrets, or `wrangler secret put NAME`
  (needs CLI auth — API token, see `docs/runbooks/cloudflare-bootstrap.md`).
- Pages build-time variables: Pages project → Settings →
  Environment variables (preview vs production scopes).
- Never paste a secret into chat, an artifact, or a Markdown file.

## Current secret inventory

| Secret | Used by | Lives in |
|---|---|---|
| `RESEND_API_KEY` | live `brimwood-introduction` Worker (introduction + newsletter mail) | Worker secret (dashboard). Absorbed into `api/` later — the new Worker gets its own key via `wrangler secret put`. |
| `SESSION_SECRET` | future: magic-link session signing (`api/`) | to be created at T14; dashboard secret |
| `TURNSTILE_SECRET_KEY` | future: form bot protection | to be created at T12; dashboard secret |

## Rotation

If a secret is ever suspected exposed: create the replacement in the
dashboard first, `wrangler secret put` / dashboard update, verify, then
delete the old value. The retired `drafts/` files (quarantined, gitignored)
once contained an exposed Web3Forms key — they are never deployed.
