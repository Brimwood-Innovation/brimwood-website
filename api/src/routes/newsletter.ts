/* Newsletter routes (T16): D1-backed double opt-in, behaviour parity with the live worker.
 * POST /api/newsletter → validate, store pending, send confirm email
 * GET  /api/newsletter/verify?token= → activate, send welcome + owner notice
 * GET  /api/newsletter/unsubscribe?email=&token= → unsubscribe */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { sendEmail, shell, fieldRow, button, page, esc, INBOX, SITE } from "../lib/email";
import { cleanStr, isEmail, isRecord, clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

import { verifyTurnstile } from "../lib/turnstile";

const app = new Hono<{ Bindings: Bindings }>();

type Env = Bindings & { RESEND_API_KEY?: string; TURNSTILE_SECRET_KEY?: string };
const keyOf = (c: { env: Env }) => c.env.RESEND_API_KEY;

app.post("/", async (c) => {
  const { DB } = c.env;
  const resendKey = keyOf(c);
  if (!resendKey) return c.json({ ok: false, error: "Email service is not configured. Please try again later." }, 500);

  if (!(await checkRateLimitD1(DB, "news:" + clientIp(c.req.raw), 3, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  if (!isRecord(data)) {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  if (cleanStr(data.website, 200)) {
    return c.json({ ok: true }); // honeypot
  }

  // Turnstile bot check (fails closed).
  const turnstile = await verifyTurnstile(
    data["cf-turnstile-response"],
    (c.env as Env).TURNSTILE_SECRET_KEY,
    clientIp(c.req.raw)
  );
  if (!turnstile.ok) {
    return c.json({ ok: false, error: turnstile.error }, 400);
  }

  const email = cleanStr(data.email, 200).toLowerCase();
  const name = cleanStr(data.name, 100);
  const source = cleanStr(data.source, 100) || "newsletter-page";
  if (!isEmail(email)) {
    return c.json({ ok: false, error: "Please enter a valid email address." }, 400);
  }

  const existing = await DB.prepare(
    "SELECT status FROM newsletter_subscribers WHERE email = ?"
  )
    .bind(email)
    .first<{ status: string }>();
  if (existing && existing.status === "active") {
    return c.json({ ok: true }); // already on the list — pretend success, send nothing
  }

  const token = crypto.randomUUID();
  const unsubToken = crypto.randomUUID();
  if (existing) {
    await DB.prepare(
      "UPDATE newsletter_subscribers SET status='pending', confirm_token=?, unsub_token=?, name=?, source=?, unsubscribed_at=NULL WHERE email=?"
    )
      .bind(token, unsubToken, name || null, source, email)
      .run();
  } else {
    await DB.prepare(
      "INSERT INTO newsletter_subscribers (id, email, name, status, confirm_token, unsub_token, source) VALUES (?, ?, ?, 'pending', ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), email, name || null, token, unsubToken, source)
      .run();
  }

  const verifyUrl = SITE(c.env) + "/api/newsletter/verify?token=" + encodeURIComponent(token);
  const html = shell(
    "Confirm your subscription",
    "One more step to join the Brimwood list.",
    "<p style=\"margin:0 0 16px;\">Hello" + (name ? " " + esc(name) : "") + ",</p>" +
      "<p style=\"margin:0 0 8px;\">You asked to join the Brimwood Innovation list. Please confirm your email address:</p>" +
      button(verifyUrl, "Confirm my email") +
      '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">If you did not request this, just ignore this email — nothing will happen.</p>'
  );
  // The confirm email IS the subscription flow: if it cannot be sent, the
  // pending row is useless to the user, so fail loudly (and log it) rather
  // than returning a false ok.
  let providerId: string | null;
  try {
    providerId = await sendEmail(resendKey, {
      to: email,
      subject: "Confirm your subscription — Brimwood Innovation",
      html,
      text:
        "Hello" + (name ? " " + name : "") + ",\n\nYou asked to join the Brimwood Innovation list. Confirm your email address:\n" +
        verifyUrl + "\n\nIf you did not request this, just ignore this email.",
    });
  } catch (e) {
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status, error) VALUES (?, 'newsletter-confirm', ?, ?, 'failed', ?)"
    )
      .bind(
        crypto.randomUUID(),
        email,
        "Confirm your subscription — Brimwood Innovation",
        String((e as Error)?.message || e).slice(0, 500)
      )
      .run();
    return c.json({ ok: false, error: "We could not send the confirmation email. Please try again." }, 500);
  }
  await DB.prepare(
    "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'newsletter-confirm', ?, ?, 'sent', ?)"
  )
    .bind(crypto.randomUUID(), email, "Confirm your subscription — Brimwood Innovation", providerId || null)
    .run();

  return c.json({ ok: true });
});

app.get("/verify", async (c) => {
  const { DB } = c.env;
  const resendKey = keyOf(c);
  if (!resendKey) return c.json({ ok: false, error: "Email service is not configured. Please try again later." }, 500);

  // L3: token-guarded but rate-limited anyway (defense in depth).
  const ip = clientIp(c.req.raw);
  if (!(await checkRateLimitD1(c.env.DB, `nl-verify:${ip}`, 30, 3600))) {
    return c.json({ ok: false, error: "Too many attempts. Try again later." }, 429);
  }

  // Double opt-in tokens expire after 48 hours (created_at bounds the token age).
  const TOKEN_TTL_MS = 48 * 3600 * 1000;
  const token = c.req.query("token") || "";
  const sub = token
    ? await DB.prepare(
        "SELECT email, name, created_at FROM newsletter_subscribers WHERE confirm_token = ? AND status = 'pending'"
      )
        .bind(token)
        .first<{ email: string; name: string | null; created_at: string }>()
    : null;
  const fresh = sub && Date.now() - Date.parse(sub.created_at) <= TOKEN_TTL_MS;
  if (!fresh) {
    return page(
      "Link expired",
      "This link has expired",
      '<p style="margin:0;">That confirmation link is no longer valid. Please sign up again on <a href="' + SITE(c.env) + '" style="color:#0C9463;">brimwoodinnovation.com</a>.</p>',
      c.env
    );
  }

  const { email, name } = sub;
  const unsubToken = crypto.randomUUID();
  await DB.prepare(
    "UPDATE newsletter_subscribers SET status='active', confirm_token=NULL, unsub_token=?, subscribed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email=?"
  )
    .bind(unsubToken, email)
    .run();

  const unsubUrl =
    SITE(c.env) + "/api/newsletter/unsubscribe?email=" + encodeURIComponent(email) +
    "&token=" + encodeURIComponent(unsubToken);
  const html = shell(
    "You're on the list",
    "Welcome to Brimwood Innovation.",
    '<p style="margin:0 0 16px;">Hello' + (name ? " " + esc(name) : "") + ",</p>" +
      "<p style=\"margin:0 0 16px;\">You are on the list. We will write when there is something worth your time — no noise.</p>" +
      '<p style="margin:0;font-size:13px;color:#5B6862;">Build a business. Build yourself.</p>' +
      '<p style="font-size:12px;color:#5B6862;margin:24px 0 0;"><a href="' + esc(unsubUrl) + '" style="color:#5B6862;">Unsubscribe</a></p>'
  );
  // The subscription is already active at this point: the welcome/owner mails
  // are best-effort. A Resend outage must not turn a successful confirmation
  // into a 500 for the user — log the failure instead.
  try {
    const welcomeId = await sendEmail(resendKey, {
      to: email,
      subject: "You're on the list — Brimwood Innovation",
      html,
      text:
        "Hello" + (name ? " " + name : "") + ",\n\nYou are on the list. We will write when there is something worth your time — no noise.\n\nBuild a business. Build yourself.\n— Brimwood Innovation\n\nUnsubscribe: " + unsubUrl,
      headers: { "List-Unsubscribe": "<" + unsubUrl + ">" },
    });
    const ownerId = await sendEmail(resendKey, {
      to: INBOX,
      subject: "New newsletter subscriber — Brimwood Innovation",
      html: shell(
        "New newsletter subscriber",
        "Someone joined the Brimwood list.",
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
          fieldRow("Email", email) +
          fieldRow("Name", name || "") +
          "</table>"
      ),
      text: "New newsletter subscriber — brimwoodinnovation.com\n\nEmail: " + email + "\nName: " + (name || "—"),
    });
    await DB.batch([
      DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'newsletter-welcome', ?, ?, 'sent', ?)"
      ).bind(crypto.randomUUID(), email, "You're on the list — Brimwood Innovation", welcomeId || null),
      DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'newsletter-notify', ?, ?, 'sent', ?)"
      ).bind(crypto.randomUUID(), INBOX, "New newsletter subscriber — Brimwood Innovation", ownerId || null),
    ]);
  } catch (e) {
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status, error) VALUES (?, 'newsletter-welcome', ?, ?, 'failed', ?)"
    )
      .bind(
        crypto.randomUUID(),
        email,
        "You're on the list — Brimwood Innovation",
        String((e as Error)?.message || e).slice(0, 500)
      )
      .run()
      .catch(() => {});
  }

  return page(
    "You're on the list",
    "You're on the list",
    "<p style=\"margin:0;\">Welcome aboard" + (name ? ", " + esc(name) : "") + ". We will write when there is something worth your time.</p>",
    c.env
  );
});

