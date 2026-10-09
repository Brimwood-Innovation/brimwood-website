import { Hono } from "hono";
import introduction from "./routes/introduction";
import newsletter from "./routes/newsletter";
import auth from "./routes/auth";
import password from "./routes/password";
import metrics from "./routes/metrics";
import academy from "./routes/academy";
import enrolment from "./routes/enrolment";
import video from "./routes/video";
import admin from "./routes/admin";
import oauth from "./routes/oauth";
import sync from "./routes/sync";
import media from "./routes/media";
import search from "./routes/search";
import comments from "./routes/comments";
import events from "./routes/events";
import forms from "./routes/forms";
import profiles from "./routes/profiles";
import studio from "./routes/studio";
import { handleScheduled } from "./cron";
import { csrfGuard } from "./lib/csrf";

export type Bindings = {
  DB: D1Database;
  NEWSLETTER_KV: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  SESSIONS_KV: KVNamespace;
  MEDIA: R2Bucket;
  RESEND_API_KEY?: string;
  SITE_URL?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  SYNC_SECRET?: string;
  GITHUB_CONTENT_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS (F3): the site calls the API same-origin via brimwoodinnovation.com/api/*,
// so the production domains get NO CORS headers. The allowlist is for local
// development and Pages preview deployments calling the worker directly.
const ALLOWED_ORIGINS = [
  "http://localhost:4321", // Astro dev server
  "http://localhost:8787", // wrangler dev
  "http://127.0.0.1:4321",
  "http://127.0.0.1:8787",
  "https://brimwood-website-preview.pages.dev",
];

app.use("*", async (c, next) => {
  await next();
  // Security headers on every API response.
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  /* Hardening: HSTS on API responses too — the worker is called directly at
   * its workers.dev origin, which site _headers never covers. */
  c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
});

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  // Exact allowlist plus any branch deploy of the project's own preview site
  // (e.g. https://fix-f3-same-origin.brimwood-website-preview.pages.dev).
  const isAllowlisted =
    !!origin &&
    (ALLOWED_ORIGINS.includes(origin) ||
      /^https:\/\/[a-z0-9-]+\.brimwood-website-preview\.pages\.dev$/.test(origin));
  // Hardening: http:// origins (local dev servers) are only ever reflected
  // when this worker is NOT serving production traffic. On the production API
  // hostname they are never trusted, so a process listening on localhost on a
  // victim's machine cannot make credentialed cross-origin reads of the API.
  // If the API later gains a custom-domain route, add its hostname here.
  const PROD_API_HOSTS = ["brimwood-api.adamsayani.workers.dev"];
  let apiHost = "";
  try {
    apiHost = new URL(c.req.url).hostname;
  } catch {
    apiHost = "";
  }
  const httpOk = !PROD_API_HOSTS.includes(apiHost);
  const isHttp = !!origin && origin.startsWith("http://");
  const allowed = isAllowlisted && (!isHttp || httpOk) ? (origin as string) : "";
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowed,
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-credentials": "true",
        "access-control-max-age": "86400",
      },
    });
  }
  await next();
  if (allowed) {
    c.header("access-control-allow-origin", allowed);
    c.header("access-control-allow-credentials", "true");
  }
});

app.get("/health", (c) => c.json({ ok: true, service: "brimwood-api" }));

/* CSRF guard on every mutating request (F4). */
app.use(csrfGuard);

app.route("/api/introduction", introduction);
app.route("/api/newsletter", newsletter);
app.route("/api/auth", auth);
app.route("/api/auth", password);
app.route("/api/metrics", metrics);
app.route("/api/courses", academy);
app.route("/api", enrolment);
app.route("/api/video", video);
app.route("/api/admin", admin);
app.route("/api/admin/sync", sync);
app.route("/api/oauth", oauth);
app.route("/api", media);
app.route("/api/search", search);
app.route("/api", comments);
app.route("/api", events);
app.route("/api/forms", forms);
app.route("/api/studio", studio);
app.route("/api", profiles);

app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("api error:", err);
  return c.json({ ok: false }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
