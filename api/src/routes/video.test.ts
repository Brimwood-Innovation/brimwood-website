/* Route tests: video — access control, range requests, cache headers. */
import { describe, it, expect } from "vitest";
import app from "./video";
import { mockEnv, memberSession, adminSession } from "../test/helpers";

const BYTES = new Uint8Array(100).map((_, i) => i);

function r2obj(slice?: { offset: number; length: number }) {
  const body = slice ? BYTES.slice(slice.offset, slice.offset + slice.length) : BYTES;
  return {
    key: "v/lec1.mp4",
    size: BYTES.length,
    etag: "etag1",
    httpEtag: '"etag1"',
    uploaded: new Date(),
    httpMetadata: {},
    customMetadata: {},
    body: new ReadableStream({
      start(c) {
        c.enqueue(body);
        c.close();
      },
    }),
    writeHttpMetadata(h: Headers) {
      h.set("content-type", "video/mp4");
    },
  };
}

const gatedLesson = { is_preview: 0, course_id: "course-1", course_visibility: "members" };
const previewLesson = { is_preview: 1, course_id: "course-1", course_visibility: "members" };
const publicCourseLesson = { is_preview: 0, course_id: "course-1", course_visibility: "public" };

function videoEnv(
  lesson: any,
  opts: { enrolled?: boolean; headNull?: boolean; getNull?: boolean } = {}
) {
  const env = mockEnv();
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/video_r2_key/.test(sql)) return { row: lesson };
    if (/FROM enrollments/.test(sql)) return { row: opts.enrolled ? { id: "e1" } : null };
    return prev?.(sql, params);
  };
  env.MEDIA = {
    put: async () => {},
    delete: async () => {},
    head: async () => (opts.headNull ? null : { size: BYTES.length }),
    get: async (_k: string, rangeOpts?: any) =>
      opts.getNull ? null : r2obj(rangeOpts?.range),
  } as any;
  return env;
}

const get = (env: any, headers: Record<string, string> = {}) =>
  app.request("/video/v/lec1.mp4", { headers }, env as any);

describe("video access control", () => {
  it("serves preview videos publicly with a public cache header", async () => {
    const res = await get(videoEnv(previewLesson));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("401s anonymous requests for members-only video", async () => {
    const res = await get(videoEnv(gatedLesson));
    expect(res.status).toBe(401);
  });

  it("403s signed-in members without enrolment", async () => {
    const env = videoEnv(gatedLesson);
    const res = await get(env, memberSession(env));
    expect(res.status).toBe(403);
  });

  it("serves enrolled members with a PRIVATE cache header (no edge leak)", async () => {
    const env = videoEnv(gatedLesson, { enrolled: true });
    const res = await get(env, memberSession(env));
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toContain("private");
    expect(cc).not.toContain("public");
  });

  it("lets admins bypass the enrolment check", async () => {
    const env = videoEnv(gatedLesson);
    const res = await get(env, adminSession(env));
    expect(res.status).toBe(200);
  });

  it("serves visibility='public' course videos to anonymous visitors", async () => {
    const res = await get(videoEnv(publicCourseLesson));
    expect(res.status).toBe(200);
  });

  it("404s when no lesson references the key (no bucket enumeration)", async () => {
    const res = await get(videoEnv(null));
    expect(res.status).toBe(404);
  });

  it("404s when the R2 object is missing", async () => {
    const res = await get(videoEnv(previewLesson, { headNull: true }));
    expect(res.status).toBe(404);
  });

  it("rejects path traversal keys", async () => {
    const env = videoEnv(previewLesson);
    const res = await app.request("/video/..%2Fsecret", {}, env as any);
    expect(res.status).toBe(404);
  });
});

describe("video range requests", () => {
  async function ranged(range: string) {
    const env = videoEnv(previewLesson, { enrolled: true });
    return get(env, { range });
  }

  it("serves bytes=0-9 as 206 with correct Content-Range and body", async () => {
    const res = await ranged("bytes=0-9");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/100");
    expect(res.headers.get("content-length")).toBe("10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(0, 10));
  });

  it("serves open-ended bytes=90- as 206 to end of file", async () => {
    const res = await ranged("bytes=90-");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 90-99/100");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(90));
  });

  it("clamps bytes=90-999 to the file size", async () => {
    const res = await ranged("bytes=90-999");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 90-99/100");
  });

  it("serves suffix ranges bytes=-10 as the last 10 bytes", async () => {
    const res = await ranged("bytes=-10");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 90-99/100");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(90));
  });

  it("416s unsatisfiable ranges with bytes */size", async () => {
    for (const r of ["bytes=200-", "bytes=100-50", "bytes=50-20", "bytes=-0"]) {
      const res = await ranged(r);
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */100");
    }
  });

  it("416s malformed and multi-range headers", async () => {
    for (const r of ["bytes=abc", "bytes=", "bytes=0-1,5-6", "items=0-10"]) {
      const res = await ranged(r);
      expect(res.status).toBe(416);
    }
  });
});
