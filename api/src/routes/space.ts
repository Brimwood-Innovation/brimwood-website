/* Member hub space (Phase 3 slice 8, deck section 22 space screen).
 *
 * Mounted at "/api/space". Member routes sit behind requireUser; the
 * guest pass accept and check-in routes are public by design, because
 * the guest holds only the pass code, never an account.
 *
 * Deck rules, element by element:
 *   - Book a room: weekly grid, one room at a time, slots are 2 hours,
 *     start on even hours from 10 a.m., and every cell says its state
 *     in words (Free, Booked, Yours, Closed, Past). A free cell is a
 *     button named in full, for example "Book Forge Room, Wed,
 *     Oct 14, 10 a.m. to 12 p.m.". A member can hold 1 slot per room
 *     per day. On a phone the grid scrolls sideways inside its frame.
 *   - My bookings: cancel keeps the row and sets status and
 *     cancelled_at, so room use stays honest. The slot opens for
 *     other members at once.
 *   - Check-in: one row per member per local day. The count is
 *     members only in aggregate; no names or lists are ever returned.
 *   - Guest pass: first name and last initial only, up to 2 live
 *     passes per host per day, the pass works on its visit date
 *     only, and the code is stored as HMAC only (never the code).
 *   - House info: hours, address, rules and venue accessibility on
 *     one page. Accessibility facts the founder has not confirmed
 *     stay "Details coming soon. To confirm" and are never filled in
 *     from the dev seed, whose floor and access notes are marked
 *     placeholder, not checked. Resource floor and accessibility
 *     notes are therefore never returned by this API.
 * Errors from the 0029 triggers map to HTTP 409 with the deck's plain
 * messages: "booking overlaps another booking", "over capacity" and
 * "the hub is closed then" each get their own wording.
 * Not in this slice: a public /guest/CODE page for the guest view
 * (the deck marks that route a proposal); guests accept and check in
 * through the API routes below, and the host page links the code.
 * Mutating member routes are covered by the global CSRF guard.
 */
import { Hono } from "hono";
import { requireUser, type Session } from "../lib/auth";
import type { Bindings } from "../index";
import { cleanStr, isRecord, clientIp } from "../lib/validate";
import { codeHmac } from "../lib/hmac";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

const app = new Hono<{ Bindings: Bindings; Variables: { user: Session } }>();

const SLOT_HOURS = [10, 12, 14, 16, 18, 20];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- Toronto wall time (America/Toronto) ---------- */

/** Toronto wall-clock parts for an instant. Weekday 0 is Sunday. */
export function torontoParts(d: Date): {
  year: number; month: number; day: number; hour: number; minute: number; weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"),
    weekday: WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value || "Sun"),
  };
}

/** Toronto calendar date (YYYY-MM-DD) for an instant. */
export function torontoDateString(d: Date): string {
  const p = torontoParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes Toronto wall time sits ahead of UTC at this instant. */
function torontoOffsetMinutes(d: Date): number {
  const p = torontoParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** UTC instant for a Toronto wall date and hour (two-pass offset fix). */
export function wallToUtcIso(dateStr: string, hour: number): string {
  const [y, m, day] = dateStr.split("-").map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, day, hour, 0, 0);
  const first = wallAsUtc - torontoOffsetMinutes(new Date(wallAsUtc)) * 60000;
  const second = wallAsUtc - torontoOffsetMinutes(new Date(first)) * 60000;
  return new Date(second).toISOString();
}

/** Deck hour label: 10 -> "10 a.m.", 12 -> "12 p.m.", 14 -> "2 p.m.". */
export function formatHour(hour: number): string {
  if (hour === 12) return "12 p.m.";
  if (hour === 0) return "12 a.m.";
  if (hour < 12) return `${hour} a.m.`;
  return `${hour - 12} p.m.`;
}

function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const back = (dt.getUTCDay() + 6) % 7;
  return addDays(dateStr, -back);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function openLabel(hours: { opens_at: string; closes_at: string } | undefined): string | null {
  if (!hours) return null;
  const fmt = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    if (m === 0) return formatHour(h);
    return `${formatHour(h).replace(/ [ap]\.m\.$/, "")}:${String(m).padStart(2, "0")} ${h < 12 ? "a.m." : "p.m."}`;
  };
  return `${fmt(hours.opens_at)} to ${fmt(hours.closes_at)}`;
}

