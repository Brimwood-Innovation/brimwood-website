/* Scheduled tasks (T25, T33): publish scheduled posts + the publish queue +
 * event reminders (old path + event_reminders) + weekly digest + health
 * monitoring + the compliance jobs (retention purge S24, deletion
 * completion S20, newsletter issue sends S21).
 *
 * Runs on Cloudflare Cron Triggers. Three jobs:
 * 1. Every 15 min: publish posts where status='scheduled' AND published_at <= now,
 *    run the publish queue (staff-scheduled page/event/course/lesson publishes,
 *    ritual runs, newsletter issue sends), event reminders (RSVP → 24h-before
 *    reminder email + in-app notification, and due event_reminders rows with
 *    quiet-hours suppression), poll-close notifications, and the daily
 *    compliance sweep (retention purge + deletion completions, once per day).
 * 2. Weekly (Monday 09:00 UTC): digest email to active subscribers with
 *    the week's new published posts + lessons.
 * 3. Every 5 min: health check - ping key endpoints, log to D1,
 *    email the founder on failure.
 */
import { sendEmail, shell, esc } from "./lib/email";
import { INBOX } from "./lib/email";
import { sha256Hex } from "./lib/validate";
import { pruneSessions } from "./lib/auth";
import { pruneRateLimits } from "./lib/ratelimit-d1";
import { emitNotification } from "./routes/notifications";
import { isSuppressed, unsubUrlFor } from "./routes/newsletter";

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
async function dispatchPublishRow(env: any, row: any): Promise<void> {
  const DB: D1Database = env.DB;
  const { item_type, item_id, action } = row;

  // Newsletter issue send (item 13, S21): staff-scheduled issues go out to
  // active subscribers here, skipping suppressed addresses. Never faked: a
  // failure marks the queue row failed with the reason.
  if (item_type === "newsletter_issue" && action === "send") {
    await sendNewsletterIssue(env, item_id);
    return;
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
 * Publish queue (item 12, D9): staff-scheduled publishes go live here. Each
 * row is claimed atomically (status pending -> running with attempts + 1),
 * so at-least-once cron retries cannot double-publish. Success marks the
 * row done; any failure marks it failed with the reason (trimmed to 200
 * chars). Best-effort per row; never throws out of the loop.
 */
export async function runPublishQueue(env: any): Promise<number> {
  const DB: D1Database = env.DB;
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
      await dispatchPublishRow(env, row);
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

/** Minimal Markdown subset for newsletter issues: headings, bold, italic,
 * links (http/https only), unordered and ordered lists, paragraphs. All text
 * is HTML-escaped before inline formatting, so raw HTML in the source never
 * reaches the email. */
export function renderMarkdown(md: string): string {
  const inline = (s: string): string => {
    let t = esc(s);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    t = t.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" style="color:#0C9463;">$1</a>'
    );
    return t;
  };
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) {
      out.push(list === "ul" ? "</ul>" : "</ol>");
      list = null;
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      closeList();
      const level = m[1].length;
      out.push(`<h${level} style="color:#121A16;">${inline(m[2])}</h${level}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      out.push(`<p style="margin:0 0 12px;">${inline(line.trim())}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

/**
 * Newsletter issue send (item 13, S21). A publish_queue row
 * (item_type = 'newsletter_issue', action = 'send') lands here after the
 * staff pre-send checklist gate (the 0032 trigger). The audience is
 * snapshotted once into newsletter_sends (one row per active subscriber, so
 * a retry cannot double-send); each recipient is joined against
 * email_suppressions before sending and marked suppressed when listed.
 * Throws on failure; the queue caller records it on the row.
 */
export async function sendNewsletterIssue(env: any, issueId: string): Promise<void> {
  const DB: D1Database = env.DB;
  const resendKey = env.RESEND_API_KEY as string | undefined;
  if (!resendKey) throw new Error("RESEND_API_KEY is not configured");
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  const site = (env.SITE_URL || "https://brimwoodinnovation.com").replace(/\/$/, "");
  const nowIso = new Date().toISOString();

  const issue = await DB.prepare(
    "SELECT id, subject, preview_text, body_md, status FROM newsletter_issues WHERE id = ?"
  )
    .bind(issueId)
    .first<any>();
  if (!issue) throw new Error(`Newsletter issue ${issueId} not found.`);
  if (issue.status === "sent" || issue.status === "cancelled") return; // idempotent
  if (issue.status !== "scheduled" && issue.status !== "sending") {
    throw new Error(`Newsletter issue ${issueId} has status '${issue.status}', not scheduled.`);
  }
  if (issue.status === "scheduled") {
    // The 0032 checklist trigger guards this transition for staff; the cron
    // path moves it the same way so the state machine stays honest.
    await DB.prepare(
      "UPDATE newsletter_issues SET status = 'sending' WHERE id = ? AND status = 'scheduled'"
    )
      .bind(issueId)
      .run();
  }

  // Snapshot the audience once: active subscribers at send time.
  await DB.prepare(
    `INSERT OR IGNORE INTO newsletter_sends (issue_id, subscriber_id, status)
     SELECT ?, id, 'queued' FROM newsletter_subscribers WHERE status = 'active'`
  )
    .bind(issueId)
    .run();

  const bodyHtml = renderMarkdown(String(issue.body_md || ""));
  const textBody = String(issue.body_md || "");
  let sent = 0;
  let suppressed = 0;

  for (;;) {
    const batch = await DB.prepare(
      `SELECT s.subscriber_id, sub.email, sub.name
       FROM newsletter_sends s
       JOIN newsletter_subscribers sub ON sub.id = s.subscriber_id
       WHERE s.issue_id = ? AND s.status = 'queued' AND s.attempts < 5
       ORDER BY s.subscriber_id ASC LIMIT 50`
    )
      .bind(issueId)
      .all();
    const rows = (batch.results as any[]) || [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const email = String(r.email || "").toLowerCase();
      try {
        // S21: join the suppression list before each send.
        if (await isSuppressed(DB, email)) {
          await DB.prepare(
            "UPDATE newsletter_sends SET status = 'suppressed' WHERE issue_id = ? AND subscriber_id = ?"
          )
            .bind(issueId, r.subscriber_id)
            .run();
          suppressed++;
          continue;
        }
        const unsubUrl = await unsubUrlFor(env, site, email);
        const html = shell(
          issue.subject,
          String(issue.preview_text || "News from Brimwood Innovation."),
          bodyHtml +
            '<p style="font-size:12px;color:#5B6862;margin:24px 0 0;"><a href="' +
            esc(unsubUrl) +
            '" style="color:#5B6862;">Unsubscribe</a></p>'
        );
        const text =
          textBody + "\n\nUnsubscribe: " + unsubUrl;
        const providerId = await sendEmail(resendKey, {
          to: email,
          subject: issue.subject,
          html,
          text,
          headers: {
            "List-Unsubscribe": "<" + unsubUrl + ">",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        await DB.prepare(
          "UPDATE newsletter_sends SET status = 'sent', provider_id = ?, sent_at = ? WHERE issue_id = ? AND subscriber_id = ?"
        )
          .bind(providerId || null, nowIso, issueId, r.subscriber_id)
          .run();
        sent++;
      } catch (e) {
        await DB.prepare(
          "UPDATE newsletter_sends SET status = 'failed', attempts = attempts + 1 WHERE issue_id = ? AND subscriber_id = ?"
        )
          .bind(issueId, r.subscriber_id)
          .run()
          .catch(() => {});
        console.error("newsletter issue send failed for a subscriber:", e);
      }
      if (sent % 50 === 0) await new Promise((r2) => setTimeout(r2, 1000));
    }
  }

  const remaining = await DB.prepare(
    "SELECT COUNT(*) AS n FROM newsletter_sends WHERE issue_id = ? AND status = 'queued'"
  )
    .bind(issueId)
    .first<{ n: number }>();
  if (!remaining || remaining.n === 0) {
    await DB.prepare("UPDATE newsletter_issues SET status = 'sent', sent_at = ? WHERE id = ?")
      .bind(nowIso, issueId)
      .run();
  }
  await DB.prepare(
    "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'newsletter-issue', ?, ?, 'sent')"
  )
    .bind(crypto.randomUUID(), `${sent} sent, ${suppressed} suppressed (issue ${issueId})`, issue.subject)
    .run()
    .catch(() => {});
  console.log(`newsletter issue ${issueId}: sent ${sent}, suppressed ${suppressed}`);
}

/**
 * Retention purge (item 12, S24). Reads retention_policies and deletes rows
 * older than each table's window. audit_log and privacy_breaches are
 * skipped while their no-delete triggers stand (0014, 0035): the purge must
 * never trip them. Table and column names come from our own policy table but
 * are still validated as plain identifiers and checked against
 * sqlite_master, so a bad policy row can only log an error, never inject.
 * Best-effort per table; never throws out of the loop.
 */
const RETENTION_SKIP = new Set(["audit_log", "privacy_breaches"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function runRetentionPurge(DB: D1Database): Promise<Record<string, number>> {
  const purged: Record<string, number> = {};
  const policies = await DB.prepare(
    "SELECT table_name, purge_column, retain_days FROM retention_policies"
  ).all();
  for (const p of ((policies.results as any[]) || [])) {
    const table = String(p.table_name || "");
    const column = String(p.purge_column || "");
    const days = Number(p.retain_days);
    try {
      if (RETENTION_SKIP.has(table)) {
        console.log(`retention purge: skipping ${table} (no-delete trigger stands)`);
        continue;
      }
      if (!IDENT.test(table) || !IDENT.test(column)) {
        console.error(`retention purge: bad identifier in policy row: ${table}.${column}`);
        continue;
      }
      if (!(days >= 1 && days <= 3650)) {
        console.error(`retention purge: bad retain_days for ${table}: ${p.retain_days}`);
        continue;
      }
      const exists = await DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
        .bind(table)
        .first<{ name: string }>();
      if (!exists) {
        console.error(`retention purge: unknown table ${table}`);
        continue;
      }
      const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
      const res = await DB.prepare(`DELETE FROM "${table}" WHERE "${column}" < ?`)
        .bind(cutoff)
        .run();
      const n = res.meta.changes || 0;
      purged[table] = n;
      console.log(`retention purge: ${table}: ${n} rows older than ${days}d`);
    } catch (e) {
      console.error(`retention purge failed for ${table}:`, e);
    }
  }
  return purged;
}

/** Best-effort Resend contact deletion (S20). The newsletter list lives in
 * D1, not in a Resend audience, so without a configured audience id there
 * is nothing to delete; that case is logged, not faked. */
async function deleteResendContact(
  resendKey: string | undefined,
  audienceId: string | undefined,
  email: string
): Promise<void> {
  if (!resendKey || !audienceId) {
    console.log("deletion: no Resend audience configured, skipping contact deletion");
    return;
  }
  const r = await fetch(
    `https://api.resend.com/audiences/${encodeURIComponent(audienceId)}/contacts/${encodeURIComponent(email)}`,
    {
      method: "DELETE",
      headers: { authorization: "Bearer " + resendKey },
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!r.ok && r.status !== 404) {
    throw new Error(`Resend ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  }
}

/**
 * Complete one account deletion (item 12, S20). The request sat through its
 * 14-day grace (the 0035 triggers refuse early completion or completion after
 * a cancel); this job does the irreversible part:
 * - PII-free tombstone first, so a Time Travel restore can re-apply this
 *   deletion (the re-apply pass in runDeletionCompletions reads tombstones).
 * - Consent rows keep their CASL proof: the member link goes to NULL (the
 *   append-only trigger allows only that) while the hashed email stays.
 * - The member row is anonymised in place: PII nulled, email replaced with a
 *   non-routable placeholder (the column is NOT NULL UNIQUE), status moved to
 *   suspended and deleted_at stamped. Suspended is already excluded by every
 *   status = 'active' filter, so no query changes are needed; staff tooling
 *   renders "Deleted" from deleted_at (migration 0037).
 * - Sessions, passkeys, devices, owned media (R2 objects then rows), data
 *   exports, profile rows and push subscriptions are deleted; certificates
 *   are withdrawn (they stay verifiable as withdrawn); the Resend contact is
 *   removed best-effort.
 * - When the member asked for it (delete_content), their posts, comments and
 *   stories go too (feed children cascade off feed_posts).
 * There is no member OAuth table (oauth.ts is the Decap operator flow, kept
 * per the item-16 decision), so that S20 line is a no-op here.
 * Best-effort per substep; throws only on the core anonymisation so the
 * caller can record the failure on the request row.
 */
export async function completeDeletion(
  env: any,
  userId: string,
  deleteContent: boolean
): Promise<void> {
  const DB: D1Database = env.DB;
  const nowIso = new Date().toISOString();
  const user = await DB.prepare("SELECT id, email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string }>();
  if (!user) {
    console.log(`deletion: user ${userId} already gone, nothing to do`);
    return;
  }
  const email = String(user.email || "").toLowerCase();
  const emailH = await sha256Hex(email);

  // Tombstone first (S20): PII-free, survives as the re-apply key.
  await DB.prepare("INSERT OR IGNORE INTO deletion_tombstones (subject_hmac) VALUES (?)")
    .bind(emailH)
    .run();

  // Consent proof survives as the hashed email; only the member link is cut.
  try {
    await DB.prepare("UPDATE consent_records SET user_id = NULL WHERE user_id = ?")
      .bind(userId)
      .run();
  } catch (e) {
    console.error("deletion: consent unlink failed for", userId, e);
  }

  // Anonymise the member row (core step: throws on failure).
  await DB.prepare(
    `UPDATE users SET
       email = ?, name = 'Deleted member',
       display_name = NULL, bio = NULL, avatar_key = NULL, avatar_r2_key = NULL,
       username = NULL, username_changed_at = NULL, location = NULL, website = NULL,
       social_links = NULL, work_history = NULL, education = NULL, hobbies = NULL,
       achievements = NULL, dob = NULL, gender = NULL, life_events = NULL,
       profile_visibility = NULL, referral = NULL,
       password_hash = NULL, password_salt = NULL, password_set_at = NULL,
       show_profile = 0, status = 'suspended', deleted_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(`deleted-${userId}@deleted.invalid`, nowIso, nowIso, userId)
    .run();

  const bestEffort = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`deletion: ${label} failed for ${userId}:`, e);
    }
  };

  await bestEffort("sessions", () =>
    DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run()
  );
  // The staff last-passkey trigger can refuse a credential delete; the
  // account is already anonymised above, so this stays best-effort.
  await bestEffort(
    "credentials",
    () => DB.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?").bind(userId).run()
  );
  await bestEffort(
    "user handles",
    () => DB.prepare("DELETE FROM webauthn_user_handles WHERE user_id = ?").bind(userId).run()
  );
  await bestEffort(
    "devices",
    () => DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(userId).run()
  );
  await bestEffort("media", async () => {
    const assets = await DB.prepare("SELECT r2_key FROM media_assets WHERE uploaded_by = ?")
      .bind(userId)
      .all();
    for (const a of ((assets.results as any[]) || [])) {
      try {
        await env.MEDIA?.delete(a.r2_key);
      } catch (e) {
        console.error("deletion: R2 object delete failed:", a.r2_key, e);
      }
    }
    await DB.prepare("DELETE FROM media_assets WHERE uploaded_by = ?").bind(userId).run();
  });
  await bestEffort("exports", async () => {
    const ex = await DB.prepare(
      "SELECT r2_key FROM data_export_requests WHERE user_id = ? AND r2_key IS NOT NULL"
    )
      .bind(userId)
      .all();
    for (const r of ((ex.results as any[]) || [])) {
      try {
        await env.MEDIA?.delete(r.r2_key);
      } catch (e) {
        console.error("deletion: export R2 delete failed:", r.r2_key, e);
      }
    }
    await DB.prepare("DELETE FROM data_export_requests WHERE user_id = ?").bind(userId).run();
  });
  await bestEffort("profile rows", () =>
    DB.batch([
      DB.prepare("DELETE FROM member_profiles WHERE user_id = ?").bind(userId),
      DB.prepare("DELETE FROM member_settings WHERE user_id = ?").bind(userId),
      DB.prepare("DELETE FROM member_skills WHERE user_id = ?").bind(userId),
      DB.prepare("DELETE FROM profile_field_visibility WHERE user_id = ?").bind(userId),
      DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(userId),
    ])
  );
  await bestEffort("certificates", () =>
    DB.prepare(
      `UPDATE certificates SET status = 'withdrawn', status_changed_at = ?,
         status_reason = 'Member deleted their account.'
       WHERE member_id = ? AND status = 'valid'`
    )
      .bind(nowIso, userId)
      .run()
  );
  await bestEffort("resend contact", () =>
    deleteResendContact(env.RESEND_API_KEY, env.RESEND_AUDIENCE_ID, email)
  );

  if (deleteContent) {
    await bestEffort("stories", async () => {
      const st = await DB.prepare("SELECT r2_key FROM stories WHERE author_id = ?")
        .bind(userId)
        .all();
      for (const s of ((st.results as any[]) || [])) {
        try {
          await env.MEDIA?.delete(s.r2_key);
        } catch (e) {
          console.error("deletion: story R2 delete failed:", s.r2_key, e);
        }
      }
      // story_replies and story_views cascade off stories.
      await DB.prepare("DELETE FROM stories WHERE author_id = ?").bind(userId).run();
      await DB.prepare("DELETE FROM story_replies WHERE from_user_id = ?").bind(userId).run();
    });
    await bestEffort("posts", () =>
      // Post media, reactions, polls, comments, mentions and saves cascade
      // off feed_posts; comments the member left on other posts go separately.
      DB.batch([
        DB.prepare("DELETE FROM feed_posts WHERE author_id = ?").bind(userId),
        DB.prepare("DELETE FROM feed_comments WHERE author_id = ?").bind(userId),
      ])
    );
  }

  // The durable proof of completion is deletion_requests.completed_at plus the
  // tombstone row. (security_events.kind has a closed CHECK with no
  // 'deletion_completed' value, and widening it needs a table rebuild.)
  console.log(`deletion: completed for ${userId} (content: ${deleteContent ? "wiped" : "kept"})`);
}

/**
 * Deletion completion sweep (item 12, S20). Completes due deletion requests
 * (grace over, not cancelled, not completed; the 0035 triggers enforce the
 * same rules at the row level), then re-applies every tombstone whose
 * subject somehow has a live member row again - the Time Travel restore
 * case from S20. Best-effort per request; never throws out of the loop.
 */
export async function runDeletionCompletions(env: any): Promise<number> {
  const DB: D1Database = env.DB;
  const nowIso = new Date().toISOString();
  let done = 0;

  const due = await DB.prepare(
    `SELECT id, user_id, delete_content FROM deletion_requests
     WHERE due_at <= ? AND cancelled_at IS NULL AND completed_at IS NULL
     ORDER BY due_at ASC LIMIT 25`
  )
    .bind(nowIso)
    .all();
  for (const row of ((due.results as any[]) || [])) {
    try {
      await completeDeletion(env, row.user_id, row.delete_content === 1);
      await DB.prepare(
        "UPDATE deletion_requests SET completed_at = ? WHERE id = ? AND completed_at IS NULL"
      )
        .bind(nowIso, row.id)
        .run();
      done++;
    } catch (e) {
      console.error("deletion completion failed for request", row.id, e);
    }
  }

  // Tombstone re-apply (S20): after a Time Travel restore, a deleted
  // subject's member row can exist again with its old email. Match live
  // members against tombstones and re-complete them; without an open
  // request the content choice is unknown, so content is kept (the member
  // row is still anonymised, which is the irreversible part).
  try {
    const tombs = await DB.prepare("SELECT subject_hmac FROM deletion_tombstones").all();
    const tombSet = new Set(((tombs.results as any[]) || []).map((r) => String(r.subject_hmac)));
    if (tombSet.size > 0) {
      const live = await DB.prepare(
        "SELECT id, email FROM users WHERE status IN ('active', 'suspended') AND deleted_at IS NULL"
      ).all();
      for (const u of ((live.results as any[]) || [])) {
        const h = await sha256Hex(String(u.email || "").toLowerCase());
        if (!tombSet.has(h)) continue;
        const open = await DB.prepare(
          "SELECT id FROM deletion_requests WHERE user_id = ? AND cancelled_at IS NULL AND completed_at IS NULL"
        )
          .bind(u.id)
          .first<{ id: string }>();
        if (open) continue; // the due-request pass above handles it
        console.log(`deletion: re-applying tombstoned deletion for ${u.id} (post-restore)`);
        try {
          await completeDeletion(env, u.id, false);
        } catch (e) {
          console.error("deletion: tombstone re-apply failed for", u.id, e);
        }
      }
    }
  } catch (e) {
    console.error("deletion: tombstone re-apply pass failed:", e);
  }
  return done;
}

/** Daily compliance sweep: retention purge (S24) then deletion completions
 * (S20), at most once per 24 hours, tracked in kv_meta like the health
 * alert throttle. Runs inside the 15-minute job; never throws. */
export async function runDailyComplianceJobs(env: any): Promise<void> {
  const DB: D1Database = env.DB;
  try {
    const last = await DB.prepare("SELECT value FROM kv_meta WHERE key = 'last_compliance_sweep'")
      .first<{ value: string }>()
      .catch(() => null);
    if (last && Date.now() - parseInt(last.value, 10) < 24 * 3600 * 1000) return;
    await runRetentionPurge(DB);
    await runDeletionCompletions(env);
    await DB.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('last_compliance_sweep', ?)")
      .bind(String(Date.now()))
      .run()
      .catch(() => {});
  } catch (e) {
    console.error("compliance sweep failed:", e);
  }
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
    // Publish queue (item 12): staff-scheduled publishes go live, including
    // newsletter issue sends. Rows record their own failures; this never throws.
    await runPublishQueue(env).catch((e) => console.error("publish queue failed:", e));
    // Poll close notifications (social-UX reconciliation): voters of newly
    // closed polls get one `poll_closed` notification each. Idempotent.
    await sendPollCloseNotifications(DB).catch((e) =>
      console.error("poll close notifications failed:", e)
    );
    // Compliance sweep (item 12, S20/S24): retention purge + deletion
    // completions, at most once per day. Never throws.
    await runDailyComplianceJobs(env).catch((e) =>
      console.error("compliance sweep failed:", e)
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
    // S21: digest unsubscribe links are HMAC-signed (item 13); without the
    // secret they cannot be minted, so fail loudly instead of sending mail
    // with no way out.
    if (!env.SESSION_SECRET) {
      console.error("digest: SESSION_SECRET not set, cannot mint unsubscribe links");
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
      "SELECT email, name FROM newsletter_subscribers WHERE status = 'active'"
    ).all();

    let sent = 0;
    let suppressed = 0;
    for (const s of (subs.results as any[])) {
      // Dedupe first: if this subscriber already got this digest run (a retry
      // after a partial send), skip. INSERT OR IGNORE + changes is atomic.
      const claimed = await DB.prepare(
        "INSERT OR IGNORE INTO digest_sends (digest_id, email) VALUES (?, ?)"
      )
        .bind(digestId, s.email)
        .run();
      if (claimed.meta.changes === 0) continue;

      // S21: the sender joins email_suppressions before each send. The claim
      // above already stands, so a retry will not resend to this address.
      if (await isSuppressed(DB, s.email)) {
        suppressed++;
        continue;
      }
      // Item 13: tokens are stored hashed, so bulk mail mints a signed
      // unsubscribe link instead of recovering the plain token.
      const unsubUrl = await unsubUrlFor(env, site, s.email);
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
    console.log(`digest: sent to ${sent} subscribers, ${suppressed} suppressed`);

    // Log to audit (tagged with the digest run id for traceability).
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'digest', ?, ?, 'sent')"
    )
      .bind(crypto.randomUUID(), `${sent} subscribers, ${suppressed} suppressed (${digestId})`, "This week at Brimwood")
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
