/* GitHub OAuth for Decap CMS (T26).
 *
 * Flow:
 * 1. Decap → GET /api/oauth/auth → redirect to GitHub authorize
 * 2. GitHub → GET /api/oauth/callback?code=... → exchange for token
 * 3. Return token to Decap via postMessage
 *
 * Requires a GitHub OAuth App (founder creates):
 * - Authorization callback URL: https://brimwood-api.adamsayani.workers.dev/api/oauth/callback
 * - Client ID → GITHUB_CLIENT_ID (wrangler secret)
 * - Client secret → GITHUB_CLIENT_SECRET (wrangler secret)
 */
import { Hono } from "hono";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings & { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string } }>();

const GITHUB_AUTH = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";

/** Step 1: redirect to GitHub. */
app.get("/auth", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ ok: false, error: "OAuth not configured" }, 500);

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "repo",
    // Decap expects the callback to postMessage back to the opener.
    redirect_uri: "https://brimwood-api.adamsayani.workers.dev/api/oauth/callback",
  });
  return c.redirect(GITHUB_AUTH + "?" + params.toString());
});

/** Step 2: GitHub redirects here with ?code=. Exchange for a token. */
app.get("/callback", async (c) => {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = c.env;
  if (!clientId || !clientSecret) {
    return new Response("OAuth not configured", { status: 500 });
  }

  const code = c.req.query("code");
  if (!code) return new Response("Missing code", { status: 400 });

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

  // Decap expects a postMessage with the token in a specific format.
  const html = `<!doctype html><html><body><script>
    (function() {
      const token = ${JSON.stringify(tokenData.access_token)};
      const msg = "authorization:github:success:" + JSON.stringify({ token, provider: "github" });
      if (window.opener) {
        window.opener.postMessage(msg, "*");
        window.close();
      } else {
        document.body.textContent = "Login complete. You can close this window.";
      }
    })();
  </script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html" } });
});

export default app;
