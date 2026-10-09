/* Scheduled tasks (T25, T33): publish scheduled posts + weekly digest + health monitoring.
 *
 * Runs on Cloudflare Cron Triggers. Three jobs:
 * 1. Every 15 min: publish posts where status='scheduled' AND published_at <= now.
 * 2. Weekly (Monday 09:00 UTC): digest email to active subscribers with
 *    the week's new published posts + lessons.
 * 3. Every 5 min: health check — ping key endpoints, log to D1,
 *    email the founder on failure.
 */
import { sendEmail, shell, esc } from "./lib/email";
import { INBOX } from "./lib/email";

/** Digest body for one subscriber — unsubUrl is fully built by the caller. */
export function digestBody(
  postItems: string,
  lessonItems: string,
  unsubUrl: string,
  items: { posts: { title: string; url: string }[]; lessons: { title: string; url: string }[] }
): { html: string; text: string } {
  const html = shell(
    "This week at Brimwood",
    "New posts and lessons.",
    (postItems ? "<h2 style='font-size:18px;color:#121A16;'>New posts</h2>" + postItems : "") +
      (lessonItems ? "<h2 style='font-size:18px;color:#121A16;margin-top:24px;'>New lessons</h2>" + lessonItems : "") +
      '<p style="font-size:13px;color:#5B6862;margin-top:24px;"><a href="' + esc(unsubUrl) + '" style="color:#5B6862;">Unsubscribe</a></p>'
  );
  const lines: string[] = ["This week at Brimwood"];
  if (items.posts.length) {
    lines.push("", "New posts:");
    for (const p of items.posts) lines.push(" - " + p.title + "\n   " + p.url);
  }
  if (items.lessons.length) {
    lines.push("", "New lessons:");
    for (const l of items.lessons) lines.push(" - " + l.title + "\n   " + l.url);
  }
  lines.push("", "Unsubscribe: " + unsubUrl);
  return { html, text: lines.join("\n") };
}

export async function handleScheduled(event: ScheduledEvent, env: any) {
  const { DB, RESEND_API_KEY } = env;
  const cron = event.cron;

  // Job 3: health monitoring (runs every 5 min).
  if (cron === "*/5 * * * *") {
    await runHealthCheck(DB, RESEND_API_KEY, env);
    return;
  }

  // Job 1: publish due scheduled posts (runs every 15 min).
  if (cron === "*/15 * * * *") {
    const due = await DB.prepare(
      `SELECT id, slug, title FROM posts
       WHERE status = 'scheduled' AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).all();
    for (const p of (due.results as any[])) {
      await DB.prepare("UPDATE posts SET status = 'published' WHERE id = ?")
        .bind(p.id)
        .run();
      console.log(`published scheduled post: ${p.slug}`);
    }
    return;
  }

  // Job 2: weekly digest (Monday 09:00 UTC).
  // Idempotency: cron triggers are at-least-once. One row per subscriber per
  // digest run is INSERT OR IGNOREd into digest_sends BEFORE sending; a retry
  // after a partial send skips rows already recorded (see 0012_digest_sends.sql).
  if (cron === "0 9 * * 1") {
    if (!RESEND_API_KEY) {
      console.error("digest: RESEND_API_KEY not set");
      return;
    }
    // Digest id = the Monday (UTC) of this week, e.g. 'digest-2026-10-05'.
    const nowUtc = new Date();
    const mondayOffset = (nowUtc.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = new Date(
      Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() - mondayOffset)
    );
    const digestId = "digest-" + monday.toISOString().slice(0, 10);
    // Posts published in the last 7 days.
    const posts = await DB.prepare(
      `SELECT slug, title, excerpt FROM posts
       WHERE status = 'published'
         AND published_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
       ORDER BY published_at DESC LIMIT 5`
    ).all();

    // Lessons published in the last 7 days.
    const lessons = await DB.prepare(
      `SELECT l.id, l.slug, l.title, co.slug AS course_slug FROM lessons l
       JOIN modules m ON m.id = l.module_id
       JOIN courses co ON co.id = m.course_id
       WHERE l.status = 'published'
         AND l.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
       ORDER BY l.created_at DESC LIMIT 5`
    ).all();

    const site = env.SITE_URL || "https://brimwoodinnovation.com";
    const postRows = posts.results as any[];
    const lessonRows = lessons.results as any[];
    const postItems = postRows
      .map(
        (p) =>
          `<p style="margin:0 0 12px;"><a href="${site}/blog/${esc(p.slug)}" style="color:#0C9463;font-weight:600;">${esc(p.title)}</a><br><span style="color:#5B6862;font-size:14px;">${esc(p.excerpt)}</span></p>`
      )
      .join("");
    const lessonItems = lessonRows
      .map(
        (l) =>
          `<p style="margin:0 0 12px;"><a href="${site}/academy/${esc(l.course_slug)}/${esc(l.id)}" style="color:#0C9463;font-weight:600;">${esc(l.title)}</a></p>`
      )
      .join("");
    const postList = postRows.map((p) => ({ title: p.title, url: `${site}/blog/${p.slug}` }));
    const lessonList = lessonRows.map((l) => ({
      title: l.title,
      url: `${site}/academy/${l.course_slug}#${l.slug}`,
    }));

    if (!postItems && !lessonItems) {
      console.log("digest: nothing new this week, skipping");
      return;
    }

    // Active subscribers only.
    const subs = await DB.prepare(
      "SELECT email, name, unsub_token FROM newsletter_subscribers WHERE status = 'active'"
    ).all();

    let sent = 0;
    for (const s of (subs.results as any[])) {
      // Dedupe first: if this subscriber already got this digest run (a retry
      // after a partial send), skip. INSERT OR IGNORE + changes is atomic.
      const claimed = await DB.prepare(
        "INSERT OR IGNORE INTO digest_sends (digest_id, email) VALUES (?, ?)"
      )
        .bind(digestId, s.email)
        .run();
      if (claimed.meta.changes === 0) continue;

      const unsubUrl =
        `${site}/api/newsletter/unsubscribe?email=${encodeURIComponent(s.email)}&token=${encodeURIComponent(s.unsub_token)}`;
      const { html, text } = digestBody(postItems, lessonItems, unsubUrl, {
        posts: postList,
        lessons: lessonList,
      });
      try {
        await sendEmail(RESEND_API_KEY, {
          to: s.email,
          subject: "This week at Brimwood",
          html,
          text,
          // Bulk mail header (RFC 2369). One-click POST (RFC 8058) needs a
          // POST unsubscribe endpoint — flagged for the api-core agent.
          headers: { "List-Unsubscribe": "<" + unsubUrl + ">" },
        });
        sent++;
      } catch (e) {
        console.error("digest: send failed for a subscriber", e);
      }
      // Gentle pacing: Resend free tier is 3k/month; don't hammer.
      if (sent % 50 === 0) await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`digest: sent to ${sent} subscribers`);

    // Log to audit (tagged with the digest run id for traceability).
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'digest', ?, ?, 'sent')"
    )
      .bind(crypto.randomUUID(), `${sent} subscribers (${digestId})`, "This week at Brimwood")
      .run();
  }
}

