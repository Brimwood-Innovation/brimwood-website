/* POST /api/introduction (T16): D1-backed, behaviour parity with the live worker.
 * Validates → writes introduction_requests → sends owner notify + submitter
 * confirm via Resend → logs to email_log. Honeypot + rate limit preserved.
 * Redesign T11 adds one optional field, service: a public service slug
 * stored with the request (migration 0039) and named in the notify email. */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { sendEmail, shell, fieldRow, esc, INBOX } from "../lib/email";
import { cleanStr, isEmail, isRecord, clientIp, sha256Hex } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

import { verifyTurnstile } from "../lib/turnstile";

/* The 17 public service slugs (redesign T11, spec sections 3 and 4.1),
 * matching the site services collection file names exactly. A submitted
 * service tag is accepted only when it is one of these slugs; the map
 * value is the public line name, used in the owner notify email. */
const SERVICE_NAMES: Record<string, string> = {
  "animation-explainers": "2D and 3D animation and explainer videos",
  "brand-film": "Brand film",
  "content-day-retainer": "Content day retainer",
  "conversational-ai-agents": "Conversational AI agents",
  "custom-automation": "Custom automation",
  "custom-software-tools": "Custom software and tools",
  "design-build-strategy": "Design, build, and strategy",
  "founder-consultancy": "Founder consultancy and planning",
  "graphic-design": "Graphic design",
  "local-community-growth": "Local community growth",
  "paid-ads-creative": "Paid ads management and creative",
  "search-ai-visibility": "Search and AI visibility",
  "social-media-vsmm": "Social media support (VSMM)",
  "tvc-broadcast": "TVC and broadcast commercial production",
  "warm-lead-capture": "Warm-lead capture",
  "web-development": "Web development",
  "website-lead-engine": "Website plus lead engine",
};

const app = new Hono<{ Bindings: Bindings }>();

