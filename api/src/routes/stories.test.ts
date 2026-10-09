/* Route tests: stories — upload validation, tray grouping/seen state,
 * expiry filtering, view marking, author-only viewer list, replies. */
import { describe, it, expect } from "vitest";
import app from "./stories";
import {
  mockEnv,
  memberSession,
  postJSON,
  type MockEnv,
} from "../test/helpers";

const DAY = 24 * 3600 * 1000;

function jpg(name = "story.jpg", size = 100): File {
  return new File([new Uint8Array(size)], name, { type: "image/jpeg" });
}
function mp4(name = "clip.mp4", size = 100): File {
  return new File([new Uint8Array(size)], name, { type: "video/mp4" });
}

/** Multipart POST to / with the given file field value. */
function postFile(
  env: MockEnv,
  headers: Record<string, string>,
  file: File | null,
  path = "/"
) {
  const fd = new FormData();
  if (file) fd.append("file", file);
  const req = new Request("https://api.test" + path, {
    method: "POST",
    headers,
    body: fd,
  });
  return app.request(req, undefined, env as any);
}

/** Handler matching the story SELECTs by their distinctive fragments. */
function storyHandler(opts: {
  tray?: any[];
  story?: any | null;
  viewers?: any[];
  replyTarget?: any | null;
}) {
  return (sql: string, _params: unknown[]) => {
    if (/EXISTS\s*\(\s*SELECT 1 FROM story_views/i.test(sql))
      return { results: opts.tray ?? [] };
    if (/WHERE s\.id = \?/i.test(sql)) return { row: opts.story ?? null };
    if (/FROM story_views v/i.test(sql))
      return { results: opts.viewers ?? [] };
    if (/^SELECT id FROM stories/i.test(sql))
      return { row: opts.replyTarget === undefined ? { id: "s1" } : opts.replyTarget };
    return undefined;
  };
}

/** Install the story SELECT fixtures without breaking memberSession's
 *  users-row fallback (handlers chain; fixtures take precedence). */
function withStories(env: MockEnv, opts: Parameters<typeof storyHandler>[0]) {
  const fixture = storyHandler(opts);
  const prev = env.DB.handler;
  env.DB.handler = (sql: string, params: unknown[]) =>
    fixture(sql, params) ?? prev?.(sql, params);
}

const trayRows = [
  {
    id: "s1",
    r2_key: "story-a.jpg",
    kind: "photo",
    created_at: "2026-10-08T18:00:00.000Z",
    expires_at: "2026-10-09T18:00:00.000Z",
    author_id: "other-1",
    display_name: null,
    name: "Kim Osei",
    seen: 0,
  },
  {
    id: "s2",
    r2_key: "story-b.mp4",
    kind: "video",
    created_at: "2026-10-08T19:00:00.000Z",
    expires_at: "2026-10-09T19:00:00.000Z",
    author_id: "member-1",
    display_name: null,
    name: "Me Me",
    seen: 1,
  },
];

describe("POST / (upload)", () => {
  it("requires a session", async () => {
    const env = mockEnv();
    const res = await postFile(env, {}, jpg());
    expect(res.status).toBe(401);
  });

  it("rejects empty uploads", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    const res = await postFile(env, s, null);
    expect(res.status).toBe(400);
    expect(env.DB.inserts.get("stories")?.length || 0).toBe(0);
  });

  it("rejects disallowed types", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    const txt = new File([new Uint8Array(10)], "x.txt", { type: "text/plain" });
    const res = await postFile(env, s, txt);
    expect(res.status).toBe(400);
    expect(env.DB.inserts.get("stories")?.length || 0).toBe(0);
  });

  it("rejects SVG (script-carrying stories stay out)", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    const svg = new File([new Uint8Array(10)], "x.svg", { type: "image/svg+xml" });
    const res = await postFile(env, s, svg);
    expect(res.status).toBe(400);
  });

  it("rejects files over 10 MB", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    const res = await postFile(env, s, jpg("big.jpg", 10 * 1024 * 1024 + 1));
    expect(res.status).toBe(400);
    expect(env.DB.inserts.get("stories")?.length || 0).toBe(0);
  });

  it("stores a photo with expires_at = created_at + 24h", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    let putKey = "";
    env.MEDIA = {
      async put(...a: unknown[]) {
        putKey = (a[0] as string) ?? "";
      },
      async get() {
        return null;
      },
      async delete() {},
    } as any;
    const res = await postFile(env, s, jpg());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("photo");
    expect(putKey).toMatch(/^story-[0-9a-f-]+\.jpg$/);
    const rows = env.DB.inserts.get("stories")!;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("photo");
    expect(rows[0].author_id).toBe("member-1");
    const span =
      new Date(rows[0].expires_at as string).getTime() -
      new Date(rows[0].created_at as string).getTime();
    expect(span).toBe(DAY);
    expect(body.url).toContain(putKey);
  });

  it("stores an MP4 as kind=video", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    const res = await postFile(env, s, mp4());
    expect(res.status).toBe(200);
    expect(env.DB.inserts.get("stories")![0].kind).toBe("video");
  });

  it("rate-limits uploads to 10 per day", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    env.DB.rateLimitStore.set("story:member-1", {
      count: 10,
      window_start: Date.now(),
    });
    const res = await postFile(env, s, jpg());
    expect(res.status).toBe(429);
    expect(env.DB.inserts.get("stories")?.length || 0).toBe(0);
  });
});

