/* Route tests: events - capacity logic, RSVP dedupe, admin gates, best-effort email. */
import { describe, it, expect } from "vitest";
import app from "./events";
import {
  mockEnv,
  adminSession,
  memberSession,
  turnstileStub,
  mailStub,
  mailFailStub,
  postJSON,
  postRaw,
} from "../test/helpers";

const EV = {
  id: "ev-1",
  title: "Demo night",
  starts_at: "2099-06-01T18:00:00.000Z",
  location: "Hub",
  capacity: 10,
};

function rsvpEnv(opts: { rsvps?: { email: string; guests: number }[]; event?: any } = {}) {
  const env = mockEnv();
  const rsvps = opts.rsvps ?? [];
  const ev = "event" in opts ? opts.event : EV;
  env.DB.handler = (sql, params) => {
    if (/from\s+events\s+where\s+slug/i.test(sql)) return { row: ev };
    if (/sum\(guests\)/i.test(sql) && /event_rsvps/i.test(sql)) {
      const exclude = /email\s*!=\s*\?/i.test(sql) ? (params[1] as string) : null;
      const n = rsvps
        .filter((r) => (exclude ? r.email !== exclude : true))
        .reduce((a, r) => a + r.guests, 0);
      return { row: { n } };
    }
  };
  return { env, rsvps };
}

const rsvpBody = {
  name: "Ada",
  email: "ada@example.com",
  guests: 2,
  "cf-turnstile-response": "tok",
};

describe("RSVP validation", () => {
  it("honeypot pretends success and writes nothing", async () => {
    const { env } = rsvpEnv();
    const res = await postJSON(app, "/events/x/rsvp", { ...rsvpBody, website: "bot" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
  });

  it("rejects bad email", async () => {
    const { env } = rsvpEnv();
    const res = await postJSON(app, "/events/x/rsvp", { ...rsvpBody, email: "bad" }, env);
    expect(res.status).toBe(400);
  });

  it("fails closed on Turnstile failure", async () => {
    const { env } = rsvpEnv();
    const r = await turnstileStub(false);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(400);
      expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
    } finally {
      r();
    }
  });

  it("404s on unknown or unpublished event", async () => {
    const { env } = rsvpEnv({ event: null });
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/nope/rsvp", rsvpBody, env);
      expect(res.status).toBe(404);
    } finally {
      r();
    }
  });

  it("rejects RSVP for past events", async () => {
    const { env } = rsvpEnv({ event: { ...EV, starts_at: "2020-01-01T00:00:00.000Z" } });
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/already happened/i);
    } finally {
      r();
    }
  });

  it("rejects malformed JSON with 400 and an error message", async () => {
    const { env } = rsvpEnv();
    const res = await postRaw(app, "/events/x/rsvp", "{{{", env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBeTruthy();
  });

  it("rejects valid-JSON non-object bodies with 400", async () => {
    const { env } = rsvpEnv();
    const res = await postRaw(app, "/events/x/rsvp", "null", env);
    expect(res.status).toBe(400);
    expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
  });
});

describe("capacity logic", () => {
  it("blocks when confirmed guests + new guests exceed capacity", async () => {
    const { env } = rsvpEnv({ rsvps: [{ email: "a@x.co", guests: 9 }] });
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/capacity/i);
      expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
    } finally {
      r();
    }
  });

  it("allows RSVP that exactly fills capacity", async () => {
    const { env } = rsvpEnv({ rsvps: [{ email: "a@x.co", guests: 8 }] });
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(200);
    } finally {
      r();
    }
  });

  it("excludes the submitter's own existing RSVP from the capacity count (update path)", async () => {
    // 8 guests from others + own existing 2 = 10 total, capacity 10.
    // Updating own RSVP from 2 → 2 must NOT be blocked (own 2 excluded: 8 + 2 = 10, not over).
    const { env } = rsvpEnv({
      rsvps: [
        { email: "a@x.co", guests: 8 },
        { email: "ada@example.com", guests: 2 },
      ],
    });
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(200);
    } finally {
      r();
    }
  });

  it("no capacity limit when capacity is null", async () => {
    const { env } = rsvpEnv({
      rsvps: [{ email: "a@x.co", guests: 999 }],
      event: { ...EV, capacity: null },
    });
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(200);
    } finally {
      r();
    }
  });
});

