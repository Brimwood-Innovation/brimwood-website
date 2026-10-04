/* F5 acceptance: one auth module.
 * - Sessions are keyed by SHA-256 of the token (no raw "sess:"+token in routes).
 * - requireAdmin re-reads the role from D1, so a demoted admin is locked out
 *   on the very next request.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mockEnv, adminSession } from "../test/helpers";
import { requireAdmin, getAdminUser, hashToken } from "./auth";

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
    expect(res.status).toBe(403);
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
