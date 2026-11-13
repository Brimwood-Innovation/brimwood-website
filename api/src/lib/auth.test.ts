/* F5 acceptance: one auth module.
 * - Sessions are keyed by SHA-256 of the token (no raw "sess:"+token in routes).
 * - requireAdmin re-reads the role from D1, so a demoted admin is locked out
 *   on the very next request.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mockEnv, adminSession, memberSession } from "../test/helpers";
import { requireAdmin, getAdminUser, hashToken, isAdminUser, destroyOtherUserSessions, createSession, readSession } from "./auth";

describe("hashToken", () => {
  it("produces the SHA-256 hex of the token", async () => {
    const h = await hashToken("tok-admin");
    expect(h).toBe(
      "df6adb0b23fa33235f4aee6a0d62c118b00d71c07c81be87067b4f5892e66dbc"
    );
  });

  it("never returns the raw token", async () => {
    const h = await hashToken("secret-token");
    expect(h).not.toContain("secret-token");
    expect(h).toHaveLength(64);
  });
});

describe("requireAdmin re-reads role from D1", () => {
  const buildApp = () => {
    const app = new Hono();
    app.use(requireAdmin);
    app.get("/secret", (c: any) => c.json({ ok: true, admin: c.get("admin") }));
    return app;
  };

  it("allows a current admin", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await buildApp().request("/secret", { headers: h }, env as any);
    expect(res.status).toBe(200);
  });

  it("locks out a demoted admin on the next request", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    // First request: admin.
    expect((await buildApp().request("/secret", { headers: h }, env as any)).status).toBe(200);
    // Demote in D1.
    env.DB.handler = (sql: string) => {
      if (/from\s+users/i.test(sql))
        return { row: { id: "admin-1", email: "admin@example.com", role: "member", status: "active" } };
    };
    // Next request: 403.
    const res = await buildApp().request("/secret", { headers: h }, env as any);
    expect(res.status).toBe(403);
  });

  it("locks out a deactivated admin on the next request", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    // The mock D1 must honour the status='active' filter: no row returned.
    env.DB.handler = (sql: string) => {
      if (/from\s+users/i.test(sql)) return { row: null };
    };
    const res = await buildApp().request("/secret", { headers: h }, env as any);
    // readSession itself now rejects suspended users (JOIN on users), so the
    // session is dead → 401. Either way, the deactivated admin is locked out.
    expect(res.status).toBe(401);
  });

  it("returns 401 with no session", async () => {
    const env = mockEnv();
    const res = await buildApp().request("/secret", {}, env as any);
    expect(res.status).toBe(401);
  });
});

describe("getAdminUser", () => {
  it("returns null for a member session", async () => {
    const { memberSession } = await import("../test/helpers");
    const env = mockEnv();
    const h = memberSession(env);
    const app = new Hono();
    app.get("/who", async (c: any) => c.json({ admin: await getAdminUser(c) }));
    const res = await app.request("/who", { headers: h }, env as any);
    expect((await res.json() as any).admin).toBeNull();
  });

  it("returns the admin for an admin session", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const app = new Hono();
    app.get("/who", async (c: any) => c.json({ admin: await getAdminUser(c) }));
    const res = await app.request("/who", { headers: h }, env as any);
    const data = (await res.json()) as any;
    expect(data.admin.id).toBe("admin-1");
  });
});

describe("isAdminUser re-reads role from D1", () => {
  const buildApp = () => {
    const app = new Hono();
    app.get("/check", async (c: any) => {
      const s = await (await import("./auth")).readSession(c);
      return c.json({ admin: s ? await isAdminUser(c, s.userId) : false });
    });
    return app;
  };

  it("is true for a current admin even when the session row is stale", async () => {
    const env = mockEnv();
    // Session row says member (stale cache); D1 says admin.
    const h = memberSession(env, "admin-1");
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: { role: "admin" } };
      return prev?.(sql, params);
    };
    const res = await buildApp().request("/check", { headers: h }, env as any);
    expect(((await res.json()) as any).admin).toBe(true);
  });

  it("is false for a demoted admin even when the session row still says admin", async () => {
    const env = mockEnv();
    // Session row says admin (stale cache); D1 says member.
    const h = adminSession(env);
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql))
        return { row: { id: "admin-1", email: "admin@example.com", role: "member", status: "active" } };
      return prev?.(sql, params);
    };
    const res = await buildApp().request("/check", { headers: h }, env as any);
    expect(((await res.json()) as any).admin).toBe(false);
  });

  it("is false for a suspended admin", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    // The mock D1 must honour the status='active' filter: no row returned
    // for a suspended user (same convention as the requireAdmin tests).
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: null };
      return prev?.(sql, params);
    };
    const res = await buildApp().request("/check", { headers: h }, env as any);
    expect(((await res.json()) as any).admin).toBe(false);
  });
});

describe("destroyOtherUserSessions", () => {  it("deletes every session except the current one", async () => {
    const env = mockEnv();
    const keep = await createSession(env as any, "user-1", "member");
    const gone1 = await createSession(env as any, "user-1", "member");
    const gone2 = await createSession(env as any, "user-1", "member");
    const other = await createSession(env as any, "user-2", "member");
    expect(env.DB.sessionStore.size).toBe(4);

    await destroyOtherUserSessions(env as any, "user-1", await hashToken(keep));

    const keys = [...env.DB.sessionStore.keys()];
    expect(keys).toHaveLength(2);
    expect(keys).toContain("sess:" + (await hashToken(keep)));
    expect(keys).toContain("sess:" + (await hashToken(other)));
    expect(env.DB.sessionStore.has("sess:" + (await hashToken(gone1)))).toBe(false);
    expect(env.DB.sessionStore.has("sess:" + (await hashToken(gone2)))).toBe(false);
  });
});

describe("readSession re-validates status and role from D1", () => {
  const buildApp = () => {
    const app = new Hono();
    app.get("/who", async (c: any) => {
      const s = await readSession(c);
      return c.json(s ? { userId: s.userId, role: s.role } : { userId: null });
    });
    return app;
  };

  it("locks out a suspended user immediately (no waiting for session expiry)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    // The mock D1 honours the status='active' filter: no row for a
    // suspended user; the JOIN then yields no session.
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: null };
      return prev?.(sql, params);
    };
    const res = await buildApp().request("/who", { headers: h }, env as any);
    expect(((await res.json()) as any).userId).toBeNull();
  });

  it("returns the live role, not the login-time cached role", async () => {
    const env = mockEnv();
    const h = memberSession(env); // session row was cached as member
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql))
        return { row: { id: "member-1", role: "admin", status: "active" } };
      return prev?.(sql, params);
    };
    const res = await buildApp().request("/who", { headers: h }, env as any);
    expect(((await res.json()) as any).role).toBe("admin");
  });

  it("returns null when the user row is gone (hard delete)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: null };
      return prev?.(sql, params);
    };
    const res = await buildApp().request("/who", { headers: h }, env as any);
    expect(((await res.json()) as any).userId).toBeNull();
  });
});

/* Phase 1 item 6 (SCHEMA section 7): the S6 sign-in context. Sessions carry
 * amr, auth_time, is_staff, ua_summary, city, device_id; staff sessions are
 * capped at 12 hours; revoked sessions are rejected by readSession. */
