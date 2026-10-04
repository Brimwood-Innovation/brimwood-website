/* Events + RSVP (Phase B): Friday demo nights and gatherings.
 * Public: list upcoming, detail, RSVP (Turnstile-protected).
 * Admin: full CRUD + attendee lists.
 * Wire in index.ts as: app.route("/api", events)
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";
import { getAdminUser } from "../lib/auth";
import { sendEmail, shell, esc, SITE } from "../lib/email";
import { cleanStr, isEmail, clientIp } from "../lib/validate";
import { verifyTurnstile } from "../lib/turnstile";
import { checkRateLimit } from "../lib/ratelimit";

type Env = Bindings & {
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SESSIONS_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();

/* --- admin guard (same pattern as admin.ts) --- */


function needAdmin(c: any, admin: any) {
  if (!admin) return c.json({ ok: false, error: "Admin only" }, 403);
  return null;
}

async function audit(c: any, admin: { id: string; email: string }, action: string, detail: string) {
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), admin.id, action, `${admin.email}: ${detail}`)
    .run()
    .catch(() => {});
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/* ================= Public ================= */

/** Upcoming published events, soonest first. */
app.get("/events", async (c) => {
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT e.id, e.slug, e.title, e.starts_at, e.ends_at, e.location, e.capacity,
            (SELECT COALESCE(SUM(r.guests), 0) FROM event_rsvps r
              WHERE r.event_id = e.id AND r.status = 'confirmed') AS rsvp_count
     FROM events e
     WHERE e.status = 'published' AND e.starts_at >= ${NOW}
     ORDER BY e.starts_at ASC LIMIT 50`
  ).all();
  return c.json({ ok: true, events: rows.results });
});

/** Event detail + RSVP count. */
app.get("/events/:slug", async (c) => {
  const { DB } = c.env;
  const slug = cleanStr(c.req.param("slug"), 80);
  const ev = await DB.prepare(
    `SELECT id, slug, title, description_md, starts_at, ends_at, location, capacity, status
     FROM events WHERE slug = ?`
  )
    .bind(slug)
    .first<any>();
  if (!ev || ev.status !== "published") {
    return c.json({ ok: false, error: "Not found" }, 404);
  }
  const count = await DB.prepare(
    `SELECT COALESCE(SUM(guests), 0) AS n FROM event_rsvps
     WHERE event_id = ? AND status = 'confirmed'`
  )
    .bind(ev.id)
    .first<{ n: number }>();
  return c.json({ ok: true, event: { ...ev, rsvp_count: count?.n || 0 } });
});

/** RSVP to an event. One RSVP per email; re-submitting updates it. */
app.post("/events/:slug/rsvp", async (c) => {
  const { DB, RATE_LIMIT_KV } = c.env;
  const env = c.env as Env;

  if (!(await checkRateLimit(RATE_LIMIT_KV, "rsvp:" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }

  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false }, 400);
  }
  if (cleanStr(data.website, 200)) {
    return c.json({ ok: true }); // honeypot: bot — pretend success
  }

  const name = cleanStr(data.name, 100);
  const email = cleanStr(data.email, 200).toLowerCase();
  const guests = Math.min(Math.max(parseInt(String(data.guests), 10) || 1, 1), 10);
  if (!name || !isEmail(email)) {
    return c.json({ ok: false, error: "Please include your name and a valid email address." }, 400);
  }

  // Turnstile bot check (fails closed).
  const turnstile = await verifyTurnstile(
    data["cf-turnstile-response"],
    env.TURNSTILE_SECRET_KEY,
    clientIp(c.req.raw)
  );
  if (!turnstile.ok) {
    return c.json({ ok: false, error: turnstile.error }, 400);
  }

  const slug = cleanStr(c.req.param("slug"), 80);
  const ev = await DB.prepare(
    `SELECT id, title, starts_at, location, capacity FROM events
     WHERE slug = ? AND status = 'published'`
  )
    .bind(slug)
    .first<any>();
  if (!ev) return c.json({ ok: false, error: "Event not found." }, 404);
  if (ev.starts_at < new Date().toISOString()) {
    return c.json({ ok: false, error: "This event has already happened." }, 400);
  }

  // Capacity: count confirmed guests excluding this email, then add the new total.
  const current = await DB.prepare(
    `SELECT COALESCE(SUM(guests), 0) AS n FROM event_rsvps
     WHERE event_id = ? AND status = 'confirmed' AND email != ?`
  )
    .bind(ev.id, email)
    .first<{ n: number }>();
  if (ev.capacity && (current?.n || 0) + guests > ev.capacity) {
    return c.json({ ok: false, error: "Sorry — this event is at capacity." }, 400);
  }

  await DB.prepare(
    `INSERT INTO event_rsvps (id, event_id, name, email, guests, status)
     VALUES (?, ?, ?, ?, ?, 'confirmed')
     ON CONFLICT(event_id, email) DO UPDATE SET
       name = excluded.name, guests = excluded.guests, status = 'confirmed'`
  )
    .bind(crypto.randomUUID(), ev.id, name, email, guests)
    .run();

  // Confirmation email (best effort — RSVP is stored regardless).
  const resendKey = env.RESEND_API_KEY;
  if (resendKey) {
    const when = new Date(ev.starts_at).toLocaleString("en-CA", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Toronto",
    });
    const site = SITE(c.env);
    const html = shell(
      "You are on the list",
      `RSVP confirmed: ${ev.title}`,
      `<p style="margin:0 0 16px;">Hello ${esc(name)},</p>` +
        `<p style="margin:0 0 16px;">You are confirmed for <strong>${esc(ev.title)}</strong> — ` +
        `${esc(when)}${ev.location ? ` at ${esc(ev.location)}` : ""}. ` +
        `Party of ${guests}.</p>` +
        `<p style="margin:0;font-size:13px;color:#5B6862;">Build a business. Build yourself.<br>` +
        `<a href="${site}/events/${esc(slug)}" style="color:#0C9463;">Event details</a></p>`
    );
    await sendEmail(resendKey, {
      to: email,
      subject: `Confirmed: ${ev.title} — Brimwood Innovation`,
      html,
      text:
        `Hello ${name},\n\nYou are confirmed for ${ev.title} — ${when}` +
        `${ev.location ? ` at ${ev.location}` : ""}. Party of ${guests}.\n\n` +
        `Build a business. Build yourself.\n— Brimwood Innovation`,
    }).catch(() => {});
    await DB.prepare(
      "INSERT INTO email_log (id, kind, to_email, subject, status) VALUES (?, 'rsvp-confirm', ?, ?, 'sent')"
    )
      .bind(crypto.randomUUID(), email, `Confirmed: ${ev.title}`)
      .run()
      .catch(() => {});
  }

  return c.json({ ok: true });
});

/* ================= Admin ================= */

/** All events, newest first, with RSVP counts. */
app.get("/admin/events", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT e.*, (SELECT COALESCE(SUM(r.guests), 0) FROM event_rsvps r
       WHERE r.event_id = e.id AND r.status = 'confirmed') AS rsvp_count
     FROM events e ORDER BY e.starts_at DESC LIMIT 100`
  ).all();
  return c.json({ ok: true, events: rows.results });
});

