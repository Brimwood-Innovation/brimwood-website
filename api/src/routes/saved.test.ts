/* Route tests: saved - deck section 07 Saved place.
 * Only the caller's own saves list, newest first, with collection
 * chips derived from the visible rows; invisible posts (deleted,
 * unpublished, blocked, or out of audience) never appear and cannot
 * be saved; saving an already saved post moves it; unsaving is
 * idempotent; signed-out visitors get 401, never a partial list.
 */
import { describe, it, expect } from "vitest";
import app from "./saved";
import { mockEnv, memberSession, postJSON, type MockEnv } from "../test/helpers";

const ROW_A = {
  post_id: "p-a",
  collection: "Saved",
  saved_at: "2026-10-26T10:00:00Z",
  id: "p-a",
  body: "Shipped the first prototype today.",
  intent: "progress",
  audience: "members",
  group_id: null,
  created_at: "2026-10-26T09:00:00Z",
  author_id: "u-ada",
  author_name: "Ada Lovelace",
  display_name: "Ada",
  author_username: "ada",
  avatar_key: null,
  avatar_r2_key: null,
  author_role: "member",
  group_name: null,
  group_slug: null,
};

const ROW_B = {
  ...ROW_A,
  post_id: "p-b",
  collection: "Ideas",
  saved_at: "2026-10-25T10:00:00Z",
  id: "p-b",
  body: "A booking page for a mobile bike repair.",
  author_id: "u-bo",
  author_name: "Bo Chen",
  display_name: "Bo",
  author_username: "bo",
};

function savedEnv(visiblePosts: string[] = ["p-a", "p-b"]) {
  const env = mockEnv();
  const cookie = memberSession(env, "member-1");
  const prev = env.DB.handler;
  const queries: string[] = [];
  env.DB.handler = (sql: string, params: unknown[]) => {
    queries.push(sql);
    if (/FROM saved_posts sp/i.test(sql)) {
      return { results: [ROW_A, ROW_B].map((r) => ({ ...r })) };
    }
    if (/FROM feed_posts p WHERE p\.id/i.test(sql)) {
      const id = params[0] as string;
      return visiblePosts.includes(id) ? { row: { id } } : { row: null };
    }
    return prev?.(sql, params);
  };
  return { env, cookie, queries };
}

const get = (env: MockEnv, cookie: Record<string, string>, path: string) =>
  app.request(path, { method: "GET", headers: { ...cookie } }, env as any);

describe("saved list", () => {
  it("lists the caller's saves newest first with collection chips", async () => {
    const { env, cookie, queries } = savedEnv();
    const res = await get(env, cookie, "/");
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.saved.map((s: any) => s.post_id)).toEqual(["p-a", "p-b"]);
    expect(body.saved[0].post.body).toBe("Shipped the first prototype today.");
    expect(body.saved[0].post.author.display).toBe("Ada");
    expect(body.saved[0].post.author.profile_url).toBe("/@ada");
    expect(body.collections).toEqual([
      { collection: "Ideas", count: 1 },
      { collection: "Saved", count: 1 },
    ]);
    const listSql = queries.find((q) => /FROM saved_posts sp/i.test(q)) || "";
    expect(listSql).toMatch(/sp\.user_id = \?/);
    expect(listSql).toMatch(/status = 'published'/);
    expect(listSql).toMatch(/deleted_at IS NULL/);
    expect(listSql).toMatch(/block_pairs/);
    expect(listSql).toMatch(/ORDER BY sp\.saved_at DESC/);
    for (const s of body.saved) {
      expect(s).not.toHaveProperty("email");
      expect(s.post).not.toHaveProperty("email");
      expect(s.post.author).not.toHaveProperty("name");
    }
  });

  it("filters by collection", async () => {
    const { env, cookie } = savedEnv();
    const res = await get(env, cookie, "/?collection=Ideas");
    const body: any = await res.json();
    expect(body.saved.map((s: any) => s.post_id)).toEqual(["p-b"]);
    expect(body.collections).toEqual([
      { collection: "Ideas", count: 1 },
      { collection: "Saved", count: 1 },
    ]);
  });

  it("requires sign-in", async () => {
    const { env } = savedEnv();
    const res = await app.request("/", { method: "GET" }, env as any);
    expect(res.status).toBe(401);
  });
});

describe("save and unsave", () => {
  it("saves a visible post into the named collection", async () => {
    const { env, cookie } = savedEnv();
    const res = await postJSON(app, "/", { post_id: "p-a", collection: "Ideas" }, env, cookie);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, saved: true, post_id: "p-a", collection: "Ideas" });
    const rows = env.DB.inserts.get("saved_posts") || [];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ user_id: "member-1", post_id: "p-a", collection: "Ideas" });
    const insertSql = env.DB.calls.find((c) => /insert into saved_posts/i.test(c.sql))?.sql || "";
    expect(insertSql).toMatch(/ON CONFLICT\(user_id, post_id\) DO UPDATE/);
  });

  it("defaults to the Saved collection when none is given", async () => {
    const { env, cookie } = savedEnv();
    const res = await postJSON(app, "/", { post_id: "p-b" }, env, cookie);
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("saved_posts") || [];
    expect(rows[0]).toMatchObject({ collection: "Saved" });
  });

  it("returns 404 for an invisible post and saves nothing", async () => {
    const { env, cookie } = savedEnv(["p-a"]);
    const res = await postJSON(app, "/", { post_id: "p-gone" }, env, cookie);
    expect(res.status).toBe(404);
    expect(env.DB.inserts.get("saved_posts") || []).toEqual([]);
  });

  it("rejects a missing post id and truncates an overlong collection", async () => {
    const { env, cookie } = savedEnv();
    const missing = await postJSON(app, "/", {}, env, cookie);
    expect(missing.status).toBe(400);
    const long = await postJSON(app, "/", { post_id: "p-a", collection: "x".repeat(41) }, env, cookie);
    // cleanStr truncates, so the save lands in the truncated name, not a 400.
    expect(long.status).toBe(200);
    const rows = env.DB.inserts.get("saved_posts") || [];
    expect((rows[0].collection as string).length).toBe(40);
  });

  it("unsaves idempotently, even when nothing was saved", async () => {
    const { env, cookie } = savedEnv();
    const res = await app.request(
      "/p-a",
      { method: "DELETE", headers: { ...cookie } },
      env as any,
    );
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, saved: false, post_id: "p-a" });
    const del = env.DB.calls.find((c) => /delete from saved_posts/i.test(c.sql));
    expect(del?.params).toEqual(["member-1", "p-a"]);
  });

  it("requires sign-in for save and unsave", async () => {
    const { env } = savedEnv();
    const save = await postJSON(app, "/", { post_id: "p-a" }, env);
    expect(save.status).toBe(401);
    const unsave = await app.request("/p-a", { method: "DELETE" }, env as any);
    expect(unsave.status).toBe(401);
  });
});
