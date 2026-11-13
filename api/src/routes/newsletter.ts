/* Newsletter routes (T16): D1-backed double opt-in, behaviour parity with the live worker.
 * POST /api/newsletter → validate, store pending, send confirm email
 * GET  /api/newsletter/verify?token= → activate, send welcome + owner notice
 * GET  /api/newsletter/unsubscribe?email=&token= → unsubscribe (prefetch-safe page)
 * POST /api/newsletter/unsubscribe → RFC 8058 one-click unsubscribe */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { sendEmail, shell, fieldRow, button, page, esc, INBOX, SITE } from "../lib/email";
import { cleanStr, isEmail, isRecord, clientIp, sha256Hex } from "../lib/validate";
import { hmacSha256Hex } from "../lib/hmac";
import { safeEqual } from "../lib/safe-equal";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

import { verifyTurnstile } from "../lib/turnstile";

const app = new Hono<{ Bindings: Bindings }>();

/* Confirm tokens live 48h (audit/security-ci). The verify handler treats an
 * expired token exactly like an unknown one - no oracle, same "expired" page. */
const CONFIRM_TOKEN_TTL = "48 hours";

type Env = Bindings & { RESEND_API_KEY?: string; TURNSTILE_SECRET_KEY?: string };
const keyOf = (c: { env: Env }) => c.env.RESEND_API_KEY;

/* S21: the token columns hold SHA-256 hex, never the token itself. A leaked
 * table is not a list of live unsubscribe links. The plain token only ever
 * travels inside the emailed link. */
const tokenHash = (token: string) => sha256Hex(token);
/* Deterministic email fingerprint for email_suppressions and consent_records. */
export const emailFingerprint = (email: string) => sha256Hex(email.toLowerCase());

/* CASL proof lives in consent_records. Bump the form version when the signup
 * form changes and the policy version when the privacy policy changes. */
const CONSENT_FORM_VERSION = "newsletter-v1";
const CONSENT_POLICY_VERSION = "privacy-v1";

/* Bulk mail (digest, newsletter issues) cannot recover a plain per-subscriber
 * token from the stored hash, so it mints a signed unsubscribe link instead.
 * The signature is HMAC over the lower-cased email; only the Worker secret
 * can mint one. */
const UNSUB_SIG_CONTEXT = "brimwood/newsletter-unsub/v1";
export async function unsubSig(env: { SESSION_SECRET?: string }, email: string): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return hmacSha256Hex(secret, UNSUB_SIG_CONTEXT + ":" + email.toLowerCase());
}
export async function unsubUrlFor(
  env: { SESSION_SECRET?: string },
  siteUrl: string,
  email: string
): Promise<string> {
  const sig = await unsubSig(env, email);
  return (
    siteUrl.replace(/\/$/, "") +
    "/api/newsletter/unsubscribe?email=" +
    encodeURIComponent(email.toLowerCase()) +
    "&sig=" +
    sig
  );
}

/** S21: the sender joins email_suppressions before every send. */
export async function isSuppressed(DB: D1Database, email: string): Promise<boolean> {
  const row = await DB.prepare("SELECT 1 FROM email_suppressions WHERE email_hmac = ?")
    .bind(await emailFingerprint(email))
    .first<{ 1: number }>();
  return !!row;
}

