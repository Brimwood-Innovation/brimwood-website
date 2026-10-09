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
    // suspended user — the JOIN then yields no session.
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
