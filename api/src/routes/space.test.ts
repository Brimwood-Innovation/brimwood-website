/* Route tests: hub space - deck section 22 space screen.
 * Weekly grid states in words, 1 slot per room per day, cancel keeps
 * the row, check-in counts only, guest passes HMAC only, and house
 * info never invents unconfirmed accessibility facts.
 */
import { describe, it, expect } from "vitest";
import app, { buildWeekGrid, torontoDateString } from "./space";
import { mockEnv, memberSession, postJSON } from "../test/helpers";
import type { MockEnv } from "../test/helpers";

const FORGE = { id: "res_forge", slug: "forge-room", name: "Forge Room", kind: "room", booking_mode: "exclusive", capacity: 8 };
const BOOTH = { id: "res_booth", slug: "call-booth", name: "Call Booth", kind: "booth", booking_mode: "exclusive", capacity: 1 };
const DESKS = { id: "res_desks", slug: "open-desks", name: "Open Desks", kind: "desk_area", booking_mode: "shared", capacity: 12 };
const HOURS = [
  { weekday: 1, opens_at: "09:00", closes_at: "21:00" },
  { weekday: 2, opens_at: "09:00", closes_at: "21:00" },
  { weekday: 3, opens_at: "09:00", closes_at: "22:00" },
  { weekday: 4, opens_at: "09:00", closes_at: "21:00" },
  { weekday: 5, opens_at: "09:00", closes_at: "21:00" },
  { weekday: 6, opens_at: "10:00", closes_at: "16:00" },
];
const THANKSGIVING = {
  resource_id: null, starts_at: "2026-10-12T04:00:00.000Z",
  ends_at: "2026-10-13T04:00:00.000Z", reason: "Closed for Thanksgiving",
};
/* Toronto is UTC-4 in October 2026 (EDT). */
const FORGE_TUE_2PM = {
  id: "bk-tue", user_id: "member-9", starts_at: "2026-10-13T18:00:00.000Z",
  ends_at: "2026-10-13T20:00:00.000Z", party_size: 3,
};
const FORGE_WED_MINE = {
  id: "bk-wed", user_id: "member-1", starts_at: "2026-10-14T14:00:00.000Z",
  ends_at: "2026-10-14T16:00:00.000Z", party_size: 2,
};
const DESKS_TUE_2PM = {
  id: "bk-desks", user_id: "member-9", starts_at: "2026-10-13T18:00:00.000Z",
  ends_at: "2026-10-13T20:00:00.000Z", party_size: 11,
};

function slotOf(grid: any, dayDate: string, startHour: number) {
  const day = grid.days.find((d: any) => d.date === dayDate);
  return day.slots.find((s: any) => s.start_hour === startHour);
}

describe("week grid", () => {
  const base = {
    resource: FORGE, hours: HOURS, closures: [THANKSGIVING],
    bookings: [FORGE_TUE_2PM, FORGE_WED_MINE], userId: "member-1",
    weekStart: "2026-10-12", now: new Date("2026-10-12T12:00:00.000Z"),
  };
  it("states every cell in words and names the closure", () => {
    const grid = buildWeekGrid(base);
    expect(grid.days.map((d: any) => d.date)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17",
    ]);
    const monday = grid.days[0];
    expect(monday.closure_reason).toBe("Closed for Thanksgiving");
    expect(monday.slots.every((s: any) => s.state === "closed")).toBe(true);
    expect(slotOf(grid, "2026-10-13", 14).state).toBe("booked");
    expect(slotOf(grid, "2026-10-13", 10).state).toBe("free");
    expect(slotOf(grid, "2026-10-13", 20).state).toBe("closed");
    const mine = slotOf(grid, "2026-10-14", 10);
    expect(mine.state).toBe("yours");
    expect(mine.booking_id).toBe("bk-wed");
    expect(slotOf(grid, "2026-10-14", 20).state).toBe("free");
  });

  it("counts shared seats and fills the room", () => {
    const free = buildWeekGrid({ ...base, resource: DESKS, bookings: [DESKS_TUE_2PM] });
    const slot = slotOf(free, "2026-10-13", 14);
    expect(slot.state).toBe("free");
    expect(slot.seats_left).toBe(1);
    const full = buildWeekGrid({
      ...base, resource: DESKS,
      bookings: [{ ...DESKS_TUE_2PM, party_size: 12 }],
    });
    expect(slotOf(full, "2026-10-13", 14).state).toBe("booked");
  });

  it("marks ended slots past and honours Saturday hours", () => {
    const grid = buildWeekGrid({ ...base, now: new Date("2026-10-13T20:00:00.000Z") });
    expect(slotOf(grid, "2026-10-13", 10).state).toBe("past");
    expect(slotOf(grid, "2026-10-13", 14).state).toBe("past");
    expect(slotOf(grid, "2026-10-17", 14).state).toBe("free");
    expect(slotOf(grid, "2026-10-17", 16).state).toBe("closed");
  });
});