/* Job 3 (T33): health monitoring.
 * Pings the site + key API endpoints every 5 min. Logs results to D1
 * (health_checks table). On failure, emails the founder once per hour
 * (rate-limited via KV-style timestamp in D1). */
async function runHealthCheck(DB: D1Database, resendKey: string | undefined, env: any) {
  const site = (env.SITE_URL || "https://brimwood-website-preview.pages.dev").replace(/\/$/, "");
  const apiBase = "https://brimwood-api.adamsayani.workers.dev";

  const checks: { name: string; url: string }[] = [
    { name: "site-home", url: site + "/" },
    { name: "api-courses", url: apiBase + "/api/courses" },
    { name: "api-oauth-auth", url: apiBase + "/api/oauth/auth" },
  ];

  const failures: string[] = [];
  for (const check of checks) {
    const start = Date.now();
    try {
      const res = await fetch(check.url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      const ms = Date.now() - start;
      // 2xx, 3xx (redirects like oauth), and 404 (route exists) all count as "up".
      const up = res.status < 500;
      await DB.prepare(
        `INSERT INTO health_checks (id, name, url, status_code, response_ms, ok, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
        .bind(crypto.randomUUID(), check.name, check.url, res.status, ms, up ? 1 : 0)
        .run();
      if (!up) failures.push(`${check.name} → HTTP ${res.status}`);
    } catch (e) {
      const ms = Date.now() - start;
      await DB.prepare(
        `INSERT INTO health_checks (id, name, url, status_code, response_ms, ok, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
        .bind(crypto.randomUUID(), check.name, check.url, 0, ms, 0)
        .run();
      failures.push(`${check.name} → ${String((e as Error)?.message || e).slice(0, 100)}`);
    }
  }

  // Prune old checks (keep 7 days).
  await DB.prepare(
    "DELETE FROM health_checks WHERE checked_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"
  ).run();

  if (failures.length === 0) return;

  // Rate-limit alerts: at most one email per hour.
  const lastAlert = await DB.prepare(
    "SELECT value FROM kv_meta WHERE key = 'last_health_alert'"
  ).first<{ value: string }>().catch(() => null);
  const lastTime = lastAlert ? parseInt(lastAlert.value, 10) : 0;
  if (Date.now() - lastTime < 3600000) return;

  await DB.prepare(
    "INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('last_health_alert', ?)"
  ).bind(String(Date.now())).run().catch(() => {});

  if (!resendKey) {
    console.error("health: failures but RESEND_API_KEY not set", failures);
    return;
  }

  const html = shell(
    "Brimwood health alert",
    "Something needs attention.",
    "<p style=\"margin:0 0 16px;\">Health check failures detected:</p>" +
      "<ul>" + failures.map((f) => "<li>" + esc(f) + "</li>").join("") + "</ul>" +
      '<p style="font-size:13px;color:#5B6862;">Checked at ' + new Date().toISOString() + "</p>"
  );
  try {
    await sendEmail(resendKey, {
      to: INBOX,
      subject: "Brimwood health alert — " + failures.length + " check(s) failing",
      html,
      text: "Brimwood health alert\n\nFailures:\n" + failures.join("\n"),
    });
    console.log("health: alert sent", failures);
  } catch (e) {
    console.error("health: alert email failed", e);
  }
}
