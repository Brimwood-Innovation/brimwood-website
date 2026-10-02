import { Hono } from "hono";
import introduction from "./routes/introduction";
import newsletter from "./routes/newsletter";
import auth from "./routes/auth";
import metrics from "./routes/metrics";

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

app.get("/health", (c) => c.json({ ok: true, service: "brimwood-api" }));

app.route("/api/introduction", introduction);
app.route("/api/newsletter", newsletter);
app.route("/api/auth", auth);
app.route("/api/metrics", metrics);

app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("api error:", err);
  return c.json({ ok: false }, 502);
});

export default app;
