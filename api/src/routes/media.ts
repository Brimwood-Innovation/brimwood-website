/* Media library (R2 brimwood-media bucket).
 *
 * Admin endpoints (require admin role, 403 otherwise):
 * - GET    /api/admin/media?prefix=&cursor= → list objects (key, size, uploaded)
 * - POST   /api/admin/media (multipart, field "file") → upload.
 *          Max 10 MB; PNG, JPG, WEBP, GIF, SVG, MP4 only.
 *          Returns { key, url } where url is the public serving URL.
 * - DELETE /api/admin/media/:key → delete object. Key is sanitized
 *          (flat keys only, no "..", no leading "/") to block traversal.
 *
 * Public:
 * - GET /api/media/:key → serve object with stored content-type and
 *   long-lived immutable cache headers. Keys are unique per upload, so
 *   caching aggressively is safe.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();
const COOKIE = "brimwood_sess";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const LIST_LIMIT = 60;

/** MIME type → extension. Extension is derived from the MIME type, never
 *  from the client-supplied filename. */
const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
};

/** Fallback content-type when an object has no stored httpMetadata. */
const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
};

async function adminUser(c: any): Promise<{ id: string; email: string } | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const raw = await c.env.SESSIONS_KV.get("sess:" + token);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s.role !== "admin") return null;
    const u: any = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(s.userId)
      .first();
    return { id: s.userId, email: u?.email || "unknown" };
  } catch {
    return null;
  }
}

function needAdmin(c: any, admin: any) {
  if (!admin) return c.json({ ok: false, error: "Admin only" }, 403);
  return null;
}

async function audit(c: any, admin: { id: string; email: string }, action: string, detail: string) {
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), admin.id, action, `${admin.email}: ${detail}`)
    .run();
}

/** Key sanity: generated keys are flat (no slashes). Rejects "..",
 *  leading "/", overlong keys, and anything outside a safe charset. */
function cleanKey(raw: string | undefined): string | null {
  if (!raw || raw.length > 200) return null;
  if (raw.includes("..") || raw.startsWith("/")) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) return null;
  return raw;
}

/* --- Admin: list objects --- */

app.get("/admin/media", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;

  const prefix = (c.req.query("prefix") || "").slice(0, 100);
  if (prefix && !/^[a-zA-Z0-9._-]+$/.test(prefix)) {
    return c.json({ ok: false, error: "Invalid prefix" }, 400);
  }
  const cursor = c.req.query("cursor") || undefined;

  const listed = await c.env.MEDIA.list({
    prefix: prefix || undefined,
    cursor,
    limit: LIST_LIMIT,
  });

  return c.json({
    ok: true,
    objects: listed.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded.toISOString(),
    })),
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
  });
});

/* --- Admin: upload --- */

app.post("/admin/media", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;

  let file: File | null = null;
  try {
    const body = await c.req.parseBody();
    const f = body["file"];
    if (f instanceof File) file = f;
  } catch {
    return c.json({ ok: false, error: "Invalid upload" }, 400);
  }

  if (!file || file.size === 0) {
    return c.json({ ok: false, error: "Choose a file to upload." }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ ok: false, error: "File is too large. Maximum 10 MB." }, 400);
  }
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return c.json(
      { ok: false, error: "File type not allowed. Use PNG, JPG, WEBP, GIF, SVG, or MP4." },
      400
    );
  }

  // Server-generated flat key: unique per upload, no client input in the path.
  const key = `media-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  await audit(c, admin!, "media.upload", `${key} (${file.size} bytes)`);

  const host = c.req.header("host") || "brimwood-api.adamsayani.workers.dev";
  return c.json({ ok: true, key, url: `https://${host}/api/media/${key}` });
});

/* --- Admin: delete --- */

app.delete("/admin/media/:key", async (c) => {
  const admin = await adminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;

  const key = cleanKey(c.req.param("key"));
  if (!key) return c.json({ ok: false, error: "Not found" }, 404);

  await c.env.MEDIA.delete(key);
  await audit(c, admin!, "media.delete", key);
  return c.json({ ok: true });
});

/* --- Public: serve a media object --- */

app.get("/media/:key", async (c) => {
  const key = cleanKey(c.req.param("key"));
  if (!key) return c.json({ ok: false, error: "Not found" }, 404);

  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ ok: false, error: "Not found" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  if (!headers.get("content-type")) {
    const ext = (key.split(".").pop() || "").toLowerCase();
    headers.set("content-type", EXT_TYPES[ext] || "application/octet-stream");
  }
  // Keys are unique per upload → immutable, cache aggressively at the edge.
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(obj.body, { headers });
});

export default app;