function spaceEnv(opts: {
  resources?: any[];
  hours?: any[];
  closures?: any[];
  bookings?: any[];
  mineStarts?: any[];
  mineList?: any[];
  bookingById?: Record<string, any>;
  checkinRow?: any | null;
  todayCount?: number;
  guestLive?: number;
  guestList?: any[];
  guestById?: Record<string, any>;
  passRow?: any | null;
  sections?: any[];
  throwOnInsert?: string;
} = {}) {
  const env = mockEnv();
  const cookie = memberSession(env, "member-1");
  const prev = env.DB.handler;
  const resources = opts.resources ?? [FORGE, BOOTH, DESKS];
  env.DB.handler = (sql: string, params: unknown[]) => {
    if (/FROM space_resources/i.test(sql)) {
      const slug = params[0] as string;
      const row = resources.find((r) => r.slug === slug) || null;
      return { row, results: resources };
    }
    if (/FROM space_opening_hours/i.test(sql)) return { results: opts.hours ?? HOURS };
    if (/FROM space_closures/i.test(sql)) return { results: opts.closures ?? [] };
    if (/FROM space_bookings/i.test(sql) && /JOIN space_resources/i.test(sql)) {
      return { results: opts.mineList ?? [] };
    }
    if (/FROM space_bookings/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      return { row: (opts.bookingById ?? {})[params[0] as string] || null };
    }
    if (/FROM space_bookings/i.test(sql) && /WHERE user_id/i.test(sql)) {
      return { results: opts.mineStarts ?? [] };
    }
    if (/FROM space_bookings/i.test(sql)) return { results: opts.bookings ?? [] };
    if (/FROM space_checkins/i.test(sql) && /COUNT/i.test(sql)) {
      return { row: { n: opts.todayCount ?? 0 } };
    }
    if (/FROM space_checkins/i.test(sql)) return { row: opts.checkinRow ?? null };
    if (/FROM guest_passes/i.test(sql) && /COUNT/i.test(sql)) {
      return { row: { n: opts.guestLive ?? 0 } };
    }
    if (/FROM guest_passes/i.test(sql) && /code_hmac = \?/i.test(sql)) {
      return { row: opts.passRow ?? null };
    }
    if (/FROM guest_passes/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      return { row: (opts.guestById ?? {})[params[0] as string] || null };
    }
    if (/FROM guest_passes/i.test(sql)) return { results: opts.guestList ?? [] };
    if (/FROM house_info/i.test(sql)) return { results: opts.sections ?? [] };
    if (opts.throwOnInsert && /INSERT INTO space_bookings/i.test(sql)) {
      throw new Error(opts.throwOnInsert);
    }
    return prev?.(sql, params);
  };
  return { env, cookie };
}

const get = (env: MockEnv, cookie: Record<string, string>, path: string) =>
  app.request(path, { method: "GET", headers: { ...cookie } }, env as any);
const del = (env: MockEnv, cookie: Record<string, string>, path: string) =>
  app.request(path, { method: "DELETE", headers: { ...cookie } }, env as any);

describe("resources and week", () => {
  it("requires sign-in and never returns floor or access notes", async () => {
    const { env } = spaceEnv();
    const anon = await app.request("/resources", { method: "GET" }, env as any);
    expect(anon.status).toBe(401);
    const { env: env2, cookie } = spaceEnv();
    const res = await get(env2, cookie, "/resources");
    const body: any = await res.json();
    expect(body.resources.map((r: any) => r.slug)).toEqual(["forge-room", "call-booth", "open-desks"]);
    expect(body.resources[0]).not.toHaveProperty("floor");
    expect(body.resources[0]).not.toHaveProperty("accessibility_notes");
  });

  it("returns the chosen room grid with six days", async () => {
    const { env, cookie } = spaceEnv({ closures: [THANKSGIVING], bookings: [FORGE_TUE_2PM] });
    const res = await get(env, cookie, "/week?resource=forge-room&week=2026-10-12");
    const body: any = await res.json();
    expect(body.week.resource.slug).toBe("forge-room");
    expect(body.week.days).toHaveLength(6);
    expect(body.week.days[0].closure_reason).toBe("Closed for Thanksgiving");
  });
});