/* ---------- Weekly grid (pure, unit tested) ---------- */

export interface SpaceResource {
  id: string; slug: string; name: string; kind: string; booking_mode: string; capacity: number;
}
export interface OpeningHour { weekday: number; opens_at: string; closes_at: string; }
export interface ClosureRow { resource_id: string | null; starts_at: string; ends_at: string; reason: string; }
export interface BookingRow {
  id: string; user_id: string; starts_at: string; ends_at: string; party_size: number;
}

export function buildWeekGrid(opts: {
  resource: SpaceResource;
  hours: OpeningHour[];
  closures: ClosureRow[];
  bookings: BookingRow[];
  userId: string;
  weekStart: string;
  now: Date;
}): {
  resource: SpaceResource; week_start: string;
  days: Array<{
    date: string; label: string; open_label: string | null; closure_reason: string | null;
    slots: Array<{
      start_hour: number; starts_at: string; ends_at: string;
      start_label: string; end_label: string; state: string;
      seats_left: number | null; booking_id: string | null;
    }>;
  }>;
} {
  const { resource, hours, closures, bookings, userId, weekStart, now } = opts;
  const nowMs = now.getTime();
  const days = [];
  for (let i = 0; i < 6; i++) {
    const date = addDays(weekStart, i);
    const [y, m, d] = date.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const dayHours = hours.find((h) => h.weekday === weekday);
    /* Day bounds in Toronto wall time, converted to UTC: a closure
     * ending exactly at Toronto midnight does not close the next day. */
    const dayStartUtc = wallToUtcIso(date, 0);
    const dayEndUtc = wallToUtcIso(addDays(date, 1), 0);
    const dayClosures = closures.filter(
      (cl) => (cl.resource_id === null || cl.resource_id === resource.id) &&
        cl.starts_at < dayEndUtc && cl.ends_at > dayStartUtc,
    );
    const slots = SLOT_HOURS.map((startHour) => {
      const startsAt = wallToUtcIso(date, startHour);
      const endsAt = new Date(new Date(startsAt).getTime() + 2 * 3600 * 1000).toISOString();
      const base = {
        start_hour: startHour, starts_at: startsAt, ends_at: endsAt,
        start_label: formatHour(startHour), end_label: formatHour(startHour + 2),
        seats_left: null as number | null, booking_id: null as string | null,
      };
      if (!dayHours) return { ...base, state: "closed" };
      if (Date.parse(endsAt) <= nowMs) return { ...base, state: "past" };
      if (
        startHour * 60 < minutesOf(dayHours.opens_at) ||
        (startHour + 2) * 60 > minutesOf(dayHours.closes_at) ||
        dayClosures.length > 0
      ) return { ...base, state: "closed" };
      const overlapping = bookings.filter((b) => b.starts_at < endsAt && startsAt < b.ends_at);
      const mine = overlapping.find((b) => b.user_id === userId);
      if (mine) return { ...base, state: "yours", booking_id: mine.id };
      if (resource.booking_mode === "exclusive") {
        if (overlapping.length > 0) return { ...base, state: "booked" };
        return { ...base, state: "free", seats_left: resource.capacity };
      }
      const used = overlapping.reduce((sum, b) => sum + b.party_size, 0);
      if (used >= resource.capacity) return { ...base, state: "booked" };
      return { ...base, state: "free", seats_left: resource.capacity - used };
    });
    days.push({
      date, label: dayLabel(date),
      open_label: openLabel(dayHours),
      closure_reason: dayClosures.length > 0 ? dayClosures[0].reason : null,
      slots,
    });
  }
  return { resource, week_start: weekStart, days };
}

/* ---------- Shared lookups ---------- */

async function listResources(DB: any): Promise<SpaceResource[]> {
  const rows = await DB.prepare(
    `SELECT id, slug, name, kind, booking_mode, capacity FROM space_resources
     WHERE active = 1 AND bookable = 1 ORDER BY name ASC`
  ).all();
  return rows.results || [];
}

async function findResource(DB: any, slug: string): Promise<SpaceResource | null> {
  return (await DB.prepare(
    `SELECT id, slug, name, kind, booking_mode, capacity FROM space_resources
     WHERE slug = ? AND active = 1 AND bookable = 1`
  ).bind(slug).first()) || null;
}

