/* Events + RSVP (Phase B): Friday demo nights and gatherings.
 * Public: list upcoming, detail, RSVP (Turnstile-protected).
 * Admin: full CRUD + attendee lists.
 * Wire in index.ts as: app.route("/api", events)
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getAdminUser, getUserId } from "../lib/auth";
import { sendEmail, shell, esc, SITE } from "../lib/email";
import { cleanStr, isEmail, isRecord, clientIp } from "../lib/validate";
import { verifyTurnstile } from "../lib/turnstile";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/* ================= Public ================= */

/* Hub events read extension (Phase 3 slice 7): the list and detail
 * responses carry the 0028 columns the public reads used to drop
 * (kind, number), the open demo slot count, whether a published recap
 * exists, and, for a signed-in caller, their own RSVP. The public
 * list keeps its published-only filter; ?when=past lists past
 * published events, newest first, for the hub past-events section. */
const EVENT_READ_COLUMNS = `e.id, e.slug, e.title, e.starts_at, e.ends_at,
  e.location, e.capacity, e.kind, e.number,
  (SELECT COALESCE(SUM(r.guests), 0) FROM event_rsvps r
    WHERE r.event_id = e.id AND r.status = 'confirmed') AS rsvp_count,
  (SELECT COUNT(*) FROM demo_slots d
    WHERE d.event_id = e.id AND d.status = 'open') AS demo_slots_open,
  EXISTS (SELECT 1 FROM event_recaps rc
    WHERE rc.event_id = e.id AND rc.published_at IS NOT NULL) AS has_recap`;

async function attachMyRsvp(DB: any, memberId: string | null, events: any[]) {
  if (!memberId) return events.map((e) => ({ ...e, my_rsvp: null }));
  const rows = await DB.prepare(
    `SELECT event_id, guests, status FROM event_rsvps
     WHERE user_id = ? AND status = 'confirmed'`
  )
    .bind(memberId)
    .all()
    .catch(() => ({ results: [] }));
  const byEvent = new Map<string, any>((rows.results || []).map((r: any) => [r.event_id, r]));
  return events.map((e) => {
    const mine = byEvent.get(e.id);
    return { ...e, my_rsvp: mine ? { status: mine.status, guests: mine.guests } : null };
  });
}

/** Published events: upcoming soonest first, or past newest first. */
app.get("/events", async (c) => {
  const { DB } = c.env;
  const past = c.req.query("when") === "past";
  const now = new Date().toISOString();
  const rows = await DB.prepare(
    `SELECT ${EVENT_READ_COLUMNS}
     FROM events e
     WHERE e.status = 'published' AND e.starts_at ${past ? "<" : ">="} ?
     ORDER BY e.starts_at ${past ? "DESC" : "ASC"} LIMIT 50`
  )
    .bind(now)
    .all();
  const memberId = await getUserId(c).catch(() => null);
  return c.json({ ok: true, events: await attachMyRsvp(DB, memberId, rows.results) });
});

/** Event detail + RSVP count. */
app.get("/events/:slug", async (c) => {
  const { DB } = c.env;
  const slug = cleanStr(c.req.param("slug"), 80);
  const ev = await DB.prepare(
    `SELECT ${EVENT_READ_COLUMNS}
     FROM events e WHERE e.slug = ?`
  )
    .bind(slug)
    .first<any>();
  if (!ev || ev.status !== "published") {
    return c.json({ ok: false, error: "Not found" }, 404);
  }
  const memberId = await getUserId(c).catch(() => null);
  const [withMine] = await attachMyRsvp(DB, memberId, [ev]);
  return c.json({ ok: true, event: withMine });
});