app.get("/unsubscribe", async (c) => {
  const { DB } = c.env;
  // L3: token-guarded but rate-limited anyway (defense in depth).
  const ip = clientIp(c.req.raw);
  if (!(await checkRateLimitD1(c.env.DB, `nl-unsub:${ip}`, 30, 3600))) {
    return c.json({ ok: false, error: "Too many attempts. Try again later." }, 429);
  }
  const email = (c.req.query("email") || "").toLowerCase();
  const token = c.req.query("token") || "";
  const sub = email && token
    ? await DB.prepare(
        "SELECT id FROM newsletter_subscribers WHERE email = ? AND unsub_token = ? AND status = 'active'"
      )
        .bind(email, token)
        .first<{ id: string }>()
    : null;
  if (!sub) {
    return page(
      "Link invalid",
      "This link is not valid",
      '<p style="margin:0;">That unsubscribe link did not match our records.</p>',
      c.env
    );
  }
  await DB.prepare(
    "UPDATE newsletter_subscribers SET status='unsubscribed', unsubscribed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
  )
    .bind(sub.id)
    .run();
  return page(
    "Unsubscribed",
    "Unsubscribed",
    '<p style="margin:0;">You have been removed from the list. No hard feelings.</p>',
    c.env
  );
});

export default app;