describe("capacity race (check-then-insert)", () => {
  // Simulates a concurrent RSVP landing between our pre-check and our write:
  // the pre-check sum passes, but the post-write sum sees the oversell.
  function raceEnv(withPrior: boolean) {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+events\s+where\s+slug/i.test(sql)) return { row: { ...EV, capacity: 10 } };
      if (/where\s+event_id\s*=\s*\?\s+and\s+email\s*=\s*\?/i.test(sql)) {
        return { row: withPrior ? { id: "r1", name: "Ada", guests: 2, status: "confirmed" } : null };
      }
      if (/sum\(guests\)/i.test(sql)) {
        if (/email\s*!=\s*\?/i.test(sql)) return { row: { n: 0 } }; // pre-check: empty
        return { row: { n: 11 } }; // post-write: oversold
      }
    };
    return env;
  }

  it("post-write oversell is deleted and rejected", async () => {
    const env = raceEnv(false);
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/capacity/i);
      expect(env.DB.calls.some((c) => /delete\s+from\s+event_rsvps/i.test(c.sql))).toBe(true);
    } finally {
      r();
    }
  });

  it("post-write oversell restores the prior RSVP instead of deleting", async () => {
    const env = raceEnv(true);
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(400);
      expect(env.DB.calls.some((c) => /update\s+event_rsvps\s+set/i.test(c.sql))).toBe(true);
      expect(env.DB.calls.some((c) => /delete\s+from\s+event_rsvps/i.test(c.sql))).toBe(false);
    } finally {
      r();
    }
  });
});

describe("RSVP upsert + email", () => {
  it("re-submitting the same email uses ON CONFLICT (no duplicate rows)", async () => {
    const { env, rsvps } = rsvpEnv();
    const r = await turnstileStub(true);
    try {
      await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      await postJSON(app, "/events/x/rsvp", { ...rsvpBody, guests: 3 }, env);
      const upserts = env.DB.calls.filter((c) => /on\s+conflict/i.test(c.sql) && /rsvp/i.test(c.sql));
      expect(upserts.length).toBe(2);
      expect(rsvps).toHaveLength(0); // fake DB: handler owns state, INSERTs are recorded not applied
    } finally {
      r();
    }
  });

  it("sends a confirmation email on success", async () => {
    const { env } = rsvpEnv();
    const sent: { to: string; subject: string }[] = [];
    const r1 = await turnstileStub(true);
    const r2 = mailStub(sent);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("ada@example.com");
    } finally {
      r1();
      r2();
    }
  });

  it("email outage does not lose the RSVP (best-effort)", async () => {
    const { env } = rsvpEnv();
    const r1 = await turnstileStub(true);
    const r2 = mailFailStub();
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(env.DB.inserts.get("event_rsvps")).toHaveLength(1);
    } finally {
      r1();
      r2();
    }
  });
});

describe("public reads", () => {
  it("GET /events/:slug 404s for drafts", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ row: { ...EV, status: "draft" } });
    const res = await app.request("/events/x", {}, env as any);
    expect(res.status).toBe(404);
  });

  it("GET /events only queries published upcoming events", async () => {
    const env = mockEnv();
    let seen = "";
    env.DB.handler = (sql) => {
      seen = sql;
      return { results: [] };
    };
    const res = await app.request("/events", {}, env as any);
    expect(res.status).toBe(200);
    expect(seen).toMatch(/status\s*=\s*'published'/);
  });
});