/** Create an event. */
app.post("/admin/events", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const data = await c.req.json().catch(() => ({}));

  const title = cleanStr(data.title, 200);
  if (!title) return c.json({ ok: false, error: "Title is required." }, 400);
  const slug = slugify(cleanStr(data.slug, 80) || title);
  if (!slug) return c.json({ ok: false, error: "Slug is required." }, 400);
  const starts_at = cleanStr(data.starts_at, 40);
  if (!starts_at || isNaN(Date.parse(starts_at))) {
    return c.json({ ok: false, error: "A valid start date/time is required." }, 400);
  }
  const status = cleanStr(data.status, 20) || "published";
  if (!["draft", "published", "cancelled"].includes(status)) {
    return c.json({ ok: false, error: "Invalid status." }, 400);
  }
  const capacity = data.capacity ? Math.max(parseInt(String(data.capacity), 10) || 0, 0) : null;

  try {
    await DB.prepare(
      `INSERT INTO events (id, slug, title, description_md, starts_at, ends_at, location, capacity, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        slug,
        title,
        cleanStr(data.description_md, 10000) || null,
        new Date(starts_at).toISOString(),
        data.ends_at && !isNaN(Date.parse(data.ends_at)) ? new Date(data.ends_at).toISOString() : null,
        cleanStr(data.location, 200) || null,
        capacity,
        status
      )
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return c.json({ ok: false, error: "An event with that slug already exists." }, 400);
    }
    throw e;
  }
  await audit(c, admin!, "event.create", slug);
  return c.json({ ok: true, slug });
});

/** Update an event. */
app.patch("/admin/events/:id", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const id = cleanStr(c.req.param("id"), 50);
  const data = await c.req.json().catch(() => ({}));

  const fields: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    fields.push(`${col} = ?`);
    vals.push(v);
  };
  if (data.title !== undefined) {
    const t = cleanStr(data.title, 200);
    if (!t) return c.json({ ok: false, error: "Title cannot be empty." }, 400);
    set("title", t);
  }
  if (data.slug !== undefined) {
    const s = slugify(cleanStr(data.slug, 80));
    if (!s) return c.json({ ok: false, error: "Slug cannot be empty." }, 400);
    set("slug", s);
  }
  if (data.description_md !== undefined) set("description_md", cleanStr(data.description_md, 10000) || null);
  if (data.starts_at !== undefined) {
    if (!data.starts_at || isNaN(Date.parse(data.starts_at))) {
      return c.json({ ok: false, error: "Invalid start date/time." }, 400);
    }
    set("starts_at", new Date(data.starts_at).toISOString());
  }
  if (data.ends_at !== undefined) {
    set("ends_at", data.ends_at && !isNaN(Date.parse(String(data.ends_at))) ? new Date(String(data.ends_at)).toISOString() : null);
  }
  if (data.location !== undefined) set("location", cleanStr(data.location, 200) || null);
  if (data.capacity !== undefined) {
    set("capacity", data.capacity ? Math.max(parseInt(String(data.capacity), 10) || 0, 0) : null);
  }
  if (data.status !== undefined) {
    const st = cleanStr(data.status, 20);
    if (!["draft", "published", "cancelled"].includes(st)) {
      return c.json({ ok: false, error: "Invalid status." }, 400);
    }
    set("status", st);
  }
  if (fields.length === 0) return c.json({ ok: false, error: "Nothing to update." }, 400);

  try {
    const res = await DB.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`)
      .bind(...vals, id)
      .run();
    if (!res.meta.changes) return c.json({ ok: false, error: "Event not found." }, 404);
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return c.json({ ok: false, error: "An event with that slug already exists." }, 400);
    }
    throw e;
  }
  await audit(c, admin!, "event.update", id);
  return c.json({ ok: true });
});

/** Attendee list for an event. */
app.get("/admin/events/:id/rsvps", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const id = cleanStr(c.req.param("id"), 50);
  const rows = await DB.prepare(
    `SELECT id, name, email, guests, status, created_at FROM event_rsvps
     WHERE event_id = ? ORDER BY created_at ASC LIMIT 500`
  )
    .bind(id)
    .all();
  const total = await DB.prepare(
    `SELECT COALESCE(SUM(guests), 0) AS n FROM event_rsvps
     WHERE event_id = ? AND status = 'confirmed'`
  )
    .bind(id)
    .first<{ n: number }>();
  return c.json({ ok: true, rsvps: rows.results, total_guests: total?.n || 0 });
});

export default app;
