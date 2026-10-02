# Brimwood Website — Backup & Rollback Runbook

Last verified: 2026-10-02

## D1 Database Backups

**Database:** `brimwood_db_v2` (`e8c57b50-ae14-4773-ab9b-08172c6609a6`)
**Account:** `0721f0b5175c685d56651e435d9a14dc`

### Automatic protection
- D1 automatically replicates data across Cloudflare's network.
- D1 Time Travel (point-in-time recovery) retains 30 days on paid plans.

### Manual backup (run before any risky change)
```bash
cd ~/workspace/company/website/api
CLOUDFLARE_API_TOKEN="<token>" CLOUDFLARE_ACCOUNT_ID=0721f0b5175c685d56651e435d9a14dc \
  ./node_modules/.bin/wrangler d1 export brimwood_db_v2 --remote \
  --output=/tmp/brimwood_backup_$(date +%Y%m%d).sql
```

### Restore from backup
```bash
# 1. Confirm the backup file is valid SQL (spot-check tables)
# 2. Execute against remote (DESTRUCTIVE — drops and recreates)
CLOUDFLARE_API_TOKEN="<token>" CLOUDFLARE_ACCOUNT_ID=0721f0b5175c685d56651e435d9a14dc \
  ./node_modules/.bin/wrangler d1 execute brimwood_db_v2 --remote \
  --file=/tmp/brimwood_backup_YYYYMMDD.sql
```

**WARNING:** Always use `--remote`. Without it, wrangler targets a local D1 silently.

## Worker Rollback

Every deploy creates a new version. To roll back:

1. Go to Cloudflare Dashboard → Workers & Pages → `brimwood-api` → Deployments
2. Find the previous known-good version ID
3. Click "Rollback to this version"

Or via API:
```bash
# List recent versions, then promote a previous one
curl -s "https://api.cloudflare.com/client/v4/accounts/0721f0b5175c685d56651e435d9a14dc/workers/scripts/brimwood-api/versions" \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -30
```

Known-good versions:
- `ea039e05-1b0b-4323-909b-10efd00914ea` — 2026-10-02, security headers + Turnstile
- `b3f3b508-1485-4921-bb4a-0770b6b93602` — 2026-10-02, Turnstile verification
- `7236c0cd-982a-4001-806b-45da1c5679d2` — 2026-10-02, OAuth hardening

## Pages Rollback

1. Cloudflare Dashboard → Workers & Pages → `brimwood-website-preview` → Deployments
2. Click "Rollback" on a previous deployment

## Secrets Rotation

If a secret is exposed:
```bash
cd ~/workspace/company/website/api
printf '%s' '<new-value>' | CLOUDFLARE_API_TOKEN="<token>" \
  CLOUDFLARE_ACCOUNT_ID=0721f0b5175c685d56651e435d9a14dc \
  ./node_modules/.bin/wrangler secret put <SECRET_NAME>
# Then redeploy to pick up the new secret
./node_modules/.bin/wrangler deploy
```

Secrets to rotate (exposed in chat 2026-10-02):
- [ ] Cloudflare API token
- [ ] Resend API key (`brimwood-api` sending key)

## Emergency Contacts
- Founder: via this chat
- Cloudflare status: https://www.cloudflarestatus.com/
