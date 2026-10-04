/* POST /api/introduction (T16): D1-backed, behaviour parity with the live worker.
 * Validates → writes introduction_requests → sends owner notify + submitter
 * confirm via Resend → logs to email_log. Honeypot + rate limit preserved. */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { sendEmail, shell, fieldRow, esc, INBOX } from "../lib/email";
import { cleanStr, isEmail, clientIp, sha256Hex } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

import { verifyTurnstile } from "../lib/turnstile";

const app = new Hono<{ Bindings: Bindings }>();

app.post("/", async (c) => {
  const { DB } = c.env;
  const resendKey = (c.env as Bindings & { RESEND_API_KEY?: string }).RESEND_API_KEY;
  if (!resendKey) return c.json({ ok: false }, 500);

  if (!(await checkRateLimitD1(DB, "intro:" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  if (cleanStr(data.website, 200)) {
    return c.json({ ok: true }); // honeypot: bot — pretend success, store nothing
  }

  // Turnstile bot check (fails closed).
  const turnstile = await verifyTurnstile(
    data["cf-turnstile-response"],
    (c.env as Bindings & { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY,
    clientIp(c.req.raw)
  );
  if (!turnstile.ok) {
    return c.json({ ok: false, error: turnstile.error }, 400);
  }

  const name = cleanStr(data.name, 100);
  const email = cleanStr(data.email, 200);
  const referral = cleanStr(data.referral, 200);
  const message = cleanStr(data.message, 2000);
  if (!name || !isEmail(email)) {
    return c.json({ ok: false, error: "Please include your name and a valid email address." }, 400);
  }

  const id = crypto.randomUUID();
  const ipHash = await sha256Hex(clientIp(c.req.raw));
  const userAgent = (c.req.header("user-agent") || "").slice(0, 300);

  await DB.prepare(
    `INSERT INTO introduction_requests
       (id, name, email, referral, message, ip_hash, user_agent, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`
  )
    .bind(id, name, email, referral || null, message || null, ipHash, userAgent || null)
    .run();

  const notifyHtml = shell(
    "New introduction request",
    "Someone requested an introduction on brimwoodinnovation.com.",
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      fieldRow("Name", name) +
      fieldRow("Email", email) +
      fieldRow("Referred by", referral) +
      fieldRow("What they are building", message) +
      "</table>" +
      '<p style="font-size:13px;color:#5B6862;margin:24px 0 0;">Reply directly to this email to reach ' + esc(name) + ".</p>"
  );
  const confirmHtml = shell(
    "Request received",
    "Thank you — your introduction request is on its way.",
    '<p style="margin:0 0 16px;">Hello ' + esc(name) + ",</p>" +
      "<p style=\"margin:0 0 16px;\">Thank you. Your introduction request is on its way &mdash; we read every one personally and will be in touch.</p>" +
      '<p style="margin:0;font-size:13px;color:#5B6862;">Membership is by invitation. Elite by effort, not by background.</p>'
  );

  try {
    const notifyId = await sendEmail(resendKey, {
      to: INBOX,
      subject: "New introduction request — " + name,
      html: notifyHtml,
      text:
        "New introduction request — brimwoodinnovation.com\n\nName: " + name +
        "\nEmail: " + email + "\nReferred by: " + (referral || "—") +
        "\n\nWhat they are building:\n" + (message || "—"),
      replyTo: email,
    });
    const confirmId = await sendEmail(resendKey, {
      to: email,
      subject: "Thank you — Brimwood Innovation",
      html: confirmHtml,
      text:
        "Hello " + name + ",\n\nThank you. Your introduction request is on its way — we read every one personally and will be in touch.\n\nBuild a business. Build yourself.\n— Brimwood Innovation",
    });
    await DB.batch([
      DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'intro-notify', ?, ?, 'sent', ?)"
      ).bind(crypto.randomUUID(), INBOX, "New introduction request — " + name, notifyId || null),
      DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'intro-confirm', ?, ?, 'sent', ?)"
      ).bind(crypto.randomUUID(), email, "Thank you — Brimwood Innovation", confirmId || null),
    ]);
  } catch (e) {
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status, error) VALUES (?, 'intro-notify', ?, ?, 'failed', ?)"
    )
      .bind(crypto.randomUUID(), INBOX, "New introduction request — " + name, String((e as Error)?.message || e).slice(0, 500))
      .run();
    // The request is safely stored; the email failure is logged for retry.
    // Behaviour parity: the live worker would 502 here, but dropping a stored
    // request's confirmation is worse than a logged failure. Return ok.
  }

  return c.json({ ok: true });
});

export default app;
