/* Admin-gate sweep (C1): EVERY admin-only endpoint must reject
 * unauthenticated requests. Tests each route app standalone, no session. */
import { describe, it, expect } from "vitest";
import adminApp from "./admin";
import mediaApp from "./media";
import commentsApp from "./comments";
import eventsApp from "./events";
import formsApp from "./forms";
import syncApp from "./sync";
import { mockEnv, postJSON } from "../test/helpers";

type Target = { app: { request: Function }; method: string; path: string; body?: unknown; allow?: number[] };

const TARGETS: Target[] = [
  // admin.ts (mounted /api/admin)
  { app: adminApp, method: "GET", path: "/intros" },
  { app: adminApp, method: "POST", path: "/intros/1", body: {} },
  { app: adminApp, method: "GET", path: "/subscribers" },
  { app: adminApp, method: "GET", path: "/invites" },
  { app: adminApp, method: "POST", path: "/invites", body: {} },
  { app: adminApp, method: "DELETE", path: "/invites/abc" },
  { app: adminApp, method: "GET", path: "/users" },
  { app: adminApp, method: "GET", path: "/audit" },
  // media.ts (mounted /api)
  { app: mediaApp, method: "GET", path: "/admin/media" },
  { app: mediaApp, method: "POST", path: "/admin/media", body: {} },
  { app: mediaApp, method: "DELETE", path: "/admin/media/k1" },
  // comments.ts (mounted /api)
  { app: commentsApp, method: "GET", path: "/admin/comments" },
  { app: commentsApp, method: "PATCH", path: "/admin/comments/c1", body: { status: "approved" } },
  // events.ts (mounted /api)
  { app: eventsApp, method: "GET", path: "/admin/events" },
  { app: eventsApp, method: "POST", path: "/admin/events", body: {} },
  { app: eventsApp, method: "PATCH", path: "/admin/events/e1", body: {} },
  { app: eventsApp, method: "GET", path: "/admin/events/e1/rsvps" },
  // forms.ts (mounted /api/forms) — NOTE: GET /admin is shadowed by /:slug
  // (see forms.test.ts); it 404s instead of 403. Both deny access.
  { app: formsApp, method: "GET", path: "/admin", allow: [403, 404] },
  { app: formsApp, method: "POST", path: "/admin", body: {} },
  { app: formsApp, method: "PATCH", path: "/admin/f1", body: {} },
  { app: formsApp, method: "DELETE", path: "/admin/f1" },
  { app: formsApp, method: "GET", path: "/admin/f1/submissions" },
  // sync.ts (mounted /api/admin/sync) — admin session OR Bearer <redacted>
  { app: syncApp, method: "POST", path: "/courses", body: {} },
];

describe("admin gates: unauthenticated requests are rejected", () => {
  for (const t of TARGETS) {
    it(`${t.method} ${t.path}`, async () => {
      const env = mockEnv();
      let res: Response;
      if (t.body !== undefined) {
        res = await t.app.request(
          t.path,
          {
            method: t.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(t.body),
          },
          env as any
        );
      } else {
        res = await t.app.request(t.path, { method: t.method }, env as any);
      }
      expect(t.allow ?? [401, 403], `${t.method} ${t.path} -> ${res.status}`).toContain(res.status);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(false);
    });
  }

  it("sync accepts a valid Bearer <redacted> without a session", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ results: [] });
    const res = await postJSON(
      syncApp,
      "/courses",
      { courses: [] },
      env,
      { authorization: "Bearer " + env.SYNC_SECRET }
    );
    // Bearer <redacted> accepted → proceeds to validation (400 for missing courses array is fine,
    // but here courses:[] is valid so it should get past auth).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("sync rejects a wrong Bearer <redacted>", async () => {
    const env = mockEnv();
    const res = await postJSON(
      syncApp,
      "/courses",
      { courses: [] },
      env,
      { authorization: "Bearer wrong-secret" }
    );
    expect([401, 403]).toContain(res.status);
  });

  it("public media reads stay public (no gate on GET /media/:key)", async () => {
    const env = mockEnv();
    // MEDIA.get returns null in the fake → 404, but crucially NOT 401/403.
    const res = await mediaApp.request("/media/abc", {}, env as any);
    expect([401, 403]).not.toContain(res.status);
  });
});