describe("bookings", () => {
  it("books a 2-hour slot on an even hour", async () => {
    const { env, cookie } = spaceEnv();
    const res = await postJSON(app, "/bookings", {
      resource_slug: "forge-room", date: "2026-11-03", start_hour: 10, party_size: 3, purpose: "Build session",
    }, env, cookie);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.booking.starts_at).toBe("2026-11-03T15:00:00.000Z");
    expect(body.booking.ends_at).toBe("2026-11-03T17:00:00.000Z");
    const row = env.DB.inserts.get("space_bookings")?.[0];
    expect(row?.party_size).toBe(3);
    expect(row?.status).toBe("confirmed");
  });

  it("rejects an odd hour, an oversized party and a second slot that day", async () => {
    const { env, cookie } = spaceEnv();
    const odd = await postJSON(app, "/bookings", {
      resource_slug: "forge-room", date: "2026-11-03", start_hour: 11,
    }, env, cookie);
    expect(odd.status).toBe(400);
    const big = await postJSON(app, "/bookings", {
      resource_slug: "call-booth", date: "2026-11-03", start_hour: 10, party_size: 2,
    }, env, cookie);
    expect(big.status).toBe(409);
    const { env: env2, cookie: cookie2 } = spaceEnv({
      mineStarts: [{ starts_at: "2026-11-03T15:00:00.000Z" }],
    });
    const second = await postJSON(app, "/bookings", {
      resource_slug: "forge-room", date: "2026-11-03", start_hour: 14,
    }, env2, cookie2);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already hold a slot/);
  });

  it("maps a trigger overlap to the deck message", async () => {
    const { env, cookie } = spaceEnv({ throwOnInsert: "booking overlaps another booking" });
    const res = await postJSON(app, "/bookings", {
      resource_slug: "forge-room", date: "2026-11-03", start_hour: 10,
    }, env, cookie);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Someone just booked that slot. Pick another time.");
  });

  it("lists my bookings and cancels only my own", async () => {
    const mine = [{ id: "bk-1", resource_name: "Forge Room", resource_slug: "forge-room", starts_at: "2026-11-03T15:00:00.000Z", ends_at: "2026-11-03T17:00:00.000Z", party_size: 2, purpose: null, status: "confirmed" }];
    const byId = {
      "bk-1": { id: "bk-1", user_id: "member-1", status: "confirmed" },
      "bk-9": { id: "bk-9", user_id: "member-9", status: "confirmed" },
      "bk-done": { id: "bk-done", user_id: "member-1", status: "cancelled" },
    };
    const { env, cookie } = spaceEnv({ mineList: mine, bookingById: byId });
    const list: any = await (await get(env, cookie, "/bookings/mine")).json();
    expect(list.bookings).toHaveLength(1);
    const cancelled: any = await (await del(env, cookie, "/bookings/bk-1")).json();
    expect(cancelled.booking.status).toBe("cancelled");
    expect(env.DB.calls.some((c) => /UPDATE space_bookings SET status = 'cancelled'/i.test(c.sql))).toBe(true);
    const other = await del(env, cookie, "/bookings/bk-9");
    expect(other.status).toBe(404);
    const done = await del(env, cookie, "/bookings/bk-done");
    expect(done.status).toBe(409);
  });
});

describe("check-ins", () => {
  it("checks in once and returns a count, never names", async () => {
    const { env, cookie } = spaceEnv({ checkinRow: null, todayCount: 3 });
    const first: any = await (await postJSON(app, "/checkins", {}, env, cookie)).json();
    expect(first.checked_in).toBe(true);
    expect(first.already).toBe(false);
    expect(env.DB.inserts.get("space_checkins")?.length).toBe(1);
    const { env: env2, cookie: cookie2 } = spaceEnv({
      checkinRow: { local_date: torontoDateString(new Date()), checked_in_at: "2026-10-26T14:00:00.000Z", booking_id: null },
      todayCount: 3,
    });
    const second: any = await (await postJSON(app, "/checkins", {}, env2, cookie2)).json();
    expect(second.already).toBe(true);
    const today: any = await (await get(env2, cookie2, "/checkins/today")).json();
    expect(today.count).toBe(3);
    expect(today).not.toHaveProperty("members");
    expect(today).not.toHaveProperty("names");
  });
});

