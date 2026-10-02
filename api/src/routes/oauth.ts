/* GitHub OAuth for Decap CMS (T26, hardened 2026-10-02).
 *
 * Flow:
 * 1. Decap → GET /api/oauth/auth → set state cookie → redirect to GitHub authorize
 * 2. GitHub → GET /api/oauth/callback?code=...&state=... → verify state → exchange for token
 * 3. Return token to Decap via postMessage (restricted to SITE_URL origin)
 *
 * Security:
 * - state parameter prevents CSRF (random 32 bytes, httpOnly cookie, 10-min expiry)
 * - postMessage targets SITE_URL only, never "*"
 * - scope is public_repo (repo is public) — least privilege
 *
 * Requires a GitHub OAuth App:
 * - Authorization callback URL: https://brimwood-api.adamsayani.workers.dev/api/oauth/callback
 * - Client ID → GITHUB_CLIENT_ID (wrangler secret)
 * - Client secret → GITHUB_CLIENT_SECRET (wrangler secret)
 */
import { Hono } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings & { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string } }>();

const GITHUB_AUTH = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const STATE_COOKIE = "gh_oauth_state";
const STATE_TTL = 600; // 10 minutes

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Step 1: set state cookie, redirect to GitHub. */
app.get("/auth", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ ok: false, error: "OAuth not configured" }, 500);

  const state = randomState();
  // Signed cookie so the callback can verify the state wasn't tampered with.
  // SESSION_SECRET is the signing key (already used for session cookies).
  await setSignedCookie(c, STATE_COOKIE, state, c.env.SESSION_SECRET || "brimwood-dev", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/oauth",
    maxAge: STATE_TTL,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "public_repo", // repo is public; least privilege
    state,
    redirect_uri: "https://brimwood-api.adamsayani.workers.dev/api/oauth/callback",
  });
  return c.redirect(GITHUB_AUTH + "?" + params.toString());
});

/** Step 2: verify state, exchange code for token. */
app.get("/callback", async (c) => {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = c.env;
  if (!clientId || !clientSecret) {
    return new Response("OAuth not configured", { status: 500 });
  }

  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const storedState = await getSignedCookie(c, c.env.SESSION_SECRET || "brimwood-dev", STATE_COOKIE);

  // Clear the state cookie regardless of outcome (single use).
  deleteCookie(c, STATE_COOKIE, { path: "/api/oauth" });

  if (!code) return new Response("Missing code", { status: 400 });
  if (!returnedState || !storedState || returnedState !== storedState) {
    return new Response("Invalid state — possible CSRF. Please try signing in again.", { status: 403 });
  }

  const tokenRes = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return new Response("Token exchange failed: " + (tokenData.error || "unknown"), { status: 400 });
  }

  // Decap expects a postMessage with the token. Restrict to our site origin.
  const siteUrl = (c.env.SITE_URL || "https://brimwood-website-preview.pages.dev").replace(/\/$/, "");
  const html = `<!doctype html><html><body><script>
    (function() {
      const token = ${JSON.stringify(tokenData.access_token)};
      const targetOrigin = ${JSON.stringify(siteUrl)};
      const msg = "authorization:github:success:" + JSON.stringify({ token, provider: "github" });
      if (window.opener) {
        window.opener.postMessage(msg, targetOrigin);
        window.close();
      } else {
        document.body.textContent = "Login complete. You can close this window.";
      }
    })();
  </script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html" } });
});

export default app;
