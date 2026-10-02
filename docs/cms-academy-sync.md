# CMS to Academy Sync — Design Note

**Status:** Documented 2026-10-02. Not yet implemented.

## The gap

Decap CMS has two collections:
- **Blog posts** → writes Markdown to `site/src/content/blog/` → picked up by Astro at build time. ✅ Works.
- **Courses** → writes Markdown to `site/src/content/courses/` → **NOT** picked up by the Academy. ❌ Broken.

The Academy (`/api/courses/*`, `/academy/*`) reads from D1 tables (`courses`, `modules`, `lessons`), not from Markdown files. So editing a course in the CMS has no effect on the live Academy.

## Options

### Option A: CMS writes to D1 via API (recommended)
Add a Decap custom backend or a GitHub Action that:
1. Watches for commits to `site/src/content/courses/*.md`
2. Parses the Markdown frontmatter + body
3. Upserts into D1 `courses` / `modules` / `lessons` tables via the API

**Pros:** Single source of truth in the CMS; Academy stays D1-backed (fast queries, progress tracking).
**Cons:** Requires a GitHub Action + API token; some complexity.

### Option B: Academy reads from Markdown at build time
Change the Academy API to read course content from Markdown files instead of D1.

**Pros:** No sync needed; CMS changes flow through automatically.
**Cons:** Loses D1 benefits (dynamic enrolment, progress per-lesson, admin editing); major refactor.

### Option C: Manual sync script (interim)
A CLI script `npm run sync:courses` that reads Markdown and upserts to D1. Run manually after CMS edits.

**Pros:** Simple; works today.
**Cons:** Manual step; founder must remember to run it.

## Recommendation

**Option A** for production. **Option C** as the interim path so the founder can use the CMS now.

## Interim: manual sync

Until Option A is built, after editing courses in the CMS:

```bash
cd ~/workspace/company/website
# Pull the latest CMS commits
git pull origin develop
# Run the sync (to be built)
npm run sync:courses --workspace=api
# Verify
curl https://brimwood-api.adamsayani.workers.dev/api/courses | python3 -m json.tool
```

## Decision needed

Founder to choose: build Option A now, or accept Option C (manual) for launch and automate later.
