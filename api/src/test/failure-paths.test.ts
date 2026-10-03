/* C2 failure paths: D1 outages, malformed bodies, unhandled throws.
 * These run through the full app (src/index.ts) so the global onError is
 * exercised: errors must not leak stack traces to clients. */
import { describe, it, expect } from "vitest";
import fullApp from "../index";
import { mockEnv, turnstileStub } from "./helpers";

/** Call the worker entrypoint (default export is { fetch, scheduled }). */
function req(path: string, env: unknown, init: RequestInit = {}) {
  return fullApp.fetch(new Request("https://test.local" + path, init), env as any);
}

function post(path: string, env: unknown, body: unknown, headers: Record<string, string> = {}) {
  return req(path, env, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function throwingEnv(): ReturnType<typeof mockEnv> {
  const env = mockEnv();
  env.DB.handler = () => {
    throw new Error("D1 connection reset by peer\n    at fake stack line");
  };
  return env;
}

describe("D1 outage", () => {
  it("GET /api/search returns 500 with no stack trace", async () => {
    const env = throwingEnv();
    const res = await req("/api/search?q=hello", env);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/stack|D1 connection|at fake/i);
    expect((JSON.parse(body) as any).ok).toBe(false);
  });

  it("GET /api/events returns 500 with no stack trace", async () => {
    const env = throwingEnv();
    const res = await req("/api/events", env);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).ok).toBe(false);
  });

  it("POST /api/comments returns 500 with no stack trace", async () => {
    const env = throwingEnv();
    const r = await turnstileStub(true);
    try {
      const res = await post(
        "/api/comments", env,
        {
          post_slug: "x",
          name: "Ada",
          email: "a@b.co",
          body: "long enough body here",
          "cf-turnstile-response": "tok",
        },
      );
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toMatch(/stack|D1 connection/i);
    } finally {
      r();
    }
  });
});

describe("malformed input at the app level", () => {
  it("POST /api/comments with garbage body → 400, not 500", async () => {
    const env = mockEnv();
    const res = await post("/api/comments", env, "\x00\x01binary");
    expect(res.status).toBe(400);
  });

  it("unknown routes → 404 JSON", async () => {
    const res = await req("/api/nope", mockEnv());
    expect(res.status).toBe(404);
    expect((await res.json()) as any).toEqual({ ok: false, error: "Not found" });
  });

  it("GET /health stays up", async () => {
    const res = await req("/health", mockEnv());
    expect(res.status).toBe(200);
  });
});

describe("security headers on API responses", () => {
  it("sets nosniff + DENY frame options", async () => {
    const res = await req("/health", mockEnv());
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