describe("admin gates", () => {
  it("GET /admin/events rejects anonymous (403)", async () => {
    expect((await app.request("/admin/events", {}, mockEnv() as any)).status).toBe(403);
  });
  it("GET /admin/events rejects members (403)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    expect((await app.request("/admin/events", { headers: h }, env as any)).status).toBe(403);
  });
  it("GET /admin/events/:id/rsvps rejects anonymous (403)", async () => {
    expect((await app.request("/admin/events/e1/rsvps", {}, mockEnv() as any)).status).toBe(403);
  });

  it("POST /admin/events validates start date", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await postJSON(app, "/admin/events", { title: "T", starts_at: "not-a-date" }, env, h);
    expect(res.status).toBe(400);
  });

  it("POST /admin/events maps duplicate slug to 400", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/insert\s+into\s+events/i.test(sql)) throw new Error("UNIQUE constraint failed: events.slug");
      return prev?.(sql, params);
    };
    const res = await postJSON(
      app, "/admin/events", { title: "T", slug: "dup", starts_at: "2099-01-01T10:00:00Z" }, env, h
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/already exists/i);
  });

  it("POST /admin/events rejects valid-JSON non-object bodies with 400", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await postRaw(app, "/admin/events", "null", env, h);
    expect(res.status).toBe(400);
    expect(env.DB.inserts.get("events")).toBeUndefined();
  });
});

describe("DELETE /admin/events/:id", () => {
  it("rejects anonymous (403)", async () => {
    expect((await app.request("/admin/events/e1", { method: "DELETE" }, mockEnv() as any)).status).toBe(403);
  });

  it("rejects members (403)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    expect((await app.request("/admin/events/e1", { method: "DELETE", headers: h }, env as any)).status).toBe(403);
  });

  it("deletes as admin and writes an audit entry", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await app.request("/admin/events/e1", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(200);
    expect(env.DB.inserts.get("audit_log")!.some((l) => l.action === "event.delete")).toBe(true);
  });

  it("404s on unknown id", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/delete\s+from\s+events/i.test(sql)) return { changes: 0 };
      return prev?.(sql, params);
    };
    const res = await app.request("/admin/events/nope", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(404);
  });
});

describe("RSVP by member (Phase 1 item 9)", () => {
  function memberRsvpEnv(prior: any = null) {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+events\s+where\s+slug/i.test(sql)) return { row: EV };
      if (/where\s+event_id\s*=\s*\?\s+and\s+user_id\s*=\s*\?/i.test(sql)) return { row: prior };
      if (/where\s+event_id\s*=\s*\?\s+and\s+email\s*=\s*\?/i.test(sql)) return { row: null };
      if (/sum\(guests\)/i.test(sql)) return { row: { n: 0 } };
    };
    return env;
  }

  it("stores user_id for a signed-in member", async () => {
    const env = memberRsvpEnv();
    const h = memberSession(env, "member-1");
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env, h);
      expect(res.status).toBe(200);
      const rows = env.DB.inserts.get("event_rsvps")!;
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe("member-1");
      expect(rows[0].email).toBe("ada@example.com");
    } finally {
      r();
    }
  });

  it("stores null user_id for a guest", async () => {
    const env = memberRsvpEnv();
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      expect(res.status).toBe(200);
      const rows = env.DB.inserts.get("event_rsvps")!;
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeNull();
    } finally {
      r();
    }
  });

  it("a member re-RSVPing with a new email updates their own row in place", async () => {
    const prior = {
      id: "r1",
      name: "Ada",
      email: "old@example.com",
      guests: 2,
      status: "confirmed",
      user_id: "member-1",
    };
    const env = memberRsvpEnv(prior);
    const h = memberSession(env, "member-1");
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", { ...rsvpBody, email: "new@example.com" }, env, h);
      expect(res.status).toBe(200);
      // No new row: the member's row was updated by id (no ON CONFLICT insert).
      expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
      const updates = env.DB.calls.filter((c) => /update\s+event_rsvps/i.test(c.sql));
      expect(updates).toHaveLength(1);
      expect(updates[0].params).toContain("r1");
    } finally {
      r();
    }
  });

  it("a signed-in member adopts their earlier guest row", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+events\s+where\s+slug/i.test(sql)) return { row: EV };
      if (/where\s+event_id\s*=\s*\?\s+and\s+user_id\s*=\s*\?/i.test(sql)) return { row: null };
      if (/where\s+event_id\s*=\s*\?\s+and\s+email\s*=\s*\?/i.test(sql)) {
        return { row: { id: "r9", name: "Ada", email: "ada@example.com", guests: 2, status: "confirmed", user_id: null } };
      }
      if (/sum\(guests\)/i.test(sql)) return { row: { n: 0 } };
    };
    const h = memberSession(env, "member-1");
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/events/x/rsvp", rsvpBody, env, h);
      expect(res.status).toBe(200);
      expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
      const updates = env.DB.calls.filter((c) => /update\s+event_rsvps/i.test(c.sql));
      expect(updates).toHaveLength(1);
      expect(updates[0].params).toContain("r9");
    } finally {
      r();
    }
  });
});

