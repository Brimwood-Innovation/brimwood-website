/* Scheduled tasks (T25, T33): publish scheduled posts + the publish queue +
 * event reminders (old path + event_reminders) + weekly digest + health
 * monitoring.
 *
 * Runs on Cloudflare Cron Triggers. Three jobs:
 * 1. Every 15 min: publish posts where status='scheduled' AND published_at <= now,
 *    run the publish queue (staff-scheduled page/event/course/lesson publishes
 *    and ritual runs; newsletter sends stay failed until item 13), event
 *    reminders (RSVP → 24h-before reminder email + in-app notification, and
 *    due event_reminders rows with quiet-hours suppression), and poll-close
 *    notifications.
 * 2. Weekly (Monday 09:00 UTC): digest email to active subscribers with
 *    the week's new published posts + lessons.
 * 3. Every 5 min: health check - ping key endpoints, log to D1,
 *    email the founder on failure.
 *
 * Item 12, messaging half only: the retention purge and the deletion
 * completion job are the compliance cycle's, not this job's.
 */
import { sendEmail, shell, esc } from "./lib/email";
import { INBOX } from "./lib/email";
import { pruneSessions } from "./lib/auth";
import { pruneRateLimits } from "./lib/ratelimit-d1";
import { emitNotification } from "./routes/notifications";

/**
 * Event reminders (audit/social/wiring): for published events starting in
 * roughly 24 hours that have not been reminded yet, email every confirmed
 * RSVP and drop an in-app `event_reminder` notification on the matching
 * member (RSVP email → user). Idempotent via events.reminder_sent_at (0020):
 * at-least-once cron retries cannot re-send.
 */
export async function sendEventReminders(
  DB: D1Database,
  resendKey: string | undefined,
  siteUrl: string
): Promise<number> {
  const nowIso = new Date().toISOString();
  const events = await DB.prepare(
    `SELECT id, slug, title, starts_at, location FROM events
     WHERE status = 'published' AND reminder_sent_at IS NULL
       AND starts_at > ? AND starts_at <= ?
     ORDER BY starts_at ASC LIMIT 25`
  )
    .bind(
      new Date(Date.now() + 23 * 3600 * 1000).toISOString(),
      new Date(Date.now() + 25 * 3600 * 1000).toISOString()
    )
    .all();
  const rows = (events.results as any[]) || [];
  let reminded = 0;

  for (const ev of rows) {
    const rsvps = await DB.prepare(
      `SELECT name, email FROM event_rsvps
       WHERE event_id = ? AND status = 'confirmed'`
    )
      .bind(ev.id)
      .all();
    const when = new Date(ev.starts_at).toLocaleString("en-CA", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Toronto",
    });
    const url = `${siteUrl}/events/${ev.slug}`;

    for (const r of ((rsvps.results as any[]) || [])) {
      // In-app notification for the member behind this RSVP email (best effort).
      try {
        const user = await DB.prepare(
          "SELECT id FROM users WHERE email = ? AND status = 'active'"
        )
          .bind(String(r.email || "").toLowerCase())
          .first<{ id: string }>()
          .catch(() => null);
        if (user) {
          await emitNotification(DB, {
            userId: user.id,
            kind: "event_reminder",
            targetType: "event",
            targetId: ev.slug,
            preview: `Reminder: ${ev.title} starts tomorrow - ${when}.`,
          });
        }
      } catch {}
      // Reminder email (best effort - the in-app row above stands alone).
      if (resendKey) {
        const html = shell(
          "See you tomorrow",
          `Reminder: ${ev.title}`,
          `<p style="margin:0 0 16px;">Hello ${esc(r.name || "there")},</p>` +
            `<p style="margin:0 0 16px;">A reminder that <strong>${esc(ev.title)}</strong> starts tomorrow - ` +
            `${esc(when)}${ev.location ? ` at ${esc(ev.location)}` : ""}.</p>` +
            `<p style="margin:0;font-size:13px;color:#5B6862;"><a href="${esc(url)}" style="color:#0C9463;">Event details</a></p>`
        );
        await sendEmail(resendKey, {
          to: r.email,
          subject: `Tomorrow: ${ev.title} - Brimwood Innovation`,
          html,
          text:
            `Hello ${r.name || "there"},\n\nA reminder that ${ev.title} starts tomorrow - ${when}` +
            `${ev.location ? ` at ${ev.location}` : ""}.\n\nEvent details: ${url}\n\n` +
            `Build a business. Build yourself.\n- Brimwood Innovation`,
        })
          .then(() =>
            DB.prepare(
              "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'rsvp-reminder', ?, ?, 'sent')"
            )
              .bind(crypto.randomUUID(), r.email, `Tomorrow: ${ev.title}`)
              .run()
              .catch(() => {})
          )
          .catch(() => {});
      }
    }

    await DB.prepare("UPDATE events SET reminder_sent_at = ? WHERE id = ?")
      .bind(nowIso, ev.id)
      .run();
    reminded++;
    console.log(`event reminder sent for: ${ev.slug}`);
  }
  return reminded;
}

