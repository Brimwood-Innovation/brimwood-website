/* F3: hardened session cookie tests.
 * Asserts the exact Set-Cookie header on every session-issuing endpoint:
 * `__Host-brimwood-sess=<token>; Path=/; HttpOnly; Secure; SameSite=Lax`.
 * Also asserts the deferred F4 item is gone: no SameSite=None anywhere. */
import { describe, it, expect, beforeEach } from "vitest";
import passwordApp from "./password";
import authApp from "./auth";
import fullApp from "../index";
import { COOKIE, SESSION_COOKIE_ATTRS } from "../lib/auth";
import { mockEnv, postJSON, type MockEnv } from "../test/helpers";
import { hashPassword } from "../lib/password";

/** Call the worker entrypoint so the global CORS middleware runs. */
function fullReq(path: string, env: unknown, init: RequestInit = {}) {
  return fullApp.fetch(new Request("https://test.local" + path, init), env as any);
}

let env: MockEnv;

beforeEach(() => {
  env = mockEnv();
});

function seedPasswordUser() {
  return (async () => {
    const h = await hashPassword("CorrectHorse12");
    const prev = env.DB.handler;
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) {
        return {
          row: {
            id: "user-1",
            email: "user@example.com",
            role: "member",
            status: "active",
            password_hash: h.hash,
            password_salt: h.salt,
          },
        };
      }
      return prev?.(sql, []);
    };
  })();
}

/** Exact header assertions shared by all session-issuing endpoints. */
function expectHardenedCookie(res: Response) {
  const setCookie = res.headers.get("set-cookie") || "";
  expect(setCookie).toContain("__Host-brimwood-sess=");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).not.toContain("SameSite=None");
  expect(setCookie).not.toContain("Domain=");
  const m = setCookie.match(/^__Host-brimwood-sess=([^;]+); Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  expect(m, `exact Set-Cookie format, got: ${setCookie}`).not.toBeNull();
  expect(m![1].length).toBeGreaterThan(0);
}

describe("F3 session cookie hardening", () => {
  it("exports the __Host- cookie name and hardened attributes", () => {
    expect(COOKIE).toBe("__Host-brimwood-sess");
    expect(SESSION_COOKIE_ATTRS).toBe("Path=/; HttpOnly; Secure; SameSite=Lax");
  });

  it("POST /login sets the exact hardened Set-Cookie", async () => {
    await seedPasswordUser();
    const res = await postJSON(
      passwordApp,
      "/login",
      { email: "user@example.com", password: "CorrectHorse12" },
      env
    );
    expect(res.status).toBe(200);
    expectHardenedCookie(res);
  });

  it("logout clears the __Host- cookie", async () => {
    const res = await authApp.request(
      "/logout",
      {
        method: "POST",
        headers: { Cookie: "__Host-brimwood-sess=stale-token" },
      },
      env as any
    );
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("__Host-brimwood-sess=");
    expect(setCookie).not.toContain("SameSite=None");
  });

  it("production origins get no CORS headers (same-origin needs none)", async () => {
    for (const origin of [
      "https://brimwoodinnovation.com",
      "https://www.brimwoodinnovation.com",
    ]) {
      const res = await fullReq("/api/auth/me", env, { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("localhost dev and pages preview origins keep working CORS", async () => {
    for (const origin of [
      "http://localhost:4321",
      "http://localhost:8787",
      "https://brimwood-website-preview.pages.dev",
      "https://fix-f3-same-origin.brimwood-website-preview.pages.dev",
    ]) {
      const res = await fullReq("/api/auth/me", env, { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });
});