async function openingHours(DB: any): Promise<OpeningHour[]> {
  const rows = await DB.prepare(
    `SELECT weekday, opens_at, closes_at FROM space_opening_hours ORDER BY weekday ASC`
  ).all();
  return rows.results || [];
}

function triggerMessage(err: unknown): string | null {
  const msg = String((err as Error)?.message || err || "");
  if (msg.includes("booking overlaps another booking")) return "Someone just booked that slot. Pick another time.";
  if (msg.includes("over capacity")) return "Over capacity for that time.";
  if (msg.includes("hub is closed")) return "The hub is closed then.";
  if (msg.includes("not bookable")) return "That room cannot be booked right now.";
  if (msg.includes("larger than the room capacity")) return "Your party is larger than the room.";
  return null;
}

/* ---------- Resources and week grid ---------- */

app.get("/resources", requireUser, async (c) => {
  return c.json({ ok: true, resources: await listResources(c.env.DB) });
});

app.get("/week", requireUser, async (c) => {
  const DB = c.env.DB;
  const user = c.get("user") as Session;
  const weekParam = cleanStr(c.req.query("week"), 10);
  const weekStart = mondayOf(DATE_RE.test(weekParam) ? weekParam : torontoDateString(new Date()));
  const resources = await listResources(DB);
  if (resources.length === 0) return c.json({ ok: true, resources: [], week: null });
  const slug = cleanStr(c.req.query("resource"), 60);
  const resource = (slug ? resources.find((r) => r.slug === slug) : resources[0]) || null;
  if (!resource) return c.json({ ok: false, error: "Room not found." }, 404);
  const weekEnd = addDays(weekStart, 7);
  const weekStartIso = `${weekStart}T00:00:00.000Z`;
  const weekEndIso = `${weekEnd}T00:00:00.000Z`;
  const hours = await openingHours(DB);
  const closureRows = await DB.prepare(
    `SELECT resource_id, starts_at, ends_at, reason FROM space_closures
     WHERE ends_at > ? AND starts_at < ? AND (resource_id IS NULL OR resource_id = ?)`
  ).bind(weekStartIso, weekEndIso, resource.id).all();
  const bookingRows = await DB.prepare(
    `SELECT id, user_id, starts_at, ends_at, party_size FROM space_bookings
     WHERE resource_id = ? AND status IN ('confirmed', 'checked_in')
     AND starts_at < ? AND ends_at > ?`
  ).bind(resource.id, weekEndIso, weekStartIso).all();
  return c.json({
    ok: true,
    resources,
    week: buildWeekGrid({
      resource, hours,
      closures: (closureRows.results || []) as unknown as ClosureRow[],
      bookings: (bookingRows.results || []) as unknown as BookingRow[],
      userId: user.userId, weekStart, now: new Date(),
    }),
  });
});

/* ---------- Bookings ---------- */

