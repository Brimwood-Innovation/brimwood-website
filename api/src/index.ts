import { Hono } from "hono";
import introduction from "./routes/introduction";
import newsletter from "./routes/newsletter";
import auth from "./routes/auth";
import metrics from "./routes/metrics";
import academy from "./routes/academy";
import enrolment from "./routes/enrolment";
import video from "./routes/video";
import admin from "./routes/admin";
import oauth from "./routes/oauth";
import sync from "./routes/sync";
import media from "./routes/media";
import { handleScheduled } from "./cron";

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
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS for staging: allow the preview site to call the API directly.
// Production will use same-origin (no CORS needed) when cut over.
const ALLOWED_ORIGINS = [
  "https://brimwood-website-preview.pages.dev",
  "https://brimwoodinnovation.com",
  "https://www.brimwoodinnovation.com",
];

app.use("*", async (c, next) => {
  await next();
  // Security headers on every API response.
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
});

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "";
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowed,
        "access-control-allow-methods": "GET, POST, OPTIONS",
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

app.route("/api/introduction", introduction);
app.route("/api/newsletter", newsletter);
app.route("/api/auth", auth);
app.route("/api/metrics", metrics);
app.route("/api/courses", academy);
app.route("/api", enrolment);
app.route("/api/video", video);
app.route("/api/admin", admin);
app.route("/api/admin/sync", sync);
app.route("/api/oauth", oauth);
app.route("/api", media);

app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("api error:", err);
  return c.json({ ok: false }, 502);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
