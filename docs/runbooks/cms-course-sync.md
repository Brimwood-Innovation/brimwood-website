# CMS → D1 Course Sync

How Decap CMS course edits reach the live Academy.

## How it works

1. An editor changes a course in the Content Studio (`/cms/` → Courses).
   Decap commits Markdown to `site/src/content/courses/<slug>.md` on GitHub.
2. The push triggers `.github/workflows/sync-courses.yml` (on `develop` and
   `main`, only when course Markdown changed).
3. The Action runs `api/scripts/sync-courses.mjs`, which parses the Markdown
   and POSTs it to the worker endpoint `POST /api/admin/sync/courses`.
4. The worker upserts the content into the D1 Academy tables
   (`courses`, `modules`, `lessons`). The Academy reads from D1, so the site
   updates on the next deploy — no developer needed.

## Sync semantics

- Courses are keyed by **slug** (the Markdown filename). Editing a course
  updates it in place; the id never changes.
- Modules are reconciled **by position**. Reorder modules in the CMS and the
  order updates. Removed modules (and their lessons) are deleted.
- Lessons are reconciled **by slug** (generated from the lesson title) within
  each module. Lesson ids stay stable across re-syncs, so member progress in
  `lesson_progress` is preserved. Removed lessons are deleted.
- A course in `draft` status never appears on the site; the Academy only
  serves `published` courses and lessons.

## Setup (one time)

Two secrets must exist and **match**. The value itself is chosen by the
founder — never commit it.

1. **Worker secret** (so the endpoint accepts the sync):
   ```bash
   cd ~/workspace/company/website/api
   printf '%s' '<choose-a-long-random-value>' | \
     CLOUDFLARE_API_TOKEN="<token>" CLOUDFLARE_ACCOUNT_ID=0721f0b5175c685d56651e435d9a14dc \
     ./node_modules/.bin/wrangler secret put SYNC_SECRET
   ```
   Then redeploy the worker so the new secret takes effect.

2. **GitHub repo secret** (so the Action can authenticate):
   Repo → Settings → Secrets and variables → Actions → New repository secret.
   Name: `SYNC_SECRET`. Value: the same value as step 1.

Until both are set, the Action will fail with `sync failed (HTTP 403)`.

## Manual sync

```bash
cd ~/workspace/company/website
WORKER_URL=https://brimwood-api.adamsayani.workers.dev \
SYNC_SECRET='<value>' \
node api/scripts/sync-courses.mjs
```

Preview what would be sent without touching D1:

```bash
node api/scripts/sync-courses.mjs --dry-run
```

## Troubleshooting

- **Action fails with 403**: the secrets do not match, or the worker was not
  redeployed after setting the secret.
- **Action fails with 400**: a course is missing a slug/title, or a lesson is
  missing a title. The error names the offending entry.
- **A lesson vanished**: its title (hence slug) was renamed in the CMS. The
  old slug was deleted and the new one inserted — member progress on the old
  id is orphaned. Prefer editing lesson bodies over renaming titles.
- **Nothing happens on push**: the Action only runs when files under
  `site/src/content/courses/` changed on `develop` or `main`.