app.post("/bookings", requireUser, async (c) => {
  const DB = c.env.DB;
  const user = c.get("user") as Session;
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ ok: false, error: "Invalid booking." }, 400);
  const slug = cleanStr(body.resource_slug, 60);
  const date = cleanStr(body.date, 10);
  const startHour = Number(body.start_hour);
  const partySize = body.party_size === undefined ? 1 : Number(body.party_size);
  const purpose = cleanStr(body.purpose, 140);
  if (!slug || !DATE_RE.test(date) || !Number.isInteger(startHour) ||
      !SLOT_HOURS.includes(startHour) || !Number.isInteger(partySize) || partySize < 1) {
    return c.json({ ok: false, error: "Pick a room, a day and a 2-hour slot." }, 400);
  }
  const resource = await findResource(DB, slug);
  if (!resource) return c.json({ ok: false, error: "Room not found." }, 404);
  if (partySize > resource.capacity) {
    return c.json({ ok: false, error: "Your party is larger than the room." }, 409);
  }
  const startsAt = wallToUtcIso(date, startHour);
  const endsAt = new Date(new Date(startsAt).getTime() + 2 * 3600 * 1000).toISOString();
  if (Date.parse(endsAt) <= Date.now()) {
    return c.json({ ok: false, error: "That slot has passed." }, 400);
  }
  const [y, m, d] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const hours = await openingHours(DB);
  const dayHours = hours.find((h) => h.weekday === weekday);
  if (!dayHours || startHour * 60 < minutesOf(dayHours.opens_at) ||
      (startHour + 2) * 60 > minutesOf(dayHours.closes_at)) {
    return c.json({ ok: false, error: "The hub is closed then." }, 409);
  }
  const mineRows = await DB.prepare(
    `SELECT starts_at FROM space_bookings
     WHERE user_id = ? AND resource_id = ? AND status IN ('confirmed', 'checked_in')`
  ).bind(user.userId, resource.id).all();
  const already = (mineRows.results || []).some(
    (b: any) => torontoDateString(new Date(b.starts_at)) === date,
  );
  if (already) {
    return c.json({ ok: false, error: "You already hold a slot in this room that day." }, 409);
  }
  const id = crypto.randomUUID();
  try {
    await DB.prepare(
      `INSERT INTO space_bookings (id, resource_id, user_id, starts_at, ends_at, party_size, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`
    ).bind(id, resource.id, user.userId, startsAt, endsAt, partySize, purpose || null).run();
  } catch (err) {
    const mapped = triggerMessage(err);
    return c.json({ ok: false, error: mapped || "That slot could not be booked." }, 409);
  }
  return c.json({
    ok: true,
    booking: {
      id, resource_slug: resource.slug, resource_name: resource.name,
      starts_at: startsAt, ends_at: endsAt, party_size: partySize,
      purpose: purpose || null, status: "confirmed",
    },
  });
});

app.get("/bookings/mine", requireUser, async (c) => {
  const user = c.get("user") as Session;
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.resource_id, r.name AS resource_name, r.slug AS resource_slug,
            b.starts_at, b.ends_at, b.party_size, b.purpose, b.status
     FROM space_bookings b JOIN space_resources r ON r.id = b.resource_id
     WHERE b.user_id = ? ORDER BY b.starts_at DESC LIMIT 50`
  ).bind(user.userId).all();
  return c.json({ ok: true, bookings: rows.results || [] });
});

app.delete("/bookings/:id", requireUser, async (c) => {
  const DB = c.env.DB;
  const user = c.get("user") as Session;
  const id = cleanStr(c.req.param("id"), 80);
  const row = await DB.prepare(
    `SELECT id, user_id, status FROM space_bookings WHERE id = ?`
  ).bind(id).first<any>();
  if (!row || row.user_id !== user.userId) {
    return c.json({ ok: false, error: "Booking not found." }, 404);
  }
  if (row.status === "cancelled") {
    return c.json({ ok: false, error: "That booking is already cancelled." }, 409);
  }
  if (row.status !== "confirmed" && row.status !== "checked_in") {
    return c.json({ ok: false, error: "That booking cannot be cancelled." }, 409);
  }
  await DB.prepare(
    `UPDATE space_bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), id).run();
  return c.json({ ok: true, booking: { id, status: "cancelled" } });
});

/* ---------- Daily check-in (count only, never names) ---------- */

app.get("/checkins/today", requireUser, async (c) => {
  const today = torontoDateString(new Date());
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM space_checkins WHERE local_date = ?`
  ).bind(today).first<any>();
  return c.json({ ok: true, local_date: today, count: row?.n ?? 0 });
});

app.get("/checkins/mine", requireUser, async (c) => {
  const user = c.get("user") as Session;
  const today = torontoDateString(new Date());
  const row = await c.env.DB.prepare(
    `SELECT local_date, checked_in_at, booking_id FROM space_checkins
     WHERE user_id = ? AND local_date = ?`
  ).bind(user.userId, today).first<any>();
  if (!row) return c.json({ ok: true, checked_in: false, local_date: today });
  return c.json({ ok: true, checked_in: true, local_date: row.local_date, checked_in_at: row.checked_in_at, booking_id: row.booking_id });
});

app.post("/checkins", requireUser, async (c) => {
  const DB = c.env.DB;
  const user = c.get("user") as Session;
  const body = await c.req.json().catch(() => null);
  const bookingId = isRecord(body) ? cleanStr(body.booking_id, 80) : "";
  const today = torontoDateString(new Date());
  const existing = await DB.prepare(
    `SELECT local_date, checked_in_at, booking_id FROM space_checkins
     WHERE user_id = ? AND local_date = ?`
  ).bind(user.userId, today).first<any>();
  if (existing) {
    return c.json({ ok: true, checked_in: true, already: true, local_date: today, checked_in_at: existing.checked_in_at });
  }
  if (bookingId) {
    const booking = await DB.prepare(
      `SELECT id, user_id FROM space_bookings WHERE id = ?`
    ).bind(bookingId).first<any>();
    if (!booking || booking.user_id !== user.userId) {
      return c.json({ ok: false, error: "Booking not found." }, 404);
    }
  }
  const now = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO space_checkins (user_id, local_date, checked_in_at, booking_id)
     VALUES (?, ?, ?, ?)`
  ).bind(user.userId, today, now, bookingId || null).run();
  return c.json({ ok: true, checked_in: true, already: false, local_date: today, checked_in_at: now });
});

