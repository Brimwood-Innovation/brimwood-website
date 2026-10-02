import { Hono } from "hono";
import introduction from "./routes/introduction";
import newsletter from "./routes/newsletter";
import auth from "./routes/auth";
import metrics from "./routes/metrics";
import academy from "./routes/academy";

export type Bindings = {
  DB: D1Database;
  NEWSLETTER_KV: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  SESSIONS_KV: KVNamespace;
  MEDIA: R2Bucket;
  RESEND_API_KEY?: string;
  SITE_URL?: string;
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

app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("api error:", err);
  return c.json({ ok: false }, 502);
});

export default app;