describe("event room holds (Phase 1 item 20)", () => {
  const ROOM = { id: "room-1", bookable: 1, active: 1, capacity: 50 };

  function holdEnv(opts: { resource?: any; clash?: boolean; closed?: boolean; holdResource?: string | null; eventStatus?: string; updatedEvent?: any } = {}) {
    const env = mockEnv();
    const resource = "resource" in opts ? opts.resource : ROOM;
    const baseEvent = { id: "ev-1", title: "Demo night", starts_at: "2099-06-01T18:00:00.000Z", ends_at: "2099-06-01T20:00:00.000Z", capacity: 40, status: "published" };
    env.DB.handler = (sql) => {
      if (/from\s+space_resources/i.test(sql)) return { row: resource };
      if (/from\s+space_closures/i.test(sql)) return { row: opts.closed ? { 1: 1 } : null };
      if (/select\s+1\s+from\s+space_bookings/i.test(sql)) return { row: opts.clash ? { 1: 1 } : null };
      if (/from\s+space_bookings/i.test(sql)) {
        return { row: opts.holdResource === undefined ? null : opts.holdResource ? { resource_id: opts.holdResource } : null };
      }
      // PATCH reads the status before the update and the full row after it;
      // the mock serves the pre-update status and the post-update row.
      if (/select\s+status\s+from\s+events/i.test(sql)) {
        return { row: { status: opts.eventStatus ?? "published" } };
      }
      if (/from\s+events\s+where\s+id/i.test(sql)) {
        return { row: opts.updatedEvent ?? baseEvent };
      }
    };
    return env;
  }

  const newEvent = {
    title: "Demo night",
    starts_at: "2099-06-01T18:00:00.000Z",
    ends_at: "2099-06-01T21:00:00.000Z",
    capacity: 40,
    space_resource_id: "room-1",
  };

  it("creates minute-aligned hold rows covering the event window", async () => {
    const env = holdEnv();
    const h = adminSession(env);
    const res = await postJSON(app, "/admin/events", newEvent, env, h);
    expect(res.status).toBe(200);
    const events = env.DB.inserts.get("events")!;
    expect(events).toHaveLength(1);
    const holds = env.DB.inserts.get("space_bookings")!;
    // 180 minutes -> 105 + 75 minute chunks (never under the 15-minute minimum).
    expect(holds).toHaveLength(2);
    expect(holds[0].event_id).toBe(events[0].id);
    expect(holds[0].resource_id).toBe("room-1");
    expect(holds[0].user_id).toBe("admin-1");
    expect(holds[0].status).toBe("confirmed");
    expect(holds[0].starts_at).toBe("2099-06-01T18:00:00.000Z");
    expect(holds[0].ends_at).toBe("2099-06-01T19:45:00.000Z");
    expect(holds[1].starts_at).toBe("2099-06-01T19:45:00.000Z");
    expect(holds[1].ends_at).toBe("2099-06-01T21:00:00.000Z");
    expect(holds[0].party_size).toBe(40);
  });

  it("short events get one hold clamped to the 15-minute minimum", async () => {
    const env = holdEnv();
    const h = adminSession(env);
    const res = await postJSON(
      app, "/admin/events",
      { ...newEvent, starts_at: "2099-06-01T18:00:00.000Z", ends_at: "2099-06-01T18:05:00.000Z" },
      env, h
    );
    expect(res.status).toBe(200);
    const holds = env.DB.inserts.get("space_bookings")!;
    expect(holds).toHaveLength(1);
    expect(holds[0].starts_at).toBe("2099-06-01T18:00:00.000Z");
    expect(holds[0].ends_at).toBe("2099-06-01T18:15:00.000Z");
  });

  it("unknown room is a clean 400 with no event row", async () => {
    const env = holdEnv({ resource: null });
    const h = adminSession(env);
    const res = await postJSON(app, "/admin/events", newEvent, env, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/unknown room/i);
    expect(env.DB.inserts.get("events")).toBeUndefined();
    expect(env.DB.inserts.get("space_bookings")).toBeUndefined();
  });

  it("an overlapping booking is a clean 400 with no event row", async () => {
    const env = holdEnv({ clash: true });
    const h = adminSession(env);
    const res = await postJSON(app, "/admin/events", newEvent, env, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/already booked/i);
    expect(env.DB.inserts.get("events")).toBeUndefined();
  });

  it("a closed hub is a clean 400", async () => {
    const env = holdEnv({ closed: true });
    const h = adminSession(env);
    const res = await postJSON(app, "/admin/events", newEvent, env, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/closed/i);
  });

  it("an unbookable room is a clean 400", async () => {
    const env = holdEnv({ resource: { ...ROOM, bookable: 0 } });
    const h = adminSession(env);
    const res = await postJSON(app, "/admin/events", newEvent, env, h);
    expect(res.status).toBe(400);
  });

  it("draft events hold nothing", async () => {
    const env = holdEnv();
    const h = adminSession(env);
    const res = await postJSON(app, "/admin/events", { ...newEvent, status: "draft" }, env, h);
    expect(res.status).toBe(200);
    expect(env.DB.inserts.get("space_bookings")).toBeUndefined();
  });

  it("events without a room hold nothing", async () => {
    const env = holdEnv();
    const h = adminSession(env);
    const { space_resource_id, ...noRoom } = newEvent;
    const res = await postJSON(app, "/admin/events", noRoom, env, h);
    expect(res.status).toBe(200);
    expect(env.DB.inserts.get("space_bookings")).toBeUndefined();
  });

  it("PATCH moving the event time rebuilds the hold", async () => {
    const env = holdEnv({
      holdResource: "room-1",
      updatedEvent: { id: "ev-1", title: "Demo night", starts_at: "2099-06-02T18:00:00.000Z", ends_at: "2099-06-02T19:00:00.000Z", capacity: 40, status: "published" },
    });
    const h = adminSession(env);
    const res = await app.request("/admin/events/ev-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify({ starts_at: "2099-06-02T18:00:00.000Z", ends_at: "2099-06-02T19:00:00.000Z" }),
    }, env as any);
    expect(res.status).toBe(200);
    expect(env.DB.calls.some((c) => /delete\s+from\s+space_bookings/i.test(c.sql))).toBe(true);
    const holds = env.DB.inserts.get("space_bookings")!;
    expect(holds).toHaveLength(1);
    expect(holds[0].starts_at).toBe("2099-06-02T18:00:00.000Z");
    expect(holds[0].ends_at).toBe("2099-06-02T19:00:00.000Z");
  });

  it("PATCH can move the event to another room", async () => {
    const env = holdEnv({ holdResource: "room-1" });
    env.DB.handler = ((prev) => (sql: string, params: unknown[]) => {
      if (/from\s+space_resources/i.test(sql)) return { row: { ...ROOM, id: "room-2" } };
      return (prev as any)?.(sql, params);
    })(env.DB.handler);
    const h = adminSession(env);
    const res = await app.request("/admin/events/ev-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify({ space_resource_id: "room-2" }),
    }, env as any);
    expect(res.status).toBe(200);
    const holds = env.DB.inserts.get("space_bookings")!;
    expect(holds).toHaveLength(1);
    expect(holds[0].resource_id).toBe("room-2");
  });

  it("PATCH with space_resource_id null clears the hold", async () => {
    const env = holdEnv({ holdResource: "room-1" });
    const h = adminSession(env);
    const res = await app.request("/admin/events/ev-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify({ space_resource_id: null }),
    }, env as any);
    expect(res.status).toBe(200);
    expect(env.DB.calls.some((c) => /delete\s+from\s+space_bookings/i.test(c.sql))).toBe(true);
    expect(env.DB.inserts.get("space_bookings")).toBeUndefined();
  });

  it("PATCH cancelling the event cancels its hold", async () => {
    const env = holdEnv({
      holdResource: "room-1",
      updatedEvent: { id: "ev-1", title: "Demo night", starts_at: "2099-06-01T18:00:00.000Z", ends_at: "2099-06-01T20:00:00.000Z", capacity: 40, status: "cancelled" },
    });
    const h = adminSession(env);
    const res = await app.request("/admin/events/ev-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify({ status: "cancelled" }),
    }, env as any);
    expect(res.status).toBe(200);
    const cancels = env.DB.calls.filter((c) => /update\s+space_bookings/i.test(c.sql));
    expect(cancels).toHaveLength(1);
    expect(cancels[0].sql).toMatch(/status\s*=\s*'cancelled'/);
  });

  it("PATCH leaving the room and time alone does not churn the hold", async () => {
    const env = holdEnv({ holdResource: "room-1" });
    const h = adminSession(env);
    const res = await app.request("/admin/events/ev-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify({ title: "Renamed night" }),
    }, env as any);
    expect(res.status).toBe(200);
    expect(env.DB.calls.some((c) => /space_bookings/i.test(c.sql))).toBe(false);
  });
});

