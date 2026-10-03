---
title: Sample Course
tagline: A format reference for the CMS course sync. Never published.
level: foundations
visibility: members
status: draft
description: |
  This is a **sample** course. It documents the Markdown format that Decap CMS
  writes and that `api/scripts/sync-courses.mjs` parses.

  It stays in `draft` so it never appears on the public site. Safe to delete
  once real courses are authored in the Content Studio.
modules:
  - title: Getting started
    lessons:
      - title: Welcome
        body: |
          Welcome to the sample lesson.

          Short sentences. Canadian spelling. No hype.
        is_preview: true
        status: published
        duration_minutes: 5
      - title: Second lesson
        body: |
          A members-only lesson. The sync keeps lesson ids stable across
          re-syncs, so member progress is preserved.
        is_preview: false
        status: draft
        duration_minutes: 10
        video_r2_key: ""
---