/* ---------- Guest passes ---------- */

function guestCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function normalizeCode(code: string): string {
  return cleanStr(code, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

app.post("/guests", requireUser, async (c) => {
  const DB = c.env.DB;
  const user = c.get("user") as Session;
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ ok: false, error: "Invalid guest pass." }, 400);
  const firstName = cleanStr(body.guest_first_name, 40);
  /* Validate the initial before any truncation: "Be" must fail. */
  const lastInitial = cleanStr(body.guest_last_initial, 10).toUpperCase();
  const visitDate = cleanStr(body.visit_date, 10);
  if (!firstName || !/^[A-Z]$/.test(lastInitial) || !DATE_RE.test(visitDate)) {
    return c.json({ ok: false, error: "Give a first name, one last initial and a visit date." }, 400);
  }
  if (visitDate < torontoDateString(new Date())) {
    return c.json({ ok: false, error: "Visit date must be today or later." }, 400);
  }
  const live = await DB.prepare(
    `SELECT COUNT(*) AS n FROM guest_passes
     WHERE host_user_id = ? AND visit_date = ? AND status IN ('issued', 'checked_in')`
  ).bind(user.userId, visitDate).first<any>();
  if ((live?.n ?? 0) >= 2) {
    return c.json({ ok: false, error: "You can bring up to 2 guests a day." }, 409);
  }
  const code = guestCode();
  let hmac: string;
  try {
    hmac = await codeHmac(c.env as { SESSION_SECRET?: string }, "guest-pass", normalizeCode(code));
  } catch {
    return c.json({ ok: false, error: "Guest passes are not available right now." }, 500);
  }
  const id = crypto.randomUUID();
  try {
    await DB.prepare(
      `INSERT INTO guest_passes (id, host_user_id, guest_first_name, guest_last_initial, visit_date, code_hmac, status)
       VALUES (?, ?, ?, ?, ?, ?, 'issued')`
    ).bind(id, user.userId, firstName, lastInitial, visitDate, hmac).run();
  } catch (err) {
    const mapped = triggerMessage(err);
    if (mapped) return c.json({ ok: false, error: mapped }, 409);
    return c.json({ ok: false, error: "That guest pass could not be created." }, 409);
  }
  return c.json({
    ok: true,
    pass: {
      id, code, guest_first_name: firstName, guest_last_initial: lastInitial,
      visit_date: visitDate, status: "issued",
    },
  });
});

app.get("/guests/mine", requireUser, async (c) => {
  const user = c.get("user") as Session;
  const rows = await c.env.DB.prepare(
    `SELECT id, guest_first_name, guest_last_initial, visit_date, status,
            house_rules_version, house_rules_accepted_at, checked_in_at
     FROM guest_passes WHERE host_user_id = ? ORDER BY visit_date DESC, created_at DESC LIMIT 50`
  ).bind(user.userId).all();
  return c.json({ ok: true, passes: rows.results || [] });
});