describe("GET /tray", () => {
  it("requires a session", async () => {
    const env = mockEnv();
    const res = await app.request("/tray", {}, env as any);
    expect(res.status).toBe(401);
  });

  it("groups by author: self first, unseen flags, anonymous display", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    withStories(env, { tray: trayRows });
    const res = await app.request("/tray", { headers: s }, env as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.authors.length).toBe(2);
    // Self ("You" tile) sorts first even though the other story is older.
    expect(body.authors[0].is_self).toBe(true);
    expect(body.authors[0].stories[0].id).toBe("s2");
    expect(body.authors[1].display).toBe("K."); // initials, not the real name
    expect(body.authors[1].has_unseen).toBe(true);
    expect(body.authors[0].has_unseen).toBe(false);
    expect(body.authors[1].stories[0].url).toContain("/api/media/story-a.jpg");
  });

  it("hides expired stories (lazy expiry)", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    withStories(env, { tray: [] });
    const res = await app.request("/tray", { headers: s }, env as any);
    const body = (await res.json()) as any;
    expect(body.authors).toEqual([]);
    // The read itself must filter on expires_at, never trust the rows.
    const call = env.DB.calls.find((c) => /FROM stories s/i.test(c.sql));
    expect(call?.sql).toMatch(/expires_at > \?/i);
  });
});

describe("GET /:id", () => {
  const storyRow = {
    id: "s1",
    r2_key: "story-a.jpg",
    kind: "photo",
    created_at: "2026-10-08T18:00:00.000Z",
    expires_at: "2026-10-09T18:00:00.000Z",
    author_id: "member-1",
    display_name: "Forge Lead",
    name: "Me Me",
  };

  it("requires a session", async () => {
    const env = mockEnv();
    const res = await app.request("/s1", {}, env as any);
    expect(res.status).toBe(401);
  });

  it("404s on unknown ids", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    withStories(env, { story: null });
    const res = await app.request("/nope", { headers: s }, env as any);
    expect(res.status).toBe(404);
  });

  it("404s on expired stories (no oracle)", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    // DB no longer returns the row: the expires_at filter did its job.
    withStories(env, { story: null });
    const res = await app.request("/s1", { headers: s }, env as any);
    expect(res.status).toBe(404);
    expect(env.DB.inserts.get("story_views")?.length || 0).toBe(0);
  });

  it("marks the story viewed (idempotent)", async () => {
    const env = mockEnv();
    const s = memberSession(env, "other-1");
    withStories(env, { story: storyRow, viewers: [] });
    const res = await app.request("/s1", { headers: s }, env as any);
    expect(res.status).toBe(200);
    // Idempotent mark: INSERT OR IGNORE — one row per (story, viewer), and
    // re-watching is a no-op rather than a duplicate.
    const mark = env.DB.calls.find((c) =>
      /INSERT OR IGNORE INTO story_views/i.test(c.sql)
    );
    expect(mark).toBeTruthy();
    expect(mark!.params).toEqual(["s1", "other-1"]);
  });

  it("shows the viewer list only to the author", async () => {
    const viewers = [
      { viewed_at: "2026-10-08T19:00:00.000Z", display_name: null, name: "Kim Osei" },
    ];
    // Author sees the list.
    const envA = mockEnv();
    const sA = memberSession(envA, "member-1");
    withStories(envA, { story: storyRow, viewers });
    const resA = await app.request("/s1", { headers: sA }, envA as any);
    const bodyA = (await resA.json()) as any;
    expect(bodyA.story.author).toBe("Forge Lead");
    expect(bodyA.viewers).toEqual([
      { display: "K.", viewed_at: "2026-10-08T19:00:00.000Z" },
    ]);

    // A non-author viewer gets the story but no viewer list.
    const envB = mockEnv();
    const sB = memberSession(envB, "other-1");
    withStories(envB, { story: storyRow, viewers });
    const resB = await app.request("/s1", { headers: sB }, envB as any);
    const bodyB = (await resB.json()) as any;
    expect(bodyB.ok).toBe(true);
    expect("viewers" in bodyB).toBe(false);
  });
});

describe("POST /:id/reply", () => {
  it("requires a session", async () => {
    const env = mockEnv();
    const res = await postJSON(app, "/s1/reply", { body: "Nice!" }, env);
    expect(res.status).toBe(401);
  });

  it("404s on expired stories", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    withStories(env, { replyTarget: null });
    const res = await postJSON(app, "/s1/reply", { body: "Nice!" }, env, s);
    expect(res.status).toBe(404);
    expect(env.DB.inserts.get("story_replies")?.length || 0).toBe(0);
  });

  it("validates the body", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    withStories(env, {});
    const empty = await postJSON(app, "/s1/reply", { body: "   " }, env, s);
    expect(empty.status).toBe(400);
    const long = await postJSON(
      app,
      "/s1/reply",
      { body: "x".repeat(501) },
      env,
      s
    );
    expect(long.status).toBe(400);
    expect(env.DB.inserts.get("story_replies")?.length || 0).toBe(0);
  });

  it("stores the reply for DM surfacing", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    withStories(env, {});
    const res = await postJSON(
      app,
      "/s1/reply",
      { body: "See you at 6!" },
      env,
      s
    );
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("story_replies")!;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      story_id: "s1",
      from_user_id: "member-1",
      body: "See you at 6!",
    });
  });

  it("rate-limits replies", async () => {
    const env = mockEnv();
    const s = memberSession(env);
    env.DB.rateLimitStore.set("story-reply:member-1", {
      count: 60,
      window_start: Date.now(),
    });
    withStories(env, {});
    const res = await postJSON(app, "/s1/reply", { body: "Hi" }, env, s);
    expect(res.status).toBe(429);
  });
});
