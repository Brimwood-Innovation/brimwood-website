/* GitHub OAuth for Decap CMS (T26, hardened 2026-10-02).
 *
 * Flow:
 * 1. Decap → GET /api/oauth/auth → set state cookie → redirect to GitHub authorize
 * 2. GitHub → GET /api/oauth/callback?code=...&state=... → verify state → exchange for token
 * 3. Return token to Decap via postMessage (restricted to SITE_URL origin)
 *
 * Security:
 * - state parameter prevents CSRF (random 32 bytes, httpOnly cookie, 10-min expiry)
 * - postMessage targets the exact CMS origin that opened the popup (Referer
 *   validated against an allowlist at /auth time), never "*"
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

// Origins allowed to host the CMS. The postMessage target is derived from the
// Referer at /auth time and validated against this list — never "*".
const ALLOWED_CMS_ORIGINS = [
  "https://brimwoodinnovation.com",
  "https://www.brimwoodinnovation.com",
  "https://brimwood-website-preview.pages.dev",
];

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extract a validated CMS origin from the Referer header, or null. */
function cmsOriginFromReferer(c: any): string | null {
  const referer = c.req.header("referer") || c.req.header("referrer") || "";
  if (!referer) return null;
  try {
    const origin = new URL(referer).origin;
    return ALLOWED_CMS_ORIGINS.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** Step 1: set state cookie (state + validated CMS origin), redirect to GitHub. */
app.get("/auth", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ ok: false, error: "OAuth not configured" }, 500);

  const state = randomState();
  // Remember which origin opened the popup so the callback can postMessage
  // back to exactly that origin. Falls back to SITE_URL for old flows.
  const origin = cmsOriginFromReferer(c) || null;
  const cookieValue = JSON.stringify({ state, origin });
  // Signed cookie so the callback can verify the state wasn't tampered with.
  // SESSION_SECRET is the signing key (already used for session cookies).
  await setSignedCookie(c, STATE_COOKIE, cookieValue, c.env.SESSION_SECRET || "brimwood-dev", {
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
  const storedRaw = await getSignedCookie(c, c.env.SESSION_SECRET || "brimwood-dev", STATE_COOKIE);

  // Clear the state cookie regardless of outcome (single use).
  deleteCookie(c, STATE_COOKIE, { path: "/api/oauth" });

  if (!code) return new Response("Missing code", { status: 400 });
  let stored: { state?: string; origin?: string | null } = {};
  try {
    stored = storedRaw ? JSON.parse(storedRaw) : {};
  } catch {
    stored = {};
  }
  if (!returnedState || !stored.state || returnedState !== stored.state) {
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

  // Decap expects a postMessage with the token. Target the exact origin that
  // opened the popup (validated against the allowlist at /auth time), falling
  // back to SITE_URL. Never "*".
  const fallback = (c.env.SITE_URL || "https://brimwood-website-preview.pages.dev").replace(/\/$/, "");
  const targetOrigin =
    stored.origin && ALLOWED_CMS_ORIGINS.includes(stored.origin) ? stored.origin : fallback;
  const html = `<!doctype html><html><body><script>
    (function() {
      const token = ${JSON.stringify(tokenData.access_token)};
      const targetOrigin = ${JSON.stringify(targetOrigin)};
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