describe("guest passes", () => {
  it("creates a pass with an HMAC only, never the code", async () => {
    const { env, cookie } = spaceEnv();
    const res = await postJSON(app, "/guests", {
      guest_first_name: "Alex", guest_last_initial: "B", visit_date: "2026-12-01",
    }, env, cookie);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.pass.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const row = env.DB.inserts.get("guest_passes")?.[0];
    expect(row?.code_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hmac).not.toBe(body.pass.code);
    expect(row).not.toHaveProperty("code");
  });

  it("rejects a bad initial and a third guest that day", async () => {
    const { env, cookie } = spaceEnv();
    const bad = await postJSON(app, "/guests", {
      guest_first_name: "Alex", guest_last_initial: "Be", visit_date: "2026-12-01",
    }, env, cookie);
    expect(bad.status).toBe(400);
    const { env: env2, cookie: cookie2 } = spaceEnv({ guestLive: 2 });
    const third = await postJSON(app, "/guests", {
      guest_first_name: "Sam", guest_last_initial: "T", visit_date: "2026-12-01",
    }, env2, cookie2);
    expect(third.status).toBe(409);
  });

  it("lists my passes without codes and revokes my own", async () => {
    const passes = [{ id: "gp-1", guest_first_name: "Alex", guest_last_initial: "B", visit_date: "2026-12-01", status: "issued" }];
    const { env, cookie } = spaceEnv({ guestList: passes, guestById: { "gp-1": { id: "gp-1", host_user_id: "member-1", status: "issued" } } });
    const list: any = await (await get(env, cookie, "/guests/mine")).json();
    expect(list.passes).toHaveLength(1);
    expect(list.passes[0]).not.toHaveProperty("code_hmac");
    const revoked: any = await (await del(env, cookie, "/guests/gp-1")).json();
    expect(revoked.pass.status).toBe("revoked");
  });

  it("accepts house rules then checks in only on the visit date", async () => {
    const today = torontoDateString(new Date());
    const pass = {
      id: "gp-1", host_user_id: "member-1", guest_first_name: "Alex", guest_last_initial: "B",
      visit_date: today, status: "issued", house_rules_version: null,
      house_rules_accepted_at: null, checked_in_at: null,
    };
    const { env } = spaceEnv({ passRow: pass });
    const accepted: any = await (await postJSON(app, "/guests/accept", { code: "ABCD-EFGH-IJKL" }, env)).json();
    expect(accepted.pass.visit_date).toBe(today);
    expect(env.DB.calls.some((c) => /house_rules_version = '1'/i.test(c.sql))).toBe(true);
    const checked = { ...pass, house_rules_accepted_at: "2026-10-26T14:00:00.000Z" };
    const { env: env2 } = spaceEnv({ passRow: checked });
    const res = await postJSON(app, "/guests/checkin", { code: "ABCD-EFGH-IJKL" }, env2);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.pass.status).toBe("checked_in");
    const { env: env3 } = spaceEnv({ passRow: { ...checked, visit_date: "2026-12-01" } });
    const wrongDay = await postJSON(app, "/guests/checkin", { code: "ABCD-EFGH-IJKL" }, env3);
    expect(wrongDay.status).toBe(409);
    expect((await wrongDay.json()).error).toBe("The pass works on its visit date only.");
    const { env: env4 } = spaceEnv({ passRow: null });
    const missing = await postJSON(app, "/guests/accept", { code: "XXXX-XXXX-XXXX" }, env4);
    expect(missing.status).toBe(404);
  });
});

describe("house info", () => {
  it("returns sections and opening hours with the hub address", async () => {
    const sections = [
      { key: "getting_here", title: "Getting here", body_md: "1365 Gerrard St E, Toronto.", section: "getting_here", members_only: 0 },
      { key: "house_rules", title: "House rules", body_md: "Leave rooms as you found them.", section: "house_rules", members_only: 1 },
    ];
    const { env, cookie } = spaceEnv({ sections });
    const body: any = await (await get(env, cookie, "/house")).json();
    expect(body.house.address).toBe("1365 Gerrard St E, Toronto");
    expect(body.house.opening_hours).toHaveLength(6);
    expect(body.house.sections.map((s: any) => s.key)).toEqual(["getting_here", "house_rules"]);
  });
});