import { requireUser, summarizeUa, cfCity, STAFF_SESS_TTL_MS } from "./auth";

describe("createSession S6 context", () => {
  it("writes the sign-in context for a member session with a 30-day TTL", async () => {
    const env = mockEnv();
    const before = Date.now();
    const token = await createSession(env as any, "user-1", "member", {
      amr: ["email_code"],
      uaSummary: "iPhone, Safari",
      city: "Toronto",
    });
    expect(token).toBeTruthy();
    expect(env.DB.sessionStore.size).toBe(1);
    const sess = [...env.DB.sessionStore.values()][0];
    expect(sess.amr).toBe(JSON.stringify(["email_code"]));
    expect(sess.auth_time).toBe(sess.created_at);
    expect(sess.auth_time).toBeGreaterThanOrEqual(before);
    expect(sess.is_staff).toBe(0);
    expect(sess.ua_summary).toBe("iPhone, Safari");
    expect(sess.city).toBe("Toronto");
    expect(sess.device_id).toBeNull();
    expect(sess.expires_at - sess.created_at).toBe(30 * 24 * 3600 * 1000);
  });

  it("caps staff sessions at 12 hours", async () => {
    const env = mockEnv();
    await createSession(env as any, "admin-1", "admin", { amr: ["passkey"] });
    const sess = [...env.DB.sessionStore.values()][0];
    expect(sess.is_staff).toBe(1);
    expect(sess.expires_at - sess.created_at).toBe(STAFF_SESS_TTL_MS);
    expect(STAFF_SESS_TTL_MS).toBe(12 * 3600 * 1000);
  });

  it("defaults the S6 context to empty when no options are given", async () => {
    const env = mockEnv();
    await createSession(env as any, "user-1", "member");
    const sess = [...env.DB.sessionStore.values()][0];
    expect(sess.amr).toBe("[]");
    expect(sess.ua_summary).toBeNull();
    expect(sess.city).toBeNull();
    expect(sess.device_id).toBeNull();
  });
});

describe("readSession rejects revoked sessions", () => {
  const buildApp = () => {
    const app = new Hono();
    app.use(requireUser);
    app.get("/me", (c: any) => c.json({ ok: true, user: c.get("user") }));
    return app;
  };

  it("returns 401 once the session is revoked", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    expect((await buildApp().request("/me", { headers: h }, env as any)).status).toBe(200);
    const [key] = [...env.DB.sessionStore.keys()];
    env.DB.sessionStore.get(key)!.revoked_at = Date.now();
    expect((await buildApp().request("/me", { headers: h }, env as any)).status).toBe(401);
  });
});

describe("summarizeUa", () => {
  it("summarizes common agents as OS, Browser", () => {
    expect(
      summarizeUa(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
      )
    ).toBe("iPhone, Safari");
    expect(
      summarizeUa(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      )
    ).toBe("Windows, Chrome");
    expect(
      summarizeUa(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      )
    ).toBe("Mac, Safari");
  });

  it("never stores the full UA string", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
    const summary = summarizeUa(ua)!;
    expect(summary).toBe("Linux, Firefox");
    expect(summary.length).toBeLessThan(ua.length);
    expect(summary).not.toContain("rv:133.0");
  });

  it("falls back gracefully on missing or unrecognised input", () => {
    expect(summarizeUa(null)).toBeNull();
    expect(summarizeUa("")).toBeNull();
    expect(summarizeUa("SomeBot/9.9")).toBe("Unknown OS, Unknown browser");
  });
});

describe("cfCity", () => {
  const ctx = (cf: any) => ({ req: { raw: { cf } } }) as any;

  it("reads the city from the Cloudflare request properties", () => {
    expect(cfCity(ctx({ city: "Toronto" }))).toBe("Toronto");
  });

  it("returns null when no city is present, and never reads the IP", () => {
    expect(cfCity(ctx(undefined))).toBeNull();
    expect(cfCity(ctx({}))).toBeNull();
    expect(cfCity(ctx({ city: "  " }))).toBeNull();
    expect(cfCity(ctx({ city: "Toronto", colo: "YYZ" }))).toBe("Toronto");
  });
});
