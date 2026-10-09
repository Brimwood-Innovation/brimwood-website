/* F4 acceptance: CSRF guard on every mutating route.
 * The guard is mounted globally (app.use(csrfGuard)), so these tests cover
 * every POST/PATCH/PUT/DELETE route without hand-picking.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { csrfGuard, isAllowedOrigin } from "./csrf";

const ATTACK_ORIGIN = "https://evil.example.com";
const GOOD_ORIGIN = "https://brimwoodinnovation.com";

function testApp() {
  const app = new Hono();
  app.use(csrfGuard);
  for (const m of ["post", "patch", "put", "delete", "get"] as const) {
    app[m]("/thing", (c) => c.json({ ok: true }));
  }
  return app;
}

const attack = {
  headers: { origin: ATTACK_ORIGIN, "content-type": "text/plain" },
};

describe("isAllowedOrigin", () => {
  it("allows the production domains", () => {
    expect(isAllowedOrigin("https://brimwoodinnovation.com")).toBe(true);
    expect(isAllowedOrigin("https://www.brimwoodinnovation.com")).toBe(true);
  });
  it("allows branch preview subdomains", () => {
    expect(isAllowedOrigin("https://fix-f4-csrf.brimwood-website-preview.pages.dev")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("http://brimwoodinnovation.com")).toBe(false);
    expect(isAllowedOrigin("https://brimwoodinnovation.com.evil.com")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});

describe("csrfGuard on mutating routes", () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
    it(`${method}: text/plain from a foreign origin gets 403`, async () => {
      const res = await testApp().request("/thing", {
        method,
        headers: attack.headers,
        body: method === "DELETE" ? undefined : "x=1",
      });
      expect(res.status).toBe(403);
    });

    it(`${method}: application/json from a foreign origin gets 403`, async () => {
      const res = await testApp().request("/thing", {
        method,
        headers: { origin: ATTACK_ORIGIN, "content-type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(res.status).toBe(403);
    });

    it(`${method}: allowed origin with JSON passes the guard`, async () => {
      const res = await testApp().request("/thing", {
        method,
        headers: { origin: GOOD_ORIGIN, "content-type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(res.status).toBe(200);
    });

    it(`${method}: no origin (non-browser client) with JSON passes`, async () => {
      const res = await testApp().request("/thing", {
        method,
        headers: { "content-type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(res.status).toBe(200);
    });
  }

  it("GET from a foreign origin is not blocked", async () => {
    const res = await testApp().request("/thing", { headers: { origin: ATTACK_ORIGIN } });
    expect(res.status).toBe(200);
  });

  it("multipart uploads pass the content-type check (origin still enforced)", async () => {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.png");
    const good = await testApp().request("/thing", {
      method: "POST",
      headers: { origin: GOOD_ORIGIN },
      body: form,
    });
    expect(good.status).toBe(200);
    const bad = await testApp().request("/thing", {
      method: "POST",
      headers: { origin: ATTACK_ORIGIN },
      body: form,
    });
    expect(bad.status).toBe(403);
  });
});

describe("real endpoints reject the CSRF attack", () => {
  it("POST /api/auth/request-code with text/plain from foreign origin gets 403", async () => {
    const { Hono } = await import("hono");
    const authRoutes = (await import("../routes/auth")).default;
    const app = new Hono();
    app.use(csrfGuard);
    app.route("/api/auth", authRoutes);
    const res = await app.request("/api/auth/request-code", {
      method: "POST",
      headers: attack.headers,
      body: "email=a@b.c",
    });
    // 403 from the guard (not 400/429 from the handler) proves the guard ran first.
    expect(res.status).toBe(403);
    const data = (await res.json()) as any;
    expect(data.error).toMatch(/origin|content-type/i);
  });

  it("POST /api/auth/login with text/plain from foreign origin gets 403", async () => {
    const { Hono } = await import("hono");
    const passwordRoutes = (await import("../routes/password")).default;
    const app = new Hono();
    app.use(csrfGuard);
    app.route("/api/auth", passwordRoutes);
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: attack.headers,
      body: "email=a@b.c",
    });
    expect(res.status).toBe(403);
  });

  it("valid JSON login request passes the guard (handler decides the rest)", async () => {
    const { Hono } = await import("hono");
    const { mockEnv } = await import("../test/helpers");
    const passwordRoutes = (await import("../routes/password")).default;
    const app = new Hono();
    app.use(csrfGuard);
    app.route("/api/auth", passwordRoutes);
    const res = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
        body: JSON.stringify({ email: "a@b.c", password: "wrong" }),
      },
      mockEnv() as any
    );
    // Not 403: the guard passed; the handler returns 401/429 for bad creds.
    expect(res.status).not.toBe(403);
  });
});

describe("RFC 8058 one-click unsubscribe exemption", () => {
  async function guardedNewsletterApp() {
    const { Hono } = await import("hono");
    const newsletterRoutes = (await import("../routes/newsletter")).default;
    const app = new Hono();
    app.use(csrfGuard);
    app.route("/api/newsletter", newsletterRoutes);
    return app;
  }

  it("urlencoded one-click POST with no Origin passes the guard", async () => {
    const app = await guardedNewsletterApp();
    const res = await app.request("/api/newsletter/unsubscribe?email=a%40b.co&token=tok", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    // Guard passes (handler then 429/200s on its own — never 403).
    expect(res.status).not.toBe(403);
  });

  it("urlencoded one-click POST with a foreign Origin is still 403", async () => {
    const app = await guardedNewsletterApp();
    const res = await app.request("/api/newsletter/unsubscribe?email=a%40b.co&token=tok", {
      method: "POST",
      headers: { origin: ATTACK_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(403);
  });

  it("urlencoded POST to other paths is still 403", async () => {
    const app = await guardedNewsletterApp();
    const res = await app.request("/api/newsletter", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=a@b.co",
    });
    expect(res.status).toBe(403);
  });
});