describe("hub events (Phase 3 slice 7)", () => {
  const MEMBER = { id: "member-1", name: "Ada", email: "ada@example.com", role: "member", status: "active" };

  function hubEnv(opts: {
    event?: any; prior?: any; sum?: number; list?: any[]; mine?: any[]; cancelChanges?: number;
  } = {}) {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/slug\s*=\s*\?/i.test(sql)) return { row: "event" in opts ? opts.event : EV };
      if (/select\s+event_id,\s*guests,\s*status/i.test(sql)) return { results: opts.mine ?? [] };
      // Cancel UPDATE first: it also contains the event_id/user_id WHERE
      // clause, so the prior-row branch below must not claim it.
      if (/update\s+event_rsvps\s+set\s+status\s*=\s*'cancelled'/i.test(sql)) return { changes: opts.cancelChanges ?? 1 };
      if (/where\s+event_id\s*=\s*\?\s+and\s+user_id\s*=\s*\?/i.test(sql)) return { row: opts.prior ?? null };
      if (/sum\(guests\)/i.test(sql)) return { row: { n: opts.sum ?? 0 } };
      if (/from\s+users/i.test(sql)) return { row: MEMBER };
      if (/from\s+events/i.test(sql)) return { results: opts.list ?? [] };
      return undefined;
    };
    return env;
  }

  it("GET /events?when=past lists past published events, newest first", async () => {
    const env = mockEnv();
    let seen = "";
    env.DB.handler = (sql) => {
      seen = sql;
      return { results: [] };
    };
    const res = await app.request("/events?when=past", {}, env as any);
    expect(res.status).toBe(200);
    expect(seen).toMatch(/status\s*=\s*'published'/);
    expect(seen).toMatch(/starts_at\s*</);
    expect(seen).toMatch(/ORDER BY e\.starts_at DESC/);
  });

  it("GET /events attaches the caller's RSVP and leaves guests at null", async () => {
    const row = { ...EV, kind: "demo_night", number: 42, demo_slots_open: 3, has_recap: 0 };
    const env = hubEnv({ list: [row], mine: [{ event_id: "ev-1", guests: 2, status: "confirmed" }] });
    const h = memberSession(env, "member-1");
    const res = await app.request("/events", { headers: h }, env as any);
    const d: any = await res.json();
    expect(res.status).toBe(200);
    expect(d.events[0].kind).toBe("demo_night");
    expect(d.events[0].number).toBe(42);
    expect(d.events[0].demo_slots_open).toBe(3);
    expect(d.events[0].my_rsvp).toEqual({ status: "confirmed", guests: 2 });
  });

  it("GET /events/:slug carries kind, demo slots, recap flag, and my RSVP", async () => {
    const row = { ...EV, status: "published", kind: "demo_night", number: 42, demo_slots_open: 2, has_recap: 1 };
    const env = hubEnv({ event: row, mine: [{ event_id: "ev-1", guests: 1, status: "confirmed" }] });
    const h = memberSession(env, "member-1");
    const res = await app.request("/events/x", { headers: h }, env as any);
    const d: any = await res.json();
    expect(res.status).toBe(200);
    expect(d.event.kind).toBe("demo_night");
    expect(d.event.has_recap).toBe(1);
    expect(d.event.my_rsvp).toEqual({ status: "confirmed", guests: 1 });
  });

  it("POST my-rsvp requires a session", async () => {
    const env = hubEnv();
    const res = await postJSON(app, "/events/x/my-rsvp", { guests: 1 }, env);
    expect(res.status).toBe(401);
    expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
  });

  it("POST my-rsvp 404s on an unknown event and 400s on a past event", async () => {
    const env = hubEnv({ event: null });
    const h = memberSession(env, "member-1");
    expect((await postJSON(app, "/events/nope/my-rsvp", {}, env, h)).status).toBe(404);
    const past = hubEnv({ event: { ...EV, starts_at: "2020-01-01T18:00:00.000Z" } });
    const h2 = memberSession(past, "member-1");
    expect((await postJSON(app, "/events/x/my-rsvp", {}, past, h2)).status).toBe(400);
    expect(past.DB.inserts.get("event_rsvps")).toBeUndefined();
  });

  it("POST my-rsvp inserts the member's row with their name and email", async () => {
    const env = hubEnv();
    const h = memberSession(env, "member-1");
    const res = await postJSON(app, "/events/x/my-rsvp", { guests: 2 }, env, h);
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("event_rsvps")!;
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe("member-1");
    expect(rows[0].name).toBe("Ada");
    expect(rows[0].email).toBe("ada@example.com");
    expect(rows[0].guests).toBe(2);
    expect(rows[0].status).toBe("confirmed");
  });

  it("POST my-rsvp clamps guests and refuses a full event", async () => {
    const env = hubEnv();
    const h = memberSession(env, "member-1");
    const res = await postJSON(app, "/events/x/my-rsvp", { guests: 99 }, env, h);
    expect(res.status).toBe(200);
    expect(env.DB.inserts.get("event_rsvps")![0].guests).toBe(10);
    const full = hubEnv({ sum: 10 });
    const h2 = memberSession(full, "member-1");
    const res2 = await postJSON(app, "/events/x/my-rsvp", { guests: 1 }, full, h2);
    expect(res2.status).toBe(400);
    expect(full.DB.inserts.get("event_rsvps")).toBeUndefined();
  });

  it("POST my-rsvp updates the member's own row in place", async () => {
    const env = hubEnv({ prior: { id: "r1", guests: 1, status: "confirmed" } });
    const h = memberSession(env, "member-1");
    const res = await postJSON(app, "/events/x/my-rsvp", { guests: 3 }, env, h);
    expect(res.status).toBe(200);
    expect(env.DB.inserts.get("event_rsvps")).toBeUndefined();
    const updates = env.DB.calls.filter((c) => /update\s+event_rsvps/i.test(c.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toContain("r1");
  });

  it("DELETE my-rsvp cancels, and 404s with no RSVP", async () => {
    const env = hubEnv();
    const h = memberSession(env, "member-1");
    const res = await app.request("/events/x/my-rsvp", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(200);
    const none = hubEnv({ cancelChanges: 0 });
    const h2 = memberSession(none, "member-1");
    const res2 = await app.request("/events/x/my-rsvp", { method: "DELETE", headers: h2 }, none as any);
    expect(res2.status).toBe(404);
    const anon = hubEnv();
    const res3 = await app.request("/events/x/my-rsvp", { method: "DELETE" }, anon as any);
    expect(res3.status).toBe(401);
  });
});
