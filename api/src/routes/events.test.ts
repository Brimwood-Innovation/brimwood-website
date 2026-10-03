/* Route tests: events — capacity logic, RSVP dedupe, admin gates, best-effort email. */
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

describe("RSVP upsert + email", () => {
  it("re-submitting the same email uses ON CONFLICT (no duplicate rows)", async () => {
    const { env, rsvps } = rsvpEnv();
    const r = await turnstileStub(true);
    try {
      await postJSON(app, "/events/x/rsvp", rsvpBody, env);
      await postJSON(app, "/events/x/rsvp", { ...rsvpBody, guests: 3 }, env);
      const upserts = env.DB.calls.filter((c) => /on\s+conflict/i.test(c.sql));
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
});
