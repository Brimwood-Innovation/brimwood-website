/* Route tests: media library - admin gates, list pagination, upload
 * validation (type, magic bytes, size, extension from MIME), public serve
 * headers (cache, SVG download, content-type fallback), key sanitation,
 * and delete with audit logging. Phase 5 slice 4: the media route
 * previously had no dedicated test file (cycle 33 grading). */
import { describe, it, expect } from "vitest";
import app from "./media";
import { mockEnv, adminSession, memberSession, type MockEnv } from "../test/helpers";

interface StoredObject {
  body: Uint8Array;
  contentType: string | null;
  uploaded: Date;
}

function streamOf(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/** Env with an in-memory R2 stand-in: put/get/delete/list with the same
 *  shape the route relies on (objects carry key, size, uploaded). */
function mediaEnv() {
  const env = mockEnv();
  const store = new Map<string, StoredObject>();
  (env as any).MEDIA = {
    async put(key: string, value: ArrayBuffer | Uint8Array, opts?: any) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      store.set(key, {
        body: bytes,
        contentType: opts?.httpMetadata?.contentType ?? null,
        uploaded: new Date("2026-10-28T12:00:00.000Z"),
      });
    },
    async get(key: string) {
      const o = store.get(key);
      if (!o) return null;
      return {
        key,
        size: o.body.length,
        httpEtag: '"etag-test"',
        uploaded: o.uploaded,
        body: streamOf(o.body),
        writeHttpMetadata(h: Headers) {
          if (o.contentType) h.set("content-type", o.contentType);
        },
      };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...store.keys()]
        .sort()
        .filter((k) => !opts.prefix || k.startsWith(opts.prefix));
      let start = 0;
      if (opts.cursor) {
        const idx = keys.indexOf(opts.cursor);
        start = idx >= 0 ? idx + 1 : 0;
      }
      const limit = opts.limit ?? 60;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((k) => ({
          key: k,
          size: store.get(k)!.body.length,
          uploaded: store.get(k)!.uploaded,
        })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      };
    },
  };
  return { env, store };
}

function seed(store: Map<string, StoredObject>, key: string, bytes: Uint8Array, contentType: string | null) {
  store.set(key, { body: bytes, contentType, uploaded: new Date("2026-10-28T12:00:00.000Z") });
}

function pngBytes(size: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}

function uploadReq(
  filename: string,
  mime: string,
  bytes: Uint8Array,
  headers: Record<string, string> = {}
): Request {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: mime }));
  return new Request("https://example.com/admin/media", {
    method: "POST",
    headers,
    body: form,
  });
}

const getList = (env: MockEnv, headers: Record<string, string> = {}, query = "") =>
  app.request(`/admin/media${query}`, { headers }, env as any);

describe("admin gates", () => {
  it("rejects anonymous list, upload, and delete", async () => {
    const { env } = mediaEnv();
    expect((await getList(env)).status).toBe(403);
    expect((await app.request(uploadReq("a.png", "image/png", pngBytes(20)), {}, env as any)).status).toBe(
      403
    );
    expect((await app.request("/admin/media/k1", { method: "DELETE" }, env as any)).status).toBe(403);
  });

  it("rejects non-admin members", async () => {
    const { env } = mediaEnv();
    const h = memberSession(env);
    expect((await getList(env, h)).status).toBe(403);
    expect((await app.request(uploadReq("a.png", "image/png", pngBytes(20), h), {}, env as any)).status).toBe(
      403
    );
    expect((await app.request("/admin/media/k1", { method: "DELETE", headers: h }, env as any)).status).toBe(
      403
    );
  });

  it("rejects a demoted admin (role re-read from D1 on every call)", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    env.DB.handler = (sql) =>
      /from\s+users/i.test(sql)
        ? { row: { id: "admin-1", email: "admin@example.com", role: "member", status: "active" } }
        : undefined;
    expect((await getList(env, h)).status).toBe(403);
  });
});

describe("admin list", () => {
  it("lists an empty library", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const res = await getList(env, h);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, objects: [], truncated: false, cursor: null });
  });

  it("filters by prefix and reports size and upload time", async () => {
    const { env, store } = mediaEnv();
    const h = adminSession(env);
    seed(store, "photo-a.png", pngBytes(10), "image/png");
    seed(store, "photo-b.png", pngBytes(20), "image/png");
    seed(store, "doc-a.png", pngBytes(30), "image/png");
    const res = await getList(env, h, "?prefix=photo");
    const d: any = await res.json();
    expect(d.objects.map((o: any) => o.key)).toEqual(["photo-a.png", "photo-b.png"]);
    expect(d.objects[0].size).toBe(10);
    expect(d.objects[0].uploaded).toBe("2026-10-28T12:00:00.000Z");
    expect(d.truncated).toBe(false);
  });

  it("rejects an unsafe prefix", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    expect((await getList(env, h, "?prefix=a/b")).status).toBe(400);
    expect((await getList(env, h, "?prefix=a b")).status).toBe(400);
  });

  it("paginates at the 60-item limit with a cursor", async () => {
    const { env, store } = mediaEnv();
    const h = adminSession(env);
    for (let i = 0; i < 65; i++) seed(store, `k${String(i).padStart(2, "0")}.png`, pngBytes(10), "image/png");
    const first: any = await (await getList(env, h)).json();
    expect(first.objects).toHaveLength(60);
    expect(first.truncated).toBe(true);
    expect(typeof first.cursor).toBe("string");
    const second: any = await (await getList(env, h, `?cursor=${first.cursor}`)).json();
    expect(second.objects).toHaveLength(5);
    expect(second.truncated).toBe(false);
    expect(second.cursor).toBeNull();
    expect([...first.objects, ...second.objects].map((o: any) => o.key)).toHaveLength(65);
  });
});