/**
 * True when `now` falls inside the [start, end) wall-clock window in `tz`.
 * Wrap-around aware: a window like 22:00-08:00 spans midnight. start/end are
 * 'HH:MM' strings (member_settings quiet_start/quiet_end). An unknown
 * timezone never suppresses - better a reminder than a guess.
 */
export function inQuietHours(now: Date, start: string, end: string, tz: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    let hh = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
    if (hh === "24") hh = "00"; // midnight in some hour cycles
    const cur = `${hh}:${mm}`;
    if (start <= end) return cur >= start && cur < end;
    return cur >= start || cur < end;
  } catch {
    return false;
  }
}

/**
 * Event reminders, messaging half of item 12 (audit/social/wiring): rows in
 * `event_reminders` whose due_at has passed get one reminder email plus one
 * in-app `event_reminder` notification each. Quiet hours (C23) live in
 * member_settings: a due reminder inside the member's quiet window is marked
 * suppressed ('quiet_hours') instead of sent. 'opted_out' and 'cancelled'
 * reasons are written by the RSVP/events code, never here. Rows whose member
 * or event is gone are marked sent so they stop being due.
 * Best-effort per row; never throws out of the loop.
 */
export async function sendDueReminders(
  DB: D1Database,
  resendKey: string | undefined,
  siteUrl: string
): Promise<number> {
  const nowIso = new Date().toISOString();
  const due = await DB.prepare(
    `SELECT id, event_id, user_id, offset_minutes FROM event_reminders
     WHERE sent_at IS NULL AND suppressed_reason IS NULL AND due_at <= ?
     ORDER BY due_at ASC LIMIT 50`
  )
    .bind(nowIso)
    .all();
  let sent = 0;

  for (const row of ((due.results as any[]) || [])) {
    try {
      const ev = await DB.prepare(
        "SELECT id, slug, title, starts_at, location FROM events WHERE id = ?"
      )
        .bind(row.event_id)
        .first<any>();
      const user = await DB.prepare(
        "SELECT id, email, name FROM users WHERE id = ? AND status = 'active'"
      )
        .bind(row.user_id)
        .first<any>();
      if (!ev || !user) {
        await DB.prepare("UPDATE event_reminders SET sent_at = ? WHERE id = ?")
          .bind(nowIso, row.id)
          .run();
        continue;
      }
      // Schema defaults (0025) when the member never opened settings.
      const settings =
        (await DB.prepare(
          "SELECT quiet_enabled, quiet_start, quiet_end, tz FROM member_settings WHERE user_id = ?"
        )
          .bind(row.user_id)
          .first<any>()) || {
          quiet_enabled: 1,
          quiet_start: "22:00",
          quiet_end: "08:00",
          tz: "America/Toronto",
        };
      if (
        settings.quiet_enabled === 1 &&
        inQuietHours(new Date(), settings.quiet_start, settings.quiet_end, settings.tz)
      ) {
        await DB.prepare("UPDATE event_reminders SET suppressed_reason = 'quiet_hours' WHERE id = ?")
          .bind(row.id)
          .run();
        console.log(`event reminder suppressed (quiet hours): ${row.id}`);
        continue;
      }

      const soon = row.offset_minutes === 60 ? "in one hour" : "tomorrow";
      const when = new Date(ev.starts_at).toLocaleString("en-CA", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Toronto",
      });
      const url = `${siteUrl}/events/${ev.slug}`;

      if (resendKey) {
        const html = shell(
          "Event reminder",
          `Reminder: ${ev.title}`,
          `<p style="margin:0 0 16px;">Hello ${esc(user.name || "there")},</p>` +
            `<p style="margin:0 0 16px;">A reminder that <strong>${esc(ev.title)}</strong> starts ${esc(soon)} - ` +
            `${esc(when)}${ev.location ? ` at ${esc(ev.location)}` : ""}.</p>` +
            `<p style="margin:0;font-size:13px;color:#5B6862;"><a href="${esc(url)}" style="color:#0C9463;">Event details</a></p>`
        );
        await sendEmail(resendKey, {
          to: user.email,
          subject: `Reminder: ${ev.title} - Brimwood Innovation`,
          html,
          text:
            `Hello ${user.name || "there"},\n\nA reminder that ${ev.title} starts ${soon} - ${when}` +
            `${ev.location ? ` at ${ev.location}` : ""}.\n\nEvent details: ${url}\n\n` +
            `Build a business. Build yourself.\n- Brimwood Innovation`,
        })
          .then(() =>
            DB.prepare(
              "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'event-reminder', ?, ?, 'sent')"
            )
              .bind(crypto.randomUUID(), user.email, `Reminder: ${ev.title}`)
              .run()
              .catch(() => {})
          )
          .catch(() => {});
      }

      await emitNotification(DB, {
        userId: user.id,
        kind: "event_reminder",
        targetType: "event",
        targetId: ev.slug,
        preview: `Reminder: ${ev.title} starts ${soon} - ${when}.`,
      });

      await DB.prepare("UPDATE event_reminders SET sent_at = ? WHERE id = ?")
        .bind(nowIso, row.id)
        .run();
      sent++;
      console.log(`event reminder sent: ${row.id}`);
    } catch (e) {
      console.error("event reminder row failed:", row?.id, e);
    }
  }
  return sent;
}

