/* Admin route behaviour (admin-cms audit): invite validation + revoke,
 * intro 404, audit actor info. */
import { describe, it, expect } from "vitest";
import app from "./admin";
import syncApp from "./sync";
import { mockEnv, adminSession, postJSON } from "../test/helpers";

function getJSON(app: { request: Function }, path: string, env: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: "GET", headers }, env as any);
}

function adminEnv() {
  const env = mockEnv();
  const h = adminSession(env);
  return { env, h };
}

describe("POST /invites validation", () => {
  const cases: [string, unknown, number][] = [
    ["max_uses 0", { max_uses: 0 }, 400],
    ["max_uses negative", { max_uses: -3 }, 400],
    ["max_uses over 100", { max_uses: 101 }, 400],
    ["max_uses non-integer", { max_uses: 2.5 }, 400],
    ["max_uses string", { max_uses: "many" }, 400],
    ["expires_days negative", { expires_days: -5 }, 400],
    ["expires_days over 365", { expires_days: 400 }, 400],
    ["expires_days zero", { expires_days: 0 }, 400],
  ];
  for (const [name, body, status] of cases) {
    it(`rejects ${name}`, async () => {
      const { env, h } = adminEnv();
      const res = await postJSON(app, "/invites", body, env, h);
      expect(res.status).toBe(status);
      expect(((await res.json()) as any).ok).toBe(false);
    });
  }

  it("accepts valid max_uses and expires_days", async () => {
    const { env, h } = adminEnv();
    const res = await postJSON(app, "/invites", { max_uses: 5, expires_days: 30 }, env, h);
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.ok).toBe(true);
    expect(d.code).toMatch(/^BRM-[0-9A-F]{8}$/);
    const rows = env.DB.inserts.get("invite_codes") || [];
    expect(rows[0].max_uses).toBe(5);
    expect(typeof rows[0].expires_at).toBe("string");
  });

  it("defaults to max_uses 1 and no expiry", async () => {
    const { env, h } = adminEnv();
    const res = await postJSON(app, "/invites", {}, env, h);
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("invite_codes") || [];
    expect(rows[0].max_uses).toBe(1);
    expect(rows[0].expires_at).toBeNull();
  });
});

describe("DELETE /invites/:id (revoke)", () => {
  it("404s for an unknown invite", async () => {
    const { env, h } = adminEnv();
    const res = await app.request("/invites/nope", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(404);
  });

  it("deletes and audit-logs a real invite", async () => {
    const { env, h } = adminEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+invite_codes/i.test(sql)) return { row: { code: "BRM-ABCDEFGH" } };
      return prev?.(sql, params);
    };
    const res = await app.request("/invites/inv-1", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(200);
    expect(env.DB.calls.some((c) => /delete\s+from\s+invite_codes/i.test(c.sql))).toBe(true);
    const audits = env.DB.inserts.get("audit_log") || [];
    expect(audits.some((a) => a.action === "invite.revoke" && String(a.detail).includes("BRM-ABCDEFGH"))).toBe(
      true
    );
  });
});

describe("POST /intros/:id", () => {
  it("404s for an unknown intro and writes no audit entry", async () => {
    const { env, h } = adminEnv();
    const res = await postJSON(app, "/intros/nope", { status: "contacted" }, env, h);
    expect(res.status).toBe(404);
    expect(env.DB.inserts.get("audit_log") || []).toEqual([]);
  });

  it("updates and audit-logs a real intro", async () => {
    const { env, h } = adminEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+introduction_requests/i.test(sql)) return { row: { id: "i1" } };
      return prev?.(sql, params);
    };
    const res = await postJSON(app, "/intros/i1", { status: "contacted" }, env, h);
    expect(res.status).toBe(200);
    const audits = env.DB.inserts.get("audit_log") || [];
    expect(audits.some((a) => a.action === "intro.status")).toBe(true);
  });

  it("rejects an invalid status", async () => {
    const { env, h } = adminEnv();
    const res = await postJSON(app, "/intros/i1", { status: "nope" }, env, h);
    expect(res.status).toBe(400);
  });
});

describe("GET /audit", () => {
  it("returns actor id and email per entry", async () => {
    const { env, h } = adminEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+audit_log/i.test(sql)) {
        return {
          results: [
            {
              action: "invite.create",
              target: null,
              detail: "admin@example.com: BRM-ABCDEFGH",
              actor_id: "admin-1",
              actor_email: "admin@example.com",
              created_at: "2026-10-08T00:00:00.000Z",
            },
          ],
        };
      }
      return prev?.(sql, params);
    };
    const res = await getJSON(app, "/audit", env, h);
    const d = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(d.log[0].actor_id).toBe("admin-1");
    expect(d.log[0].actor_email).toBe("admin@example.com");
    expect(d.log[0].action).toBe("invite.create");
  });
});

describe("POST /api/admin/sync/courses rate limit", () => {
  it("429s after 60 requests in the window", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ results: [] });
    const headers = { authorization: "Bearer " + env.SYNC_SECRET };
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await postJSON(syncApp, "/courses", { courses: [] }, env, headers);
    }
    expect(last!.status).toBe(429);
    expect(((await last!.json()) as any).ok).toBe(false);
  });
});

describe("list endpoints", () => {
  it("GET /intros, /subscribers, /users, /invites return ok with an admin session", async () => {
    const { env, h } = adminEnv();
    for (const p of ["/intros", "/subscribers", "/users", "/invites"]) {
      const res = await getJSON(app, p, env, h);
      expect(res.status, p).toBe(200);
      expect(((await res.json()) as any).ok, p).toBe(true);
    }
  });
});