app.delete("/guests/:id", requireUser, async (c) => {
  const DB = c.env.DB;
  const user = c.get("user") as Session;
  const id = cleanStr(c.req.param("id"), 80);
  const row = await DB.prepare(
    `SELECT id, host_user_id, status FROM guest_passes WHERE id = ?`
  ).bind(id).first<any>();
  if (!row || row.host_user_id !== user.userId) {
    return c.json({ ok: false, error: "Guest pass not found." }, 404);
  }
  if (row.status !== "issued") {
    return c.json({ ok: false, error: "That pass cannot be revoked." }, 409);
  }
  await DB.prepare(`UPDATE guest_passes SET status = 'revoked' WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, pass: { id, status: "revoked" } });
});

async function findPassByCode(DB: any, env: any, code: string): Promise<any | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  let hmac: string;
  try {
    hmac = await codeHmac(env as { SESSION_SECRET?: string }, "guest-pass", normalized);
  } catch {
    return null;
  }
  return (await DB.prepare(
    `SELECT id, host_user_id, guest_first_name, guest_last_initial, visit_date, status,
            house_rules_version, house_rules_accepted_at, checked_in_at
     FROM guest_passes WHERE code_hmac = ?`
  ).bind(hmac).first()) || null;
}

app.post("/guests/accept", async (c) => {
  const DB = c.env.DB;
  if (!(await checkRateLimitD1(DB, "guest-accept:" + clientIp(c.req.raw), 10, 3600))) {
    return c.json({ ok: false, error: "Too many attempts. Try again later." }, 429);
  }
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ ok: false, error: "Invalid pass." }, 400);
  const pass = await findPassByCode(DB, c.env, cleanStr(body.code, 40));
  if (!pass) return c.json({ ok: false, error: "That pass was not found." }, 404);
  if (pass.status === "revoked" || pass.status === "expired") {
    return c.json({ ok: false, error: "That pass is no longer valid." }, 409);
  }
  if (pass.visit_date < torontoDateString(new Date())) {
    return c.json({ ok: false, error: "That visit date has passed." }, 409);
  }
  if (pass.house_rules_accepted_at) {
    return c.json({ ok: true, already: true, pass: { guest_first_name: pass.guest_first_name, guest_last_initial: pass.guest_last_initial, visit_date: pass.visit_date, status: pass.status } });
  }
  await DB.prepare(
    `UPDATE guest_passes SET house_rules_version = '1', house_rules_accepted_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), pass.id).run();
  return c.json({ ok: true, already: false, pass: { guest_first_name: pass.guest_first_name, guest_last_initial: pass.guest_last_initial, visit_date: pass.visit_date, status: pass.status } });
});

app.post("/guests/checkin", async (c) => {
  const DB = c.env.DB;
  if (!(await checkRateLimitD1(DB, "guest-checkin:" + clientIp(c.req.raw), 10, 3600))) {
    return c.json({ ok: false, error: "Too many attempts. Try again later." }, 429);
  }
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ ok: false, error: "Invalid pass." }, 400);
  const pass = await findPassByCode(DB, c.env, cleanStr(body.code, 40));
  if (!pass) return c.json({ ok: false, error: "That pass was not found." }, 404);
  if (pass.status === "revoked" || pass.status === "expired") {
    return c.json({ ok: false, error: "That pass is no longer valid." }, 409);
  }
  if (!pass.house_rules_accepted_at) {
    return c.json({ ok: false, error: "Accept the house rules first." }, 409);
  }
  if (pass.visit_date !== torontoDateString(new Date())) {
    return c.json({ ok: false, error: "The pass works on its visit date only." }, 409);
  }
  if (pass.status === "checked_in") {
    return c.json({ ok: true, already: true, pass: { guest_first_name: pass.guest_first_name, guest_last_initial: pass.guest_last_initial, visit_date: pass.visit_date, status: "checked_in", checked_in_at: pass.checked_in_at } });
  }
  const now = new Date().toISOString();
  await DB.prepare(
    `UPDATE guest_passes SET status = 'checked_in', checked_in_at = ? WHERE id = ?`
  ).bind(now, pass.id).run();
  return c.json({ ok: true, already: false, pass: { guest_first_name: pass.guest_first_name, guest_last_initial: pass.guest_last_initial, visit_date: pass.visit_date, status: "checked_in", checked_in_at: now } });
});

/* ---------- House info ---------- */

app.get("/house", requireUser, async (c) => {
  const sections = await c.env.DB.prepare(
    `SELECT key, title, body_md, section, members_only FROM house_info ORDER BY sort_order ASC`
  ).all();
  const hours = await openingHours(c.env.DB);
  return c.json({
    ok: true,
    house: {
      address: "1365 Gerrard St E, Toronto",
      opening_hours: hours,
      sections: sections.results || [],
    },
  });
});

export default app;
