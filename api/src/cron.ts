/* Scheduled tasks (T25): publish scheduled posts + weekly digest.
 *
 * Runs on Cloudflare Cron Triggers. Two jobs:
 * 1. Every 15 min: publish posts where status='scheduled' AND published_at <= now.
 * 2. Weekly (Monday 09:00 UTC): digest email to active subscribers with
 *    the week's new published posts + lessons.
 */
import { sendEmail, shell, esc } from "./lib/email";
import { INBOX } from "./lib/email";

export async function handleScheduled(event: ScheduledEvent, env: any) {
  const { DB, RESEND_API_KEY } = env;
  const cron = event.cron;

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
  if (cron === "0 9 * * 1") {
    if (!RESEND_API_KEY) {
      console.error("digest: RESEND_API_KEY not set");
      return;
    }
    // Posts published in the last 7 days.
    const posts = await DB.prepare(
      `SELECT slug, title, excerpt FROM posts
       WHERE status = 'published'
         AND published_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
       ORDER BY published_at DESC LIMIT 5`
    ).all();

    // Lessons published in the last 7 days.
    const lessons = await DB.prepare(
      `SELECT l.slug, l.title, co.slug AS course_slug FROM lessons l
       JOIN modules m ON m.id = l.module_id
       JOIN courses co ON co.id = m.course_id
       WHERE l.status = 'published'
         AND l.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
       ORDER BY l.created_at DESC LIMIT 5`
    ).all();

    const site = env.SITE_URL || "https://brimwoodinnovation.com";
    const postItems = (posts.results as any[])
      .map(
        (p) =>
          `<p style="margin:0 0 12px;"><a href="${site}/blog/${esc(p.slug)}" style="color:#0C9463;font-weight:600;">${esc(p.title)}</a><br><span style="color:#5B6862;font-size:14px;">${esc(p.excerpt)}</span></p>`
      )
      .join("");
    const lessonItems = (lessons.results as any[])
      .map(
        (l) =>
          `<p style="margin:0 0 12px;"><a href="${site}/academy/${esc(l.course_slug)}" style="color:#0C9463;font-weight:600;">${esc(l.title)}</a></p>`
      )
      .join("");

    if (!postItems && !lessonItems) {
      console.log("digest: nothing new this week, skipping");
      return;
    }

    const html = shell(
      "This week at Brimwood",
      "New posts and lessons.",
      (postItems ? "<h2 style='font-size:18px;color:#121A16;'>New posts</h2>" + postItems : "") +
        (lessonItems ? "<h2 style='font-size:18px;color:#121A16;margin-top:24px;'>New lessons</h2>" + lessonItems : "") +
        `<p style="font-size:13px;color:#5B6862;margin-top:24px;"><a href="${site}/api/newsletter/unsubscribe?email={{email}}&token={{token}}" style="color:#5B6862;">Unsubscribe</a></p>`
    );

    // Active subscribers only.
    const subs = await DB.prepare(
      "SELECT email, name, unsub_token FROM newsletter_subscribers WHERE status = 'active'"
    ).all();

    let sent = 0;
    for (const s of (subs.results as any[])) {
      const unsubUrl =
        `${site}/api/newsletter/unsubscribe?email=${encodeURIComponent(s.email)}&token=${encodeURIComponent(s.unsub_token)}`;
      const personalHtml = html
        .replace("{{email}}", encodeURIComponent(s.email))
        .replace("{{token}}", encodeURIComponent(s.unsub_token))
        .replace(
          `${site}/api/newsletter/unsubscribe?email={{email}}&token={{token}}`,
          unsubUrl
        );
      try {
        await sendEmail(RESEND_API_KEY, {
          to: s.email,
          subject: "This week at Brimwood",
          html: personalHtml,
          text: "This week at Brimwood — new posts and lessons. Unsubscribe: " + unsubUrl,
        });
        sent++;
      } catch (e) {
        console.error(`digest: failed for ${s.email}`, e);
      }
      // Gentle pacing: Resend free tier is 3k/month; don't hammer.
      if (sent % 50 === 0) await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`digest: sent to ${sent} subscribers`);

    // Log to audit.
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'digest', ?, ?, 'sent')"
    )
      .bind(crypto.randomUUID(), `${sent} subscribers`, "This week at Brimwood")
      .run();
  }
}
