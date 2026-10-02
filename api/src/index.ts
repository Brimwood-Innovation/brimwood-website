import { Hono } from "hono";

export type Bindings = {
  DB: D1Database;
  NEWSLETTER_KV: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  MEDIA: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ ok: true, service: "brimwood-api" }));

export default app;