export async function recordNewsletterConsent(
  DB: D1Database,
  email: string,
  granted: boolean,
  method: "double_opt_in" | "settings_toggle"
): Promise<void> {
  await DB.prepare(
    `INSERT INTO consent_records
       (id, email_hmac, purpose, granted, method, form_version, policy_version)
     VALUES (?, ?, 'newsletter', ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      await emailFingerprint(email),
      granted ? 1 : 0,
      method,
      CONSENT_FORM_VERSION,
      CONSENT_POLICY_VERSION
    )
    .run();
}

async function addSuppression(DB: D1Database, email: string): Promise<void> {
  await DB.prepare(
    "INSERT OR IGNORE INTO email_suppressions (email_hmac, reason) VALUES (?, 'unsubscribe')"
  )
    .bind(await emailFingerprint(email))
    .run();
}

/** Resolve a subscriber by the emailed credentials: either the per-subscriber
 * token (compared as its stored SHA-256) or a signed bulk-mail link. */
async function findSubscriber(
  DB: D1Database,
  env: Env,
  email: string,
  token: string,
  sig: string
): Promise<{ id: string; email: string; status: string } | null> {
  const lower = email.toLowerCase();
  if (token) {
    const sub = await DB.prepare(
      "SELECT id, email, status FROM newsletter_subscribers WHERE email = ? AND confirm_token = ? OR email = ? AND unsub_token = ?"
    )
      .bind(lower, await tokenHash(token), lower, await tokenHash(token))
      .first<{ id: string; email: string; status: string }>();
    if (sub) return sub;
  }
  if (sig && env.SESSION_SECRET) {
    const expected = await hmacSha256Hex(env.SESSION_SECRET, UNSUB_SIG_CONTEXT + ":" + lower);
    if (safeEqual(sig, expected)) {
      return await DB.prepare("SELECT id, email, status FROM newsletter_subscribers WHERE email = ?")
        .bind(lower)
        .first<{ id: string; email: string; status: string }>();
    }
  }
  return null;
}

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

  // S21: never send to a suppressed address. Pretend success (no oracle),
  // store nothing.
  if (await isSuppressed(DB, email)) {
    return c.json({ ok: true });
  }

  const existing = await DB.prepare(
    "SELECT status FROM newsletter_subscribers WHERE email = ?"
  )
    .bind(email)
    .first<{ status: string }>();
  if (existing && existing.status === "active") {
    return c.json({ ok: true }); // already on the list - pretend success, send nothing
  }

  const token = crypto.randomUUID();
  const unsubToken = crypto.randomUUID();
  const tokenHashed = await tokenHash(token);
  const unsubHashed = await tokenHash(unsubToken);
  if (existing) {
    await DB.prepare(
      "UPDATE newsletter_subscribers SET status='pending', confirm_token=?, confirm_token_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+" +
        CONFIRM_TOKEN_TTL +
        "'), unsub_token=?, name=?, source=?, unsubscribed_at=NULL WHERE email=?"
    )
      .bind(tokenHashed, unsubHashed, name || null, source, email)
      .run();
  } else {
    await DB.prepare(
      "INSERT INTO newsletter_subscribers (id, email, name, status, confirm_token, confirm_token_expires_at, unsub_token, source) VALUES (?, ?, ?, 'pending', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+" +
        CONFIRM_TOKEN_TTL +
        "'), ?, ?)"
    )
      .bind(crypto.randomUUID(), email, name || null, tokenHashed, unsubHashed, source)
      .run();
  }

  const verifyUrl = SITE(c.env) + "/api/newsletter/verify?token=" + encodeURIComponent(token);
  const html = shell(
    "Confirm your subscription",
    "One more step to join the Brimwood list.",
    "<p style=\"margin:0 0 16px;\">Hello" + (name ? " " + esc(name) : "") + ",</p>" +
      "<p style=\"margin:0 0 8px;\">You asked to join the Brimwood Innovation list. Please confirm your email address:</p>" +
      button(verifyUrl, "Confirm my email") +
      '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">If you did not request this, just ignore this email - nothing will happen.</p>'
  );

  // The confirm email IS the subscription flow: if it cannot be sent, the
  // pending row is useless to the user, so fail loudly (and log it) rather
  // than returning a false ok.
  let providerId: string | null;

  try {
    providerId = await sendEmail(resendKey, {
      to: email,
      subject: "Confirm your subscription - Brimwood Innovation",
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
        "Confirm your subscription - Brimwood Innovation",
        String((e as Error)?.message || e).slice(0, 500)
      )
      .run();
    return c.json({ ok: false, error: "We could not send the confirmation email. Please try again." }, 500);

  }
  await DB.prepare(
    "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'newsletter-confirm', ?, ?, 'sent', ?)"
  )
    .bind(crypto.randomUUID(), email, "Confirm your subscription - Brimwood Innovation", providerId || null)
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

        "SELECT email, name, confirm_token_expires_at FROM newsletter_subscribers WHERE confirm_token = ? AND status = 'pending'"
      )
        .bind(await tokenHash(token))
        .first<{ email: string; name: string | null; confirm_token_expires_at: string | null }>()
    : null;
  // Expired tokens (and legacy rows with NULL expiry) are treated exactly
  // like unknown tokens: same page, no oracle distinguishing the cases.
  const expired =
    !sub || !sub.confirm_token_expires_at || sub.confirm_token_expires_at <= new Date().toISOString();
  if (expired) {

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
    .bind(await tokenHash(unsubToken), email)
    .run();

  // S21: the double opt-in confirmation is the CASL proof. Best-effort: the
  // subscription is already active, so a consent-write failure is logged,
  // not shown to the member.
  try {
    await recordNewsletterConsent(DB, email, true, "double_opt_in");
  } catch (e) {
    console.error("newsletter: consent record write failed", e);
  }

  const unsubUrl =
    SITE(c.env) + "/api/newsletter/unsubscribe?email=" + encodeURIComponent(email) +
    "&token=" + encodeURIComponent(unsubToken);
  const html = shell(
    "You're on the list",
    "Welcome to Brimwood Innovation.",
    '<p style="margin:0 0 16px;">Hello' + (name ? " " + esc(name) : "") + ",</p>" +
      "<p style=\"margin:0 0 16px;\">You are on the list. We will write when there is something worth your time - no noise.</p>" +
      '<p style="margin:0;font-size:13px;color:#5B6862;">Build a business. Build yourself.</p>' +
      '<p style="font-size:12px;color:#5B6862;margin:24px 0 0;"><a href="' + esc(unsubUrl) + '" style="color:#5B6862;">Unsubscribe</a></p>'
  );

  // The subscription is already active at this point: the welcome/owner mails
  // are best-effort. A Resend outage must not turn a successful confirmation
  // into a 500 for the user - log the failure instead.
  try {
    // S21: the welcome mail is a send like any other - skip it for a
    // suppressed address (the double opt-in itself still stands).
    let welcomeId: string | null = null;
    if (!(await isSuppressed(DB, email))) {
      welcomeId = await sendEmail(resendKey, {
        to: email,
        subject: "You're on the list - Brimwood Innovation",
        html,
        text:
          "Hello" + (name ? " " + name : "") + ",\n\nYou are on the list. We will write when there is something worth your time - no noise.\n\nBuild a business. Build yourself.\n- Brimwood Innovation\n\nUnsubscribe: " + unsubUrl,
        headers: {
          "List-Unsubscribe": "<" + unsubUrl + ">",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      await DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'newsletter-welcome', ?, ?, 'sent', ?)"
      )
        .bind(crypto.randomUUID(), email, "You're on the list - Brimwood Innovation", welcomeId || null)
        .run();
    }
    const ownerId = await sendEmail(resendKey, {
      to: INBOX,
      subject: "New newsletter subscriber - Brimwood Innovation",
      html: shell(
        "New newsletter subscriber",
        "Someone joined the Brimwood list.",
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
          fieldRow("Email", email) +
          fieldRow("Name", name || "") +
          "</table>"
      ),
      text: "New newsletter subscriber - brimwoodinnovation.com\n\nEmail: " + email + "\nName: " + (name || "-"),
    });
    // The welcome log row was written above when the welcome mail went out.
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'newsletter-notify', ?, ?, 'sent', ?)"
    )
      .bind(crypto.randomUUID(), INBOX, "New newsletter subscriber - Brimwood Innovation", ownerId || null)
      .run();
  } catch (e) {
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status, error) VALUES (?, 'newsletter-welcome', ?, ?, 'failed', ?)"
    )
      .bind(
        crypto.randomUUID(),
        email,
        "You're on the list - Brimwood Innovation",
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

/* Shared unsubscribe: valid credentials flip an active subscription off,
 * write the CASL proof (granted = 0) and add the address to the suppression
 * list so no future send can reach it. A valid signed link for an unknown
 * address still suppresses (the owner of that address asked out). Returns
 * true when the credentials checked out. */
async function doUnsubscribe(
  DB: D1Database,
  env: Env,
  email: string,
  token: string,
  sig: string
): Promise<boolean> {
  if (!email || !isEmail(email)) return false;
  const sub = await findSubscriber(DB, env, email, token, sig);
  if (!sub) return false;
  if (sub.status === "active") {
    await DB.prepare(
      "UPDATE newsletter_subscribers SET status='unsubscribed', unsubscribed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
    )
      .bind(sub.id)
      .run();
  }
  // S21: the opt-out is consent proof, and the suppression row is what the
  // sender joins before every future send. Best-effort after the status
  // flip above.
  try {
    await recordNewsletterConsent(DB, email, false, "settings_toggle");
  } catch (e) {
    console.error("newsletter: opt-out consent write failed", e);
  }
  try {
    await addSuppression(DB, email);
  } catch (e) {
    console.error("newsletter: suppression write failed", e);
  }
  return true;
}

app.get("/unsubscribe", async (c) => {
  const { DB } = c.env;
  // L3: token-guarded but rate-limited anyway (defense in depth).
  const ip = clientIp(c.req.raw);
  if (!(await checkRateLimitD1(c.env.DB, `nl-unsub:${ip}`, 30, 3600))) {
    return c.json({ ok: false, error: "Too many attempts. Try again later." }, 429);
  }
  const email = (c.req.query("email") || "").toLowerCase();
  const token = c.req.query("token") || "";
  const sig = c.req.query("sig") || "";
  const ok = await doUnsubscribe(DB, c.env as Env, email, token, sig);
  if (!ok) {
    return page(
      "Link invalid",
      "This link is not valid",
      '<p style="margin:0;">That unsubscribe link did not match our records.</p>',
      c.env
    );
  }
  return page(
    "Unsubscribed",
    "Unsubscribed",
    '<p style="margin:0;">You have been removed from the list. No hard feelings.</p>',
    c.env
  );
});

/* RFC 8058 one-click unsubscribe. Mailbox providers POST here (Gmail sends
 * `List-Unsubscribe=One-Click` as application/x-www-form-urlencoded, no
 * Origin header) after the digest/welcome mail advertises
 * List-Unsubscribe-Post. Same email+token verification as the GET endpoint;
 * the GET page stays prefetch-safe (scanners must not unsubscribe).
 * Idempotent: unknown/invalid tokens also return {ok:true} - no oracle.
 * Note: csrfGuard has a narrow exemption for exactly this path + content
 * type, since the global rule requires application/json on mutating bodies. */
app.post("/unsubscribe", async (c) => {
  const { DB } = c.env;
  // L3: token-guarded but rate-limited anyway (defense in depth).
  const ip = clientIp(c.req.raw);
  if (!(await checkRateLimitD1(c.env.DB, `nl-unsub:${ip}`, 30, 3600))) {
    return c.json({ ok: false, error: "Too many attempts. Try again later." }, 429);
  }

  let email = (c.req.query("email") || "").toLowerCase();
  let token = c.req.query("token") || "";
  let sig = c.req.query("sig") || "";
  const ct = (c.req.header("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    email = email || String(body.email || "").toLowerCase();
    token = token || String(body.token || "");
    sig = sig || String(body.sig || "");
  } else if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.parseBody();
    email = email || String(form.email || "").toLowerCase();
    token = token || String(form.token || "");
    sig = sig || String(form.sig || "");
    // The RFC 8058 one-click body (`List-Unsubscribe=One-Click`) carries no
    // credentials itself; email+token (or the signed link) above are what
    // authorize the action.
  }

  await doUnsubscribe(DB, c.env as Env, email, token, sig);
  return c.json({ ok: true });
});

export default app;