/** RSVP to an event. One RSVP per email; re-submitting updates it. */
app.post("/events/:slug/rsvp", async (c) => {
  const { DB } = c.env;
  const env = c.env as Env;

  if (!(await checkRateLimitD1(DB, "rsvp:" + clientIp(c.req.raw), 5, 3600))) {
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
    return c.json({ ok: true }); // honeypot: bot - pretend success
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

  // Phase 1 item 9 (RSVP by member): a signed-in member's RSVP carries their
  // user_id, so it can be joined back to the member. Guests keep name/email
  // only. readSession is cookie-gated, so this adds no query for guests.
  const memberId = await getUserId(c).catch(() => null);

  // Remember any existing RSVP so the capacity check can exclude it and the
  // post-write check below can restore it. A member's own row is found by
  // user_id first (it may carry an older email); otherwise fall back to the
  // submitted email, which also adopts a pre-sign-in guest row to the member.
  let prior: { id: string; name: string; email: string; guests: number; status: string; user_id: string | null } | null = null;
  if (memberId) {
    prior = await DB.prepare(
      "SELECT id, name, email, guests, status, user_id FROM event_rsvps WHERE event_id = ? AND user_id = ?"
    )
      .bind(ev.id, memberId)
      .first<{ id: string; name: string; email: string; guests: number; status: string; user_id: string | null }>()
      .catch(() => null);
  }
  if (!prior) {
    prior = await DB.prepare(
      "SELECT id, name, email, guests, status, user_id FROM event_rsvps WHERE event_id = ? AND email = ?"
    )
      .bind(ev.id, email)
      .first<{ id: string; name: string; email: string; guests: number; status: string; user_id: string | null }>()
      .catch(() => null);
  }

  // Capacity: count confirmed guests excluding this submitter's own RSVP,
  // then add the new total.
  const current = await DB.prepare(
    `SELECT COALESCE(SUM(guests), 0) AS n FROM event_rsvps
     WHERE event_id = ? AND status = 'confirmed' AND email != ? AND id != ?`
  )
    .bind(ev.id, email, prior?.id ?? "")
    .first<{ n: number }>();
  if (ev.capacity && (current?.n || 0) + guests > ev.capacity) {
    return c.json({ ok: false, error: "Sorry - this event is at capacity." }, 400);
  }

  if (prior) {
    // The member (or the email) already has a row: update it in place.
    // COALESCE keeps an existing member link when a guest re-submits the
    // same email, and adopts a guest row when the member signs in later.
    // Updating by id (never re-inserting) keeps the (event_id, user_id)
    // unique index happy when a member changes their RSVP email.
    await DB.prepare(
      `UPDATE event_rsvps
       SET user_id = COALESCE(user_id, ?), name = ?, email = ?, guests = ?, status = 'confirmed'
       WHERE id = ?`
    )
      .bind(memberId, name, email, guests, prior.id)
      .run();
  } else {
    await DB.prepare(
      `INSERT INTO event_rsvps (id, event_id, user_id, name, email, guests, status)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed')
       ON CONFLICT(event_id, email) DO UPDATE SET
         user_id = COALESCE(user_id, excluded.user_id),
         name = excluded.name, guests = excluded.guests, status = 'confirmed'`
    )
      .bind(crypto.randomUUID(), ev.id, memberId, name, email, guests)
      .run();
  }

  // Post-write capacity verify: closes the check-then-insert race where two
  // concurrent RSVPs both pass the check above. On oversell, restore the
  // prior RSVP (or delete the new row) and reject.
  if (ev.capacity) {
    const total = await DB.prepare(
      `SELECT COALESCE(SUM(guests), 0) AS n FROM event_rsvps
       WHERE event_id = ? AND status = 'confirmed'`
    )
      .bind(ev.id)
      .first<{ n: number }>()
      .catch(() => null);
    if (total && total.n > ev.capacity) {
      if (prior) {
        await DB.prepare("UPDATE event_rsvps SET name = ?, guests = ?, status = ? WHERE id = ?")
          .bind(prior.name, prior.guests, prior.status, prior.id)
          .run()
          .catch(() => {});
      } else {
        await DB.prepare("DELETE FROM event_rsvps WHERE event_id = ? AND email = ?")
          .bind(ev.id, email)
          .run()
          .catch(() => {});
      }
      return c.json({ ok: false, error: "Sorry - this event is at capacity." }, 400);
    }
  }

  // Confirmation email (best effort - RSVP is stored regardless).
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
        `<p style="margin:0 0 16px;">You are confirmed for <strong>${esc(ev.title)}</strong> - ` +
        `${esc(when)}${ev.location ? ` at ${esc(ev.location)}` : ""}. ` +
        `Party of ${guests}.</p>` +
        `<p style="margin:0;font-size:13px;color:#5B6862;">Build a business. Build yourself.<br>` +
        `<a href="${site}/events/${esc(slug)}" style="color:#0C9463;">Event details</a></p>`
    );
    await sendEmail(resendKey, {
      to: email,
      subject: `Confirmed: ${ev.title} - Brimwood Innovation`,
      html,
      text:
        `Hello ${name},\n\nYou are confirmed for ${ev.title} - ${when}` +
        `${ev.location ? ` at ${ev.location}` : ""}. Party of ${guests}.\n\n` +
        `Build a business. Build yourself.\n- Brimwood Innovation`,
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

/* ================= Member RSVP (Phase 3 slice 7) =================
 *
 * The hub events page needs a signed-in RSVP without the public
 * form's name, email, and Turnstile fields: the session already
 * proves the member, and the member's name and email come from
 * their users row. POST confirms (or updates) the member's own
 * RSVP; DELETE cancels it. Capacity uses the same confirmed-guest
 * sum and the same post-write oversell guard as the public path,
 * so the two writers can never disagree about a full event. */

async function memberEvent(c: any) {
  const memberId = await getUserId(c).catch(() => null);
  if (!memberId) return { error: c.json({ ok: false, error: "Sign in required." }, 401) };
  const slug = cleanStr(c.req.param("slug"), 80);
  const ev = await c.env.DB.prepare(
    `SELECT id, title, starts_at, capacity FROM events
     WHERE slug = ? AND status = 'published'`
  )
    .bind(slug)
    .first();
  if (!ev) return { error: c.json({ ok: false, error: "Event not found." }, 404) };
  return { memberId, ev };
}

app.post("/events/:slug/my-rsvp", async (c) => {
  const { DB } = c.env;
  const found = await memberEvent(c);
  if (found.error) return found.error;
  const { memberId, ev } = found as { memberId: string; ev: any };

  if (!(await checkRateLimitD1(DB, "my-rsvp:" + memberId, 10, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }
  if (ev.starts_at < new Date().toISOString()) {
    return c.json({ ok: false, error: "This event has already happened." }, 400);
  }
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const guests = isRecord(data) && data.guests !== undefined
    ? Math.min(Math.max(parseInt(String(data.guests), 10) || 1, 1), 10)
    : 1;

  const prior = await DB.prepare(
    "SELECT id, guests, status FROM event_rsvps WHERE event_id = ? AND user_id = ?"
  )
    .bind(ev.id, memberId)
    .first<{ id: string; guests: number; status: string }>()
    .catch(() => null);

  const current = await DB.prepare(
    `SELECT COALESCE(SUM(guests), 0) AS n FROM event_rsvps
     WHERE event_id = ? AND status = 'confirmed' AND id != ?`
  )
    .bind(ev.id, prior?.id ?? "")
    .first<{ n: number }>();
  if (ev.capacity && (current?.n || 0) + guests > ev.capacity) {
    return c.json({ ok: false, error: "Sorry - this event is at capacity." }, 400);
  }

  if (!prior) {
    const user = await DB.prepare("SELECT name, email FROM users WHERE id = ?")
      .bind(memberId)
      .first<{ name: string; email: string }>()
      .catch(() => null);
    if (!user || !user.email) {
      return c.json({ ok: false, error: "Sign in required." }, 401);
    }
    await DB.prepare(
      `INSERT INTO event_rsvps (id, event_id, user_id, name, email, guests, status)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`
    )
      .bind(crypto.randomUUID(), ev.id, memberId, user.name, user.email, guests)
      .run();
  } else {
    await DB.prepare(
      `UPDATE event_rsvps SET guests = ?, status = 'confirmed' WHERE id = ?`
    )
      .bind(guests, prior.id)
      .run();
  }

  // Post-write oversell guard, mirroring the public path.
  if (ev.capacity) {
    const total = await DB.prepare(
      `SELECT COALESCE(SUM(guests), 0) AS n FROM event_rsvps
       WHERE event_id = ? AND status = 'confirmed'`
    )
      .bind(ev.id)
      .first<{ n: number }>()
      .catch(() => null);
    if (total && total.n > ev.capacity) {
      if (prior) {
        await DB.prepare("UPDATE event_rsvps SET guests = ?, status = ? WHERE id = ?")
          .bind(prior.guests, prior.status, prior.id)
          .run()
          .catch(() => {});
      } else {
        await DB.prepare("DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?")
          .bind(ev.id, memberId)
          .run()
          .catch(() => {});
      }
      return c.json({ ok: false, error: "Sorry - this event is at capacity." }, 400);
    }
  }

  return c.json({ ok: true, my_rsvp: { status: "confirmed", guests } });
});

app.delete("/events/:slug/my-rsvp", async (c) => {
  const { DB } = c.env;
  const found = await memberEvent(c);
  if (found.error) return found.error;
  const { memberId, ev } = found as { memberId: string; ev: any };
  const res = await DB.prepare(
    `UPDATE event_rsvps SET status = 'cancelled'
     WHERE event_id = ? AND user_id = ? AND status = 'confirmed'`
  )
    .bind(ev.id, memberId)
    .run();
  if (!res.meta.changes) {
    return c.json({ ok: false, error: "You have no RSVP for this event." }, 404);
  }
  return c.json({ ok: true });
});

/* ================= Event room holds (Phase 1 item 20) =================
 *
 * An event that uses a room inserts one space_bookings row per hold window
 * with event_id set (an "event hold"), so the overlap rule in 0029_space.sql
 * blocks member bookings against it. Holds only exist while the event is
 * published; cancelling or drafting an event cancels its holds, deleting the
 * event cascades them away (FK ON DELETE CASCADE). Each row respects the
 * space_bookings CHECKs: minute-aligned ISO times, 15 to 120 minutes long.
 */

const HOLD_MAX_MINUTES = 120;
const HOLD_CHUNK_MINUTES = 105;

function floorToMinute(d: Date): Date {
  d.setSeconds(0, 0);
  return d;
}

/** Split an event window into minute-aligned hold windows of 15 to 120
 * minutes. Long events are chunked at 105 minutes so the trailing chunk is
 * never shorter than the 15-minute minimum. */
function holdWindows(startsAt: string, endsAt: string | null): { starts: string; ends: string }[] {
  const start = floorToMinute(new Date(startsAt));
  let endMs = endsAt ? floorToMinute(new Date(endsAt)).getTime() : start.getTime() + HOLD_MAX_MINUTES * 60000;
  if (!(endMs > start.getTime())) endMs = start.getTime() + 15 * 60000;
  if (endMs - start.getTime() < 15 * 60000) endMs = start.getTime() + 15 * 60000;
  const windows: { starts: string; ends: string }[] = [];
  let cur = start.getTime();
  while (cur < endMs) {
    const remaining = endMs - cur;
    const len = remaining > HOLD_MAX_MINUTES * 60000 ? HOLD_CHUNK_MINUTES * 60000 : remaining;
    const wEnd = cur + len;
    windows.push({ starts: new Date(cur).toISOString(), ends: new Date(wEnd).toISOString() });
    cur = wEnd;
  }
  return windows;
}

/** Map a space_bookings trigger ABORT (or the pre-check equivalent) to a
 * plain-words 400 message. Returns null when the error is not a hold rule. */
function holdRuleMessage(e: unknown): string | null {
  const msg = String((e as Error | null)?.message ?? e ?? "");
  if (msg.includes("booking overlaps another booking")) return "That room is already booked at that time.";
  if (msg.includes("resource is not bookable")) return "That room cannot be booked right now.";
  if (msg.includes("the hub is closed then")) return "The hub is closed at that time.";
  if (msg.includes("party is larger than the room capacity")) return "That event is larger than the room capacity.";
  return null;
}

interface HoldPlan {
  error?: string;
  stmts?: { sql: string; params: unknown[] }[];
}

/** Validate a room and build the hold insert statements for an event, or
 * return { error } for a clean 400. The overlap and closure pre-checks mirror
 * the 0029 triggers; the triggers stay the race fallback. */
async function planEventHolds(
  DB: any,
  opts: {
    eventId: string;
    eventTitle: string;
    resourceId: string;
    startsAt: string;
    endsAt: string | null;
    capacity: number | null;
    holderUserId: string;
  }
): Promise<HoldPlan> {
  const res = (await DB.prepare(
    "SELECT id, bookable, active, capacity FROM space_resources WHERE id = ?"
  )
    .bind(opts.resourceId)
    .first()
    .catch(() => null)) as { id: string; bookable: number; active: number; capacity: number } | null;
  if (!res) return { error: "Unknown room." };
  if (!res.bookable || !res.active) return { error: "That room cannot be booked right now." };

  const windows = holdWindows(opts.startsAt, opts.endsAt);
  for (const w of windows) {
    const clash = await DB.prepare(
      `SELECT 1 FROM space_bookings
       WHERE resource_id = ? AND status IN ('confirmed','checked_in')
         AND (event_id IS NULL OR event_id != ?)
         AND starts_at < ? AND ? < ends_at
       LIMIT 1`
    )
      .bind(opts.resourceId, opts.eventId, w.ends, w.starts)
      .first()
      .catch(() => null);
    if (clash) return { error: "That room is already booked at that time." };
    const closed = await DB.prepare(
      `SELECT 1 FROM space_closures
       WHERE (resource_id IS NULL OR resource_id = ?)
         AND starts_at < ? AND ? < ends_at
       LIMIT 1`
    )
      .bind(opts.resourceId, w.ends, w.starts)
      .first()
      .catch(() => null);
    if (closed) return { error: "The hub is closed at that time." };
  }

  const partySize = Math.min(Math.max(opts.capacity ?? 1, 1), res.capacity);
  const purpose = ("Event hold: " + opts.eventTitle).slice(0, 140);
  const stmts = windows.map((w) => ({
    sql: `INSERT INTO space_bookings
            (id, resource_id, user_id, starts_at, ends_at, party_size, purpose, event_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
    params: [crypto.randomUUID(), opts.resourceId, opts.holderUserId, w.starts, w.ends, partySize, purpose, opts.eventId],
  }));
  return { stmts };
}

/** Rebuild an event's holds from a validated plan: clear the old rows, then
 * insert the new ones. resourceId null clears the holds; undefined keeps the
 * event's current room (no-op when the event has no holds). Planning happens
 * before any delete, so a bad room leaves the existing holds untouched. */
async function syncEventHolds(
  DB: any,
  eventId: string,
  opts: {
    resourceId?: string | null;
    title: string;
    startsAt: string;
    endsAt: string | null;
    capacity: number | null;
    holderUserId: string;
  }
): Promise<string | null> {
  let resourceId = opts.resourceId;
  if (resourceId === undefined) {
    const row = (await DB.prepare(
      "SELECT resource_id FROM space_bookings WHERE event_id = ? LIMIT 1"
    )
      .bind(eventId)
      .first()
      .catch(() => null)) as { resource_id: string } | null;
    if (!row) return null;
    resourceId = row.resource_id;
  }
  if (!resourceId) {
    await DB.prepare("DELETE FROM space_bookings WHERE event_id = ?").bind(eventId).run().catch(() => {});
    return null;
  }
  const plan = await planEventHolds(DB, {
    eventId,
    eventTitle: opts.title,
    resourceId,
    startsAt: opts.startsAt,
    endsAt: opts.endsAt,
    capacity: opts.capacity,
    holderUserId: opts.holderUserId,
  });
  if (plan.error) return plan.error;
  await DB.prepare("DELETE FROM space_bookings WHERE event_id = ?").bind(eventId).run().catch(() => {});
  try {
    await DB.batch(plan.stmts!.map((s) => DB.prepare(s.sql).bind(...s.params)));
  } catch (e) {
    return holdRuleMessage(e) ?? "Could not hold the room for this event.";
  }
  return null;
}

/** Release an event's holds without deleting the rows (status cancelled). */
async function cancelEventHolds(DB: any, eventId: string): Promise<void> {
  await DB.prepare(
    `UPDATE space_bookings
     SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE event_id = ? AND status IN ('confirmed','checked_in')`
  )
    .bind(eventId)
    .run()
    .catch(() => {});
}

/* ================= Admin ================= */

/** All events, newest first, with RSVP counts. */
app.get("/admin/events", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT e.*,
       (SELECT COALESCE(SUM(r.guests), 0) FROM event_rsvps r
        WHERE r.event_id = e.id AND r.status = 'confirmed') AS rsvp_count,
       (SELECT resource_id FROM space_bookings WHERE event_id = e.id LIMIT 1) AS space_resource_id
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
  const raw = await c.req.json().catch(() => null);
  if (!isRecord(raw)) return c.json({ ok: false, error: "Invalid request." }, 400);
  const data = raw;

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
  const startsAt = new Date(starts_at).toISOString();
  const endsAt =
    data.ends_at && !isNaN(Date.parse(String(data.ends_at)))
      ? new Date(String(data.ends_at)).toISOString()
      : null;
  const eventId = crypto.randomUUID();

  // Phase 1 item 20: an event that uses a room holds it in space_bookings, so
  // the overlap rule blocks member bookings. Drafts and cancelled events hold
  // nothing; publishing later (PATCH) creates the hold. The room is validated
  // before the event row is written, so a bad room is a clean 400.
  const resourceId = cleanStr(data.space_resource_id, 50);
  const wantHold = status === "published" && !!resourceId;
  const holdPlan = wantHold
    ? await planEventHolds(DB, {
        eventId,
        eventTitle: title,
        resourceId,
        startsAt,
        endsAt,
        capacity,
        holderUserId: admin!.id,
      })
    : null;
  if (holdPlan?.error) return c.json({ ok: false, error: holdPlan.error }, 400);

  try {
    await DB.prepare(
      `INSERT INTO events (id, slug, title, description_md, starts_at, ends_at, location, capacity, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        eventId,
        slug,
        title,
        cleanStr(data.description_md, 10000) || null,
        startsAt,
        endsAt,
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

  if (holdPlan?.stmts) {
    try {
      await DB.batch(holdPlan.stmts.map((s) => DB.prepare(s.sql).bind(...s.params)));
    } catch (e) {
      // Race lost to a concurrent booking: the event stands, the room does
      // not. The message is honest about what happened.
      return c.json({ ok: false, error: holdRuleMessage(e) ?? "Could not hold the room for this event." }, 400);
    }
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
  const raw = await c.req.json().catch(() => null);
  if (!isRecord(raw)) return c.json({ ok: false, error: "Invalid request." }, 400);
  const data = raw;

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
    if (!data.starts_at || isNaN(Date.parse(String(data.starts_at)))) {
      return c.json({ ok: false, error: "Invalid start date/time." }, 400);
    }
    set("starts_at", new Date(String(data.starts_at)).toISOString());
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
  // space_resource_id is not an events column; it only drives the room hold,
  // so a room-only PATCH is valid even with no column changes.
  const roomTouched = data.space_resource_id !== undefined;
  if (fields.length === 0 && !roomTouched) {
    return c.json({ ok: false, error: "Nothing to update." }, 400);
  }

  const prevStatus = await DB.prepare("SELECT status FROM events WHERE id = ?")
    .bind(id)
    .first<{ status: string }>()
    .then((r) => r?.status ?? null)
    .catch(() => null);
  if (prevStatus === null) return c.json({ ok: false, error: "Event not found." }, 404);

  if (fields.length > 0) {
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
  }

  // Phase 1 item 20: keep the room hold in step with the event. Holds only
  // exist while the event is published; anything else releases the room.
  const ev = await DB.prepare(
    "SELECT title, starts_at, ends_at, capacity, status FROM events WHERE id = ?"
  )
    .bind(id)
    .first<{ title: string; starts_at: string; ends_at: string | null; capacity: number | null; status: string }>()
    .catch(() => null);
  if (ev) {
    if (ev.status !== "published") {
      await cancelEventHolds(DB, id);
    } else {
      const timesTouched = data.starts_at !== undefined || data.ends_at !== undefined;
      const capacityTouched = data.capacity !== undefined;
      const becamePublished = prevStatus !== null && prevStatus !== "published";
      if (roomTouched || timesTouched || capacityTouched || becamePublished) {
        const err = await syncEventHolds(DB, id, {
          resourceId: roomTouched ? cleanStr(data.space_resource_id, 50) || null : undefined,
          title: ev.title,
          startsAt: ev.starts_at,
          endsAt: ev.ends_at,
          capacity: ev.capacity,
          holderUserId: admin!.id,
        });
        if (err) return c.json({ ok: false, error: err }, 400);
      }
    }
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
    `SELECT id, name, email, guests, status, created_at, user_id FROM event_rsvps
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

/** Delete an event (RSVPs cascade). */
app.delete("/admin/events/:id", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const id = cleanStr(c.req.param("id"), 50);
  const res = await DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return c.json({ ok: false, error: "Event not found." }, 404);
  await audit(c, admin!, "event.delete", id);
  return c.json({ ok: true });
});

export default app;