app.post("/", async (c) => {
  const { DB } = c.env;
  const resendKey = (c.env as Bindings & { RESEND_API_KEY?: string }).RESEND_API_KEY;
  if (!resendKey) return c.json({ ok: false, error: "Email service is not configured. Please try again later." }, 500);

  if (!(await checkRateLimitD1(DB, "intro:" + clientIp(c.req.raw), 5, 3600))) {
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
    return c.json({ ok: true }); // honeypot: bot, pretend success, store nothing
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
  const email = cleanStr(data.email, 200).toLowerCase();
  const referral = cleanStr(data.referral, 200);
  const message = cleanStr(data.message, 2000);
  if (!name || !isEmail(email)) {
    return c.json({ ok: false, error: "Please include your name and a valid email address." }, 400);
  }

  // Optional service tag (T11): absent or empty means a hub introduction
  // and stores NULL, exactly as before. A present value must be one of
  // the known public service slugs; anything else is rejected in the
  // same validation style as the name and email check above.
  const serviceRaw = cleanStr(data.service, 100);
  let service: string | null = null;
  if (serviceRaw) {
    if (!Object.prototype.hasOwnProperty.call(SERVICE_NAMES, serviceRaw)) {
      return c.json({ ok: false, error: "Please choose a service from the list, or leave it as not sure yet." }, 400);
    }
    service = serviceRaw;
  }

  // Idempotency: a client-supplied key makes retries safe, a duplicate key
  // returns success without re-inserting or re-sending. The UNIQUE index on
  // introduction_requests.idempotency_key (migration 0012) is the arbiter.
  const idemKey =
    cleanStr(data.idempotency_key, 100) ||
    (c.req.header("Idempotency-Key") || "").trim().slice(0, 100);
  if (idemKey) {
    const dup = await DB.prepare("SELECT id FROM introduction_requests WHERE idempotency_key = ?")
      .bind(idemKey)
      .first<{ id: string }>()
      .catch(() => null); // column missing (migration not applied yet) → skip
    if (dup) return c.json({ ok: true });
  }

  const id = crypto.randomUUID();
  const ipHash = await sha256Hex(clientIp(c.req.raw));
  const userAgent = (c.req.header("user-agent") || "").slice(0, 300);

  /* Insert, degrading gracefully when a migration has not been applied
   * yet: the full form carries idempotency_key (migration 0012) and
   * service (migration 0039); a "no such column" failure retries
   * without the missing column, down to the original keyless,
   * untagged insert, so a stored request is never lost to schema lag. */
  const baseCols = ["id", "name", "email", "referral", "message", "ip_hash", "user_agent", "status"];
  const baseVals = [id, name, email, referral || null, message || null, ipHash, userAgent || null];
  const mkVariant = (withIdem: boolean, withService: boolean) => {
    const cols = [...baseCols];
    const vals: unknown[] = [...baseVals];
    if (withIdem) {
      cols.push("idempotency_key");
      vals.push(idemKey || null);
    }
    if (withService) {
      cols.push("service");
      vals.push(service);
    }
    return { cols, vals };
  };
  const variants = [mkVariant(true, true), mkVariant(true, false), mkVariant(false, true), mkVariant(false, false)];
  let stored = false;
  let lastError: unknown = null;
  for (const variant of variants) {
    const marks = variant.cols.map((col) => (col === "status" ? "'new'" : "?")).join(", ");
    try {
      await DB.prepare(
        `INSERT INTO introduction_requests (${variant.cols.join(", ")}) VALUES (${marks})`
      )
        .bind(...variant.vals)
        .run();
      stored = true;
      break;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (idemKey && /UNIQUE/i.test(msg)) {
        return c.json({ ok: true }); // lost the race with our own retry, already stored
      }
      if (/no such column|has no column/i.test(msg)) {
        // Both wordings occur: "no such column" (older SQLite and D1)
        // and "has no column named" (newer SQLite).
        lastError = e;
        continue; // try the next, narrower insert
      }
      throw e;
    }
  }
  if (!stored) throw lastError;

  const notifyHtml = shell(
    "New introduction request",
    "Someone requested an introduction on brimwoodinnovation.com.",
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      fieldRow("Name", name) +
      fieldRow("Email", email) +
      fieldRow("Referred by", referral) +
      (service ? fieldRow("Service", SERVICE_NAMES[service]) : "") +
      fieldRow("What they are building", message) +
      "</table>" +
      '<p style="font-size:13px;color:#5B6862;margin:24px 0 0;">Reply directly to this email to reach ' + esc(name) + ".</p>"
  );
  const confirmHtml = shell(
    "Request received",
    "Thank you, your introduction request is on its way.",
    '<p style="margin:0 0 16px;">Hello ' + esc(name) + ",</p>" +
      "<p style=\"margin:0 0 16px;\">Thank you. Your introduction request is on its way, we read every one personally and will be in touch.</p>" +
      '<p style="margin:0;font-size:13px;color:#5B6862;">Membership is by invitation. Elite by effort, not by background.</p>'
  );

  try {
    const notifyId = await sendEmail(resendKey, {
      to: INBOX,
      subject: "New introduction request - " + name,
      html: notifyHtml,
      text:
        "New introduction request - brimwoodinnovation.com\n\nName: " + name +
        "\nEmail: " + email + "\nReferred by: " + (referral || "-") +
        (service ? "\nService: " + SERVICE_NAMES[service] : "") +
        "\n\nWhat they are building:\n" + (message || "-"),
      replyTo: email,
    });
    const confirmId = await sendEmail(resendKey, {
      to: email,
      subject: "Thank you - Brimwood Innovation",
      html: confirmHtml,
      text:
        "Hello " + name + ",\n\nThank you. Your introduction request is on its way, we read every one personally and will be in touch.\n\nBuild a business. Build yourself.\n- Brimwood Innovation",
    });
    await DB.batch([
      DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'intro-notify', ?, ?, 'sent', ?)"
      ).bind(crypto.randomUUID(), INBOX, "New introduction request - " + name, notifyId || null),
      DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'intro-confirm', ?, ?, 'sent', ?)"
      ).bind(crypto.randomUUID(), email, "Thank you - Brimwood Innovation", confirmId || null),
    ]);
  } catch (e) {
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status, error) VALUES (?, 'intro-notify', ?, ?, 'failed', ?)"
    )
      .bind(crypto.randomUUID(), INBOX, "New introduction request - " + name, String((e as Error)?.message || e).slice(0, 500))
      .run();
    // The request is safely stored; the email failure is logged for retry.
    // Behaviour parity: the live worker would 502 here, but dropping a stored
    // request's confirmation is worse than a logged failure. Return ok.
  }

  return c.json({ ok: true });
});

export default app;
