/* GitHub OAuth for Decap CMS (T26, hardened 2026-10-02, handshake fixed 2026-10-03).
 *
 * Flow:
 * 1. Decap → popup GET /api/oauth/auth → handshake page posts
 *    "authorizing:github" to opener, waits for Decap's echo, then
 *    navigates the popup to GitHub authorize (state in signed cookie)
 * 2. GitHub → GET /api/oauth/callback?code=...&state=... → verify state → exchange for token
 * 3. Return token to Decap via postMessage (restricted to the validated CMS origin)
 *
 * Decap's NetlifyAuthenticator REQUIRES the step-1 handshake before it will
 * accept the token in step 3 — without it Decap stays on the login screen.
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
import { safeEqual } from "../lib/safe-equal";
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

/* PKCE (RFC 7636, S256): the verifier lives only in the signed state
 * cookie; the challenge goes to GitHub. Even if the authorization code
 * leaked, it cannot be exchanged without the verifier. */
function randomVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  new Uint8Array(digest).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

/** Step 1: set state cookie, render the handshake page.
 *
 * Decap's NetlifyAuthenticator requires a two-message handshake before it
 * will accept the token:
 *   1. popup -> opener: "authorizing:github"   (Decap verifies e.origin)
 *   2. opener -> popup: echo "authorizing:github"
 *   3. popup -> opener: "authorization:github:success:{...}" (in /callback)
 * Skipping straight to step 3 means Decap ignores the token and stays on
 * the login screen. The handshake string carries no secrets, so "*" is a
 * safe target here; the token in step 3 still targets the validated origin.
 */
app.get("/auth", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ ok: false, error: "OAuth not configured" }, 500);

  const state = randomState();
  const verifier = randomVerifier();
  const challenge = await s256Challenge(verifier);
  // Remember which origin opened the popup so the token postMessage in
  // /callback targets exactly that origin. Falls back to SITE_URL.
  const fallback = (c.env.SITE_URL || "https://brimwood-website-preview.pages.dev").replace(/\/$/, "");
  const origin = cmsOriginFromReferer(c) || fallback;
  const cookieValue = JSON.stringify({ state, origin, verifier });
  // Signed cookie so the callback can verify the state wasn't tampered with.
  // SESSION_SECRET is the signing key. Fail closed if unset — never fall back
  // to a hardcoded key (M3).
  const signingKey = c.env.SESSION_SECRET;
  if (!signingKey) return c.json({ ok: false, error: "OAuth not configured" }, 500);
  await setSignedCookie(c, STATE_COOKIE, cookieValue, signingKey, {
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
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: "https://brimwood-api.adamsayani.workers.dev/api/oauth/callback",
  });
  const githubUrl = GITHUB_AUTH + "?" + params.toString();

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
    (function() {
      var HANDSHAKE = "authorizing:github";
      var githubUrl = ${JSON.stringify(githubUrl)};
      var openerOrigin = ${JSON.stringify(origin)};
      var done = false;
      function show(msg) { document.body.textContent = msg; }
      function go() {
        if (done) return;
        done = true;
        window.location.href = githubUrl;
      }
      // Step 2: wait for Decap to echo the handshake, then go to GitHub.
      window.addEventListener("message", function(e) {
        if (e.data === HANDSHAKE && e.origin === openerOrigin) go();
      });
      // Step 1: initiate the handshake.
      function ping() {
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(HANDSHAKE, "*");
            return true;
          }
        } catch (err) { /* cross-origin opener access can throw on read */ }
        show("Login couldn't start: no connection to the CMS window. Please allow popups for this site, then close this window and try again.");
        return false;
      }
      if (ping()) {
        var n = 0;
        var t = setInterval(function() {
          n += 1;
          if (n >= 8 || done) {
            clearInterval(t);
            if (!done) show("Still waiting for the CMS — if this persists, close this window and try again.");
            return;
          }
          ping();
        }, 400);
      }
    })();
  </script></body></html>`;
  // NOTE: use c.html(), not `new Response()` — returning a raw Response
  // discards the Set-Cookie header staged by setSignedCookie above, which
  // breaks the state check in /callback ("Invalid state" on every attempt).
  return c.html(html);
});

/** Step 2: verify state, exchange code for token. */
app.get("/callback", async (c) => {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = c.env;
  if (!clientId || !clientSecret) {
    return c.text("OAuth not configured", 500);
  }

  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  // Fail closed if the signing key is unset (M3) — never verify with a default.
  const signingKey = c.env.SESSION_SECRET;
  if (!signingKey) {
    return c.text("OAuth not configured", 500);
  }
  const storedRaw = await getSignedCookie(c, signingKey, STATE_COOKIE);

  // Clear the state cookie regardless of outcome (single use). NOTE: the
  // responses below MUST go through c.text()/c.html() — returning a raw
  // Response would discard this staged Set-Cookie header (same trap as the
  // setSignedCookie note in /auth above).
  deleteCookie(c, STATE_COOKIE, { path: "/api/oauth" });

  if (!code) return c.text("Missing code", 400);
  let stored: { state?: string; origin?: string | null; verifier?: string } = {};
  try {
    stored = storedRaw ? JSON.parse(storedRaw) : {};
  } catch {
    stored = {};
  }
  // Constant-time state compare (house rule: never === on secrets).
  if (!returnedState || !stored.state || !safeEqual(returnedState, stored.state)) {
    return c.text("Invalid state — possible CSRF. Please try signing in again.", 403);
  }
  if (!stored.verifier) {
    return c.text("Invalid state — please try signing in again.", 403);
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
      code_verifier: stored.verifier,
    }),
  });
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.text("Token exchange failed: " + (tokenData.error || "unknown"), 400);
  }

  // Decap expects a postMessage with the token. Target the exact origin that
  // opened the popup (validated against the allowlist at /auth time), falling
  // back to SITE_URL. Never "*".
  const fallback = (c.env.SITE_URL || "https://brimwood-website-preview.pages.dev").replace(/\/$/, "");
  const targetOrigin =
    stored.origin && ALLOWED_CMS_ORIGINS.includes(stored.origin) ? stored.origin : fallback;
  const html = `<!doctype html><html><body><script>
    (function() {
      const token = ${JSON.stringify(tokenData.access_token).replace(/</g, "\\u003c")};
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
  // c.html() preserves the deleteCookie header staged above (single-use state).
  return c.html(html);
});

export default app;