/** One claimed publish_queue row. Throws on failure; the caller records it. */
async function dispatchPublishRow(DB: D1Database, row: any): Promise<void> {
  const { item_type, item_id, action } = row;

  // The newsletter send machinery is item 13 (compliance cycle): never fake
  // a send. The row fails with a requeue note for the item-13 cycle.
  if (item_type === "newsletter_issue" && action === "send") {
    throw new Error("Newsletter send lands with item 13; requeue after that item ships.");
  }

  // D9: each ritual run inserts one feed post from the ritual's own copy.
  if (item_type === "ritual_run") {
    if (action !== "publish") throw new Error(`Unsupported action '${action}' for ritual_run.`);
    const ritual = await DB.prepare(
      "SELECT id, title, body_template, group_id, author_id FROM rituals WHERE id = ?"
    )
      .bind(item_id)
      .first<any>();
    if (!ritual) throw new Error(`Ritual ${item_id} not found.`);
    await DB.prepare(
      `INSERT INTO feed_posts (id, author_id, body, intent, audience, group_id, ritual_id)
       VALUES (?, ?, ?, 'ritual', ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        ritual.author_id,
        `${ritual.title}\n\n${ritual.body_template}`,
        ritual.group_id ? "group" : "members",
        ritual.group_id || null,
        ritual.id
      )
      .run();
    return;
  }

  // Closed map: page/event/course/lesson -> their table. Only the status
  // value is bound; the table name never comes from input.
  const tables: Record<string, string> = {
    page: "pages",
    event: "events",
    course: "courses",
    lesson: "lessons",
  };
  const table = tables[item_type];
  if (!table) throw new Error(`Unknown item_type '${item_type}'.`);
  let status: string;
  if (action === "publish") status = "published";
  else if (action === "unpublish") status = "draft";
  else throw new Error(`Unknown action '${action}' for ${item_type}.`);
  const upd = await DB.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`)
    .bind(status, item_id)
    .run();
  if ((upd.meta.changes || 0) === 0) throw new Error(`${item_type} ${item_id} not found.`);
}

/**
 * Publish queue, messaging half of item 12 (D9): staff-scheduled publishes
 * go live here. Each row is claimed atomically (status pending -> running
 * with attempts + 1), so at-least-once cron retries cannot double-publish.
 * Success marks the row done; any failure marks it failed with the reason
 * (trimmed to 200 chars). Best-effort per row; never throws out of the loop.
 *
 * Explicitly out of scope this cycle: the retention purge and the deletion
 * completion job (compliance cycle).
 */
export async function runPublishQueue(DB: D1Database): Promise<number> {
  const nowIso = new Date().toISOString();
  const due = await DB.prepare(
    `SELECT id, item_type, item_id, action, attempts FROM publish_queue
     WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 20`
  )
    .bind(nowIso)
    .all();
  let done = 0;

  for (const row of ((due.results as any[]) || [])) {
    try {
      const claimed = await DB.prepare(
        "UPDATE publish_queue SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending'"
      )
        .bind(row.id)
        .run();
      if ((claimed.meta.changes || 0) === 0) continue; // taken by another worker
      await dispatchPublishRow(DB, row);
      await DB.prepare("UPDATE publish_queue SET status = 'done', finished_at = ? WHERE id = ?")
        .bind(nowIso, row.id)
        .run();
      done++;
      console.log(`publish queue done: ${row.item_type}/${row.action} ${row.item_id}`);
    } catch (e) {
      const msg = String((e as Error)?.message || e).slice(0, 200);
      await DB.prepare("UPDATE publish_queue SET status = 'failed', last_error = ? WHERE id = ?")
        .bind(msg, row.id)
        .run()
        .catch(() => {});
      console.error("publish queue row failed:", row?.id, msg);
    }
  }
  return done;
}

/**
 * Poll close notifications (social-UX reconciliation): for polls whose
 * closes_at has passed and which have not been notified yet, drop a
 * `poll_closed` in-app notification on every voter, then mark the poll.
 * Idempotent via polls.notified_closed_at (0021): at-least-once cron
 * retries cannot re-notify.
 */
export async function sendPollCloseNotifications(DB: D1Database): Promise<number> {
  const nowIso = new Date().toISOString();
  const polls = await DB.prepare(
    `SELECT id, post_id, question FROM polls
     WHERE closes_at <= ? AND notified_closed_at IS NULL`
  )
    .bind(nowIso)
    .all();
  let notified = 0;
  for (const poll of (polls.results as any[])) {
    const voters = await DB.prepare(
      "SELECT DISTINCT voter_id FROM poll_votes WHERE poll_id = ?"
    )
      .bind(poll.id)
      .all();
    for (const v of (voters.results as any[])) {
      await emitNotification(DB, {
        userId: v.voter_id,
        kind: "poll_closed",
        actorId: null,
        targetType: "poll",
        targetId: poll.post_id,
        preview: `Results are in: ${(poll.question || "").slice(0, 200)}`,
      }).catch(() => {});
    }
    await DB.prepare("UPDATE polls SET notified_closed_at = ? WHERE id = ?")
      .bind(nowIso, poll.id)
      .run();
    notified++;
  }
  return notified;
}

/** Digest body for one subscriber - unsubUrl is fully built by the caller. */
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
    // Hygiene: expired sessions and stale rate-limit rows would otherwise
    // accumulate forever (rate-limit keys are attacker-controlled), so prune
    // both on the same cadence.
    await pruneSessions(env);
    await pruneRateLimits(DB);
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
    // Event reminders ride the same 15-minute cadence (audit/social/wiring):
    // RSVP → reminder, 24h before each published event. Idempotent.
    // events.reminder_sent_at is in the merged schema (0020), so this older
    // path stays alongside the event_reminders-based job below.
    await sendEventReminders(
      DB,
      RESEND_API_KEY,
      env.SITE_URL || "https://brimwoodinnovation.com"
    ).catch((e) => console.error("event reminders failed:", e));
    // Event reminders, new path (item 12, messaging half): due
    // event_reminders rows get one email + one in-app notification each,
    // honouring quiet hours. Best-effort per row.
    await sendDueReminders(
      DB,
      RESEND_API_KEY,
      env.SITE_URL || "https://brimwoodinnovation.com"
    ).catch((e) => console.error("due event reminders failed:", e));
    // Publish queue (item 12, messaging half): staff-scheduled publishes go
    // live. Rows record their own failures; this never throws.
    await runPublishQueue(DB).catch((e) => console.error("publish queue failed:", e));
    // Poll close notifications (social-UX reconciliation): voters of newly
    // closed polls get one `poll_closed` notification each. Idempotent.
    await sendPollCloseNotifications(DB).catch((e) =>
      console.error("poll close notifications failed:", e)
    );
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
          // POST unsubscribe endpoint - flagged for the api-core agent.
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
      subject: "Brimwood health alert - " + failures.length + " check(s) failing",
      html,
      text: "Brimwood health alert\n\nFailures:\n" + failures.join("\n"),
    });
    console.log("health: alert sent", failures);
  } catch (e) {
    console.error("health: alert email failed", e);
  }
}