describe("admin upload", () => {
  it("stores a valid PNG under a server-generated key and audits it", async () => {
    const { env, store } = mediaEnv();
    const h = adminSession(env);
    const res = await app.request(uploadReq("photo.png", "image/png", pngBytes(100), h), {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.key).toMatch(/^media-\d+-[0-9a-f]{8}\.png$/);
    expect(d.url).toBe(`https://example.com/api/media/${d.key}`);
    expect(store.get(d.key)?.contentType).toBe("image/png");
    expect(store.get(d.key)?.body.length).toBe(100);
    const audit = env.DB.inserts.get("audit_log") || [];
    expect(audit.some((r) => r.action === "media.upload")).toBe(true);
  });

  it("derives the extension from the MIME type, never the filename", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const res = await app.request(uploadReq("evil.exe", "image/png", pngBytes(20), h), {}, env as any);
    const d: any = await res.json();
    expect(res.status).toBe(200);
    expect(d.key).toMatch(/\.png$/);
    expect(d.key).not.toContain("evil");
  });

  it("rejects content that does not match its claimed type", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const jpegAsPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const res = await app.request(uploadReq("a.png", "image/png", jpegAsPng, h), {}, env as any);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/doesn't match/);
  });

  it("rejects disallowed types, empty files, and missing files", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const badType = await app.request(
      uploadReq("a.txt", "text/plain", new TextEncoder().encode("hello"), h),
      {},
      env as any
    );
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as any).error).toMatch(/not allowed/);
    const empty = await app.request(uploadReq("a.png", "image/png", new Uint8Array(0), h), {}, env as any);
    expect(empty.status).toBe(400);
    const noFile = await app.request(
      new Request("https://example.com/admin/media", {
        method: "POST",
        headers: h,
        body: new FormData(),
      }),
      {},
      env as any
    );
    expect(noFile.status).toBe(400);
  });

  it("rejects files over 10 MB", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const res = await app.request(
      uploadReq("big.png", "image/png", pngBytes(10 * 1024 * 1024 + 1), h),
      {},
      env as any
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/too large/);
  });

  it("accepts a script-free SVG and an MP4 with an ftyp box", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const svgRes = await app.request(uploadReq("a.svg", "image/svg+xml", svg, h), {}, env as any);
    expect(svgRes.status).toBe(200);
    expect(((await svgRes.json()) as any).key).toMatch(/\.svg$/);
    const mp4 = new Uint8Array(20);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    const mp4Res = await app.request(uploadReq("a.mp4", "video/mp4", mp4, h), {}, env as any);
    expect(mp4Res.status).toBe(200);
    expect(((await mp4Res.json()) as any).key).toMatch(/\.mp4$/);
  });

  it("rejects an SVG carrying a script tag", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const svg = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');
    const res = await app.request(uploadReq("a.svg", "image/svg+xml", svg, h), {}, env as any);
    expect(res.status).toBe(400);
  });
});

describe("public serve", () => {
  it("serves a stored object with immutable cache headers, no sign-in needed", async () => {
    const { env, store } = mediaEnv();
    seed(store, "pic.png", pngBytes(12), "image/png");
    const res = await app.request("/media/pic.png", {}, env as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe('"etag-test"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pngBytes(12));
  });

  it("forces SVG downloads so stored SVGs never execute in the origin", async () => {
    const { env, store } = mediaEnv();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    seed(store, "pic.svg", svg, "image/svg+xml");
    const res = await app.request("/media/pic.svg", {}, env as any);
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("falls back to the extension type, then to octet-stream, when no type is stored", async () => {
    const { env, store } = mediaEnv();
    seed(store, "file.png", pngBytes(10), null);
    seed(store, "file.xyz", pngBytes(10), null);
    expect((await app.request("/media/file.png", {}, env as any)).headers.get("content-type")).toBe(
      "image/png"
    );
    expect((await app.request("/media/file.xyz", {}, env as any)).headers.get("content-type")).toBe(
      "application/octet-stream"
    );
  });

  it("404s on missing, traversal, and overlong keys", async () => {
    const { env } = mediaEnv();
    expect((await app.request("/media/nope.png", {}, env as any)).status).toBe(404);
    expect((await app.request("/media/..", {}, env as any)).status).toBe(404);
    expect((await app.request(`/media/${"a".repeat(201)}`, {}, env as any)).status).toBe(404);
  });
});

describe("admin delete", () => {
  it("deletes, audits, and makes the object unservable", async () => {
    const { env, store } = mediaEnv();
    const h = adminSession(env);
    seed(store, "old.png", pngBytes(10), "image/png");
    const res = await app.request("/admin/media/old.png", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.has("old.png")).toBe(false);
    expect((await app.request("/media/old.png", {}, env as any)).status).toBe(404);
    const audit = env.DB.inserts.get("audit_log") || [];
    expect(audit.some((r) => r.action === "media.delete")).toBe(true);
  });

  it("treats deleting a missing key as success (R2 delete is idempotent)", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const res = await app.request("/admin/media/gone.png", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(200);
  });

  it("404s on an unsafe delete key", async () => {
    const { env } = mediaEnv();
    const h = adminSession(env);
    const res = await app.request("/admin/media/..", { method: "DELETE", headers: h }, env as any);
    expect(res.status).toBe(404);
  });
});
