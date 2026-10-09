/* GitHub OAuth tests (audit/auth): state CSRF check (constant-time), PKCE
 * challenge/verifier round-trip, single-use state cookie, validated
 * postMessage target. Mocks fetch — no network. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { getSignedCookie } from "hono/cookie";
import app from "./oauth";
import { mockEnv, stubFetch, type MockEnv } from "../test/helpers";

let env: MockEnv;
let restoreFetch: (() => void) | null = null;

const SECRET = "test_session_secret";

beforeEach(() => {
  env = mockEnv({
    GITHUB_CLIENT_ID: "test_client_id",
    GITHUB_CLIENT_SECRET: "test_client_secret",
    SESSION_SECRET: SECRET,
  } as any);
});

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Start the flow: GET /auth, return { cookie, state, verifier, html }. */
async function startAuth(referer = "https://brimwoodinnovation.com/cms/") {
  const res = await app.request(
    "/auth",
    { headers: { referer } },
    env as any
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") || "";
  const m = setCookie.match(/gh_oauth_state=([^;]+);/);
  expect(m, "state cookie set").not.toBeNull();
  const cookie = `gh_oauth_state=${m![1]}`;

  // Unsign the cookie to read state + verifier (test-only).
  const reader = new Hono();
  reader.get("/read", async (c: any) =>
    c.json({ v: await getSignedCookie(c, SECRET, "gh_oauth_state") })
  );
  const r2 = await reader.request("/read", { headers: { cookie } }, env as any);
  const stored = JSON.parse(((await r2.json()) as any).v);
  return { cookie, state: stored.state as string, verifier: stored.verifier as string, html: await res.text() };
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  new Uint8Array(digest).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("GET /oauth/auth", () => {
  it("sets a signed, httpOnly, single-purpose state cookie", async () => {
    const res = await app.request("/auth", {}, env as any);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("gh_oauth_state=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/oauth");
    expect(setCookie).toContain("Max-Age=600");
  });

  it("sends a PKCE S256 challenge to GitHub", async () => {
    const { verifier, html } = await startAuth();
    expect(verifier).toMatch(/^[0-9a-f]{128}$/);
    const challenge = await s256(verifier);
    expect(html).toContain(`code_challenge=${challenge}`);
    expect(html).toContain("code_challenge_method=S256");
  });

  it("fails closed without a signing key", async () => {
    const noSecret = mockEnv({ GITHUB_CLIENT_ID: "x" } as any);
    delete (noSecret as any).SESSION_SECRET;
    const res = await app.request("/auth", {}, noSecret as any);
    expect(res.status).toBe(500);
  });
});

describe("GET /oauth/callback", () => {
  it("exchanges the code with the PKCE verifier and posts to the validated origin", async () => {
    const { cookie, state, verifier } = await startAuth();
    let exchanged: any = null;
    restoreFetch = stubFetch((url, init) => {
      if (url.includes("github.com/login/oauth/access_token")) {
        exchanged = JSON.parse(String(init?.body || "{}"));
        return json({ access_token: "gh_test_token" });
      }
      throw new Error("unexpected fetch: " + url);
    });

    const res = await app.request(
      `/callback?code=authcode123&state=${state}`,
      { headers: { cookie } },
      env as any
    );
    expect(res.status).toBe(200);
    // PKCE verifier sent at token exchange.
    expect(exchanged.code_verifier).toBe(verifier);
    expect(exchanged.code).toBe("authcode123");
    const html = await res.text();
    // Token delivered to the exact CMS origin that opened the popup — never "*".
    expect(html).toContain('"https://brimwoodinnovation.com"');
    expect(html).not.toContain('postMessage(msg, "*")');
    expect(html).toContain("gh_test_token");
  });

  it("rejects a mismatched state (constant-time compare, 403)", async () => {
    const { cookie } = await startAuth();
    restoreFetch = stubFetch(() => {
      throw new Error("token exchange must not run on bad state");
    });
    const res = await app.request(
      "/callback?code=authcode123&state=wrongstate",
      { headers: { cookie } },
      env as any
    );
    expect(res.status).toBe(403);
  });

  it("rejects a missing state cookie (403)", async () => {
    restoreFetch = stubFetch(() => {
      throw new Error("token exchange must not run without state");
    });
    const res = await app.request("/callback?code=authcode123&state=abc", {}, env as any);
    expect(res.status).toBe(403);
  });

  it("clears the state cookie even on failure (single use)", async () => {
    const { cookie } = await startAuth();
    restoreFetch = stubFetch(() => {
      throw new Error("no exchange");
    });
    const res = await app.request(
      "/callback?code=authcode123&state=wrongstate",
      { headers: { cookie } },
      env as any
    );
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/gh_oauth_state=;/);
  });
});
