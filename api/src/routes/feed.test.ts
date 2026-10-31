/* Route tests: feed - posts, media posts, polls, reels, voting, results. */
import { describe, it, expect } from "vitest";
import app from "./feed";
import { mockEnv, memberSession, adminSession, postJSON, type MockEnv } from "../test/helpers";

function envWithMedia(r2: Record<string, { contentType: string }> = {}): MockEnv {
  const env = mockEnv();
  (env as any).MEDIA = {
    async put() {},
    async get() {
      return null;
    },
    async delete() {},
    async head(key: string) {
      const o = r2[key];
      if (!o) return null;
      return { key, httpMetadata: { contentType: o.contentType } };
    },
  };
  return env;
}

function uploadForm(filename: string, mime: string, size: number, durationS?: string, h?: Record<string, string>) {
  const bytes = new Uint8Array(size);
  // Upload hardening verifies magic bytes, so fixtures carry real signatures.
  const stamp = (sig: number[], offset = 0) => sig.forEach((b, i) => { bytes[offset + i] = b; });
  if (mime === "image/jpeg") stamp([0xff, 0xd8, 0xff]);
  else if (mime === "image/png") stamp([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  else if (mime === "image/gif") stamp([0x47, 0x49, 0x46, 0x38]);
  else if (mime === "image/webp") { stamp([0x52, 0x49, 0x46, 0x46]); stamp([0x57, 0x45, 0x42, 0x50], 8); }
  else if (mime === "video/mp4") stamp([0x66, 0x74, 0x79, 0x70], 4); // ftyp box
  const file = new File([bytes], filename, { type: mime });
  const form = new FormData();
  form.append("file", file);
  if (durationS !== undefined) form.append("duration_s", durationS);
  // Cookie rides on the Request itself: app.request(req, init, env) would
  // replace the multipart content-type (boundary lost) if init has headers.
  return new Request("https://example.com/media/upload", {
    method: "POST",
    headers: h || {},
    body: form,
  });
}

describe("POST /media/upload", () => {
  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await app.request(uploadForm("a.jpg", "image/jpeg", 100), {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects disallowed types", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await app.request(uploadForm("a.svg", "image/svg+xml", 100, undefined, h), {}, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/not allowed/i);
  });

  it("rejects oversize files", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await app.request(uploadForm("big.mp4", "video/mp4", 11 * 1024 * 1024, "60", h), {}, env);
    expect(res.status).toBe(400);
  });

  it("flags photo for images", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await app.request(uploadForm("a.jpg", "image/jpeg", 500, undefined, h), {}, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.kind).toBe("photo");
    expect(d.key).toMatch(/^feed-/);
  });

  it("flags reel for videos <= 90s and video for longer ones", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const short = await app.request(uploadForm("s.mp4", "video/mp4", 500, "45", h), {}, env);
    expect(((await short.json()) as any).kind).toBe("reel");
    const long = await app.request(uploadForm("l.mp4", "video/mp4", 500, "120", h), {}, env);
    expect(((await long.json()) as any).kind).toBe("video");
  });

  it("rejects video without a sane duration", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await app.request(uploadForm("v.mp4", "video/mp4", 500, "601", h), {}, env);
    expect(res.status).toBe(400);
    const none = await app.request(uploadForm("v.mp4", "video/mp4", 500, undefined, h), {}, env);
    expect(none.status).toBe(400);
  });
});

describe("POST /posts", () => {
  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await postJSON(app, "/posts", { body: "hello" }, env);
    expect(res.status).toBe(401);
  });

  it("rejects empty posts", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(app, "/posts", { body: "" }, env, h);
    expect(res.status).toBe(400);
  });

  it("creates a text post", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(app, "/posts", { body: "Demo day went well." }, env, h);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.post_id).toBeTruthy();
    const ins = env.DB.inserts.get("feed_posts");
    expect(ins?.length).toBe(1);
    expect(ins?.[0].author_id).toBe("member-1");
    expect(ins?.[0].body).toBe("Demo day went well.");
  });

  it("emits a mention notification for @handles in the body", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const prev = env.DB.handler;
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/FROM users/.test(sql) && /username IN/.test(sql)) {
        return { results: [{ id: "user-kim", username: "kim" }] };
      }
      return prev?.(sql, params);
    };
    const res = await postJSON(app, "/posts", { body: "Hey @kim, great demo!" }, env, h);
    expect(res.status).toBe(200);
    const notifs = env.DB.inserts.get("notifications") || [];
    const mention = (notifs as any[]).find((n) => n.kind === "mention");
    expect(mention).toMatchObject({ user_id: "user-kim", target_type: "post" });
    expect(mention.target_id).toBeTruthy();
  });

  it("rejects media refs that are not in R2", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "look", media: [{ key: "feed-nope.jpg", width: 100, height: 100 }] },
      env,
      h
    );
    expect(res.status).toBe(400);
    expect(env.DB.inserts.get("feed_posts")?.length || 0).toBe(0);
  });

  it("re-derives kind from R2 metadata on attach", async () => {
    const env = envWithMedia({ "feed-x.mp4": { contentType: "video/mp4" } });
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "clip", media: [{ key: "feed-x.mp4", duration_s: 30 }] },
      env,
      h
    );
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("post_media");
    expect(rows?.length).toBe(1);
    expect(rows?.[0].kind).toBe("reel");
  });

  it("caps media at four attachments", async () => {
    const r2: Record<string, { contentType: string }> = {};
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const k = `feed-p${i}.jpg`;
      r2[k] = { contentType: "image/jpeg" };
      keys.push(k);
    }
    const env = envWithMedia(r2);
    const h = memberSession(env);
    const res = await postJSON(app, "/posts", { media: keys.map((key) => ({ key })) }, env, h);
    expect(res.status).toBe(400);
  });

  it("validates polls: options 2-4, duration from the picker", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const one = await postJSON(
      app,
      "/posts",
      { poll: { question: "Q?", options: ["only"], duration: "1d" } },
      env,
      h
    );
    expect(one.status).toBe(400);
    const five = await postJSON(
      app,
      "/posts",
      { poll: { question: "Q?", options: ["a", "b", "c", "d", "e"], duration: "1d" } },
      env,
      h
    );
    expect(five.status).toBe(400);
    const bad = await postJSON(
      app,
      "/posts",
      { poll: { question: "Q?", options: ["a", "b"], duration: "2w" } },
      env,
      h
    );
    expect(bad.status).toBe(400);
  });

  it("creates a poll with options and closes_at from duration", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      {
        body: "Pick a day",
        poll: { question: "Demo night?", options: ["Fri", "Sat"], duration: "3d", show_voters: 1 },
      },
      env,
      h
    );
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.poll_id).toBeTruthy();
    const polls = env.DB.inserts.get("polls");
    expect(polls?.length).toBe(1);
    expect(polls?.[0].question).toBe("Demo night?");
    expect(polls?.[0].show_voters).toBe(1);
    const opts = env.DB.inserts.get("poll_options");
    expect(opts?.length).toBe(2);
    expect(new Date(polls?.[0].closes_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects duplicate poll options", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { poll: { question: "Q?", options: ["Same", "same"], duration: "1d" } },
      env,
      h
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /posts/:id (permalink)", () => {
  function permalinkEnv() {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/FROM feed_posts p/i.test(sql) && /p\.id = \?/i.test(sql)) {
        return {
          results: [
            {
              id: "p9",
              body: "Permalink post",
              created_at: "2026-10-08T10:00:00.000Z",
              author_id: "member-2",
              author_name: "Kara",
              display_name: "Kara K",
              author_username: "karak",
              avatar_key: null,
              avatar_r2_key: null,
            },
          ],
        };
      }
      return { results: [] };
    };
    return env;
  }

  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await app.request("/posts/p9", { headers: {} }, env);
    expect(res.status).toBe(401);
  });

  it("returns the shaped post with canonical profile URL", async () => {
    const env = permalinkEnv();
    const h = memberSession(env);
    const res = await app.request("/posts/p9", { headers: h }, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.post.id).toBe("p9");
    expect(d.post.author.profile_url).toBe("/@karak");
    expect(d.post.author.display).toBe("Kara K");
  });

  it("404s on unknown posts", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/FROM feed_posts p/i.test(sql)) return { results: [] };
      return prev?.(sql, params);
    };
    const res = await app.request("/posts/nope", { headers: h }, env);
    expect(res.status).toBe(404);
  });

  it("reads from feed_posts with the published, audience, and block filters", async () => {
    const env = permalinkEnv();
    const h = memberSession(env);
    const res = await app.request("/posts/p9", { headers: h }, env);
    expect(res.status).toBe(200);
    const call = env.DB.calls.find(
      (c) => /FROM feed_posts p/i.test(c.sql) && /p\.id = \?/i.test(c.sql)
    );
    expect(call).toBeTruthy();
    const sql = call!.sql;
    // Never the blog "posts" table.
    expect(sql).not.toMatch(/FROM posts p/i);
    expect(sql).toMatch(/p\.status = 'published'/);
    expect(sql).toMatch(/p\.deleted_at IS NULL/);
    expect(sql).toMatch(/p\.audience/);
    expect(sql).toMatch(/group_members/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM block_pairs WHERE a = \? AND b = p\.author_id\)/);
    // The viewer id is bound for only_me, group membership, and the block check.
    const viewerBinds = call!.params.filter((p) => p === "member-1");
    expect(viewerBinds.length).toBe(3);
  });
});

describe("GET /feed", () => {
  function feedEnv() {
    const env = envWithMedia({ "feed-a.jpg": { contentType: "image/jpeg" } });
    const future = new Date(Date.now() + 86400000).toISOString();
    env.DB.handler = (sql, params) => {
      if (/from\s+feed_posts/i.test(sql)) {
        return {
          results: [
            {
              id: "p1",
              body: "First",
              created_at: "2026-10-08T10:00:00.000Z",
              author_id: "member-2",
              author_name: "Kara",
              display_name: "",
              avatar_key: null,
            },
          ],
        };
      }
      if (/from\s+post_media/i.test(sql)) {
        return {
          results: [{ post_id: "p1", r2_key: "feed-a.jpg", kind: "photo", width: 800, height: 600, duration_s: null, position: 0 }],
        };
      }
      if (/from\s+polls\s/i.test(sql) && /post_id\s+in/i.test(sql)) {
        return { results: [{ id: "poll1", post_id: "p1", question: "Q?", closes_at: future, show_voters: 0 }] };
      }
      if (/from\s+poll_options/i.test(sql)) {
        return { results: [{ id: "o1", poll_id: "poll1", label: "Yes", position: 0 }] };
      }
      if (/from\s+poll_votes/i.test(sql) && /count\(\*\)/i.test(sql)) {
        return { results: [{ option_id: "o1", votes: 3 }] };
      }
      if (/from\s+poll_votes/i.test(sql)) {
        return { results: [{ poll_id: "poll1", option_id: "o1" }] };
      }
      return { results: [] };
    };
    return env;
  }

  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await app.request("/feed", { headers: {} }, env);
    expect(res.status).toBe(401);
  });

  it("returns chronological posts with media, poll state, and anonymous author", async () => {
    const env = feedEnv();
    const h = memberSession(env);
    const res = await app.request("/feed?limit=10", { headers: h }, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.posts.length).toBe(1);
    const p = d.posts[0];
    // Anonymous by default: initials from the real name, never email.
    expect(p.author.display).toBe("K.");
    expect(p.author.email).toBeUndefined();
    expect(p.media[0].kind).toBe("photo");
    expect(p.poll.question).toBe("Q?");
    expect(p.poll.total_votes).toBe(3);
    expect(p.poll.my_vote).toBe("o1");
    expect(p.poll.closed).toBe(false);
    expect(p.poll.show_voters).toBe(false);
  });

  it("lists from feed_posts with the published, audience, and block filters", async () => {
    const env = feedEnv();
    const h = memberSession(env);
    const res = await app.request("/feed?limit=10", { headers: h }, env);
    expect(res.status).toBe(200);
    const call = env.DB.calls.find(
      (c) => /FROM feed_posts p/i.test(c.sql) && /ORDER BY p\.created_at DESC/i.test(c.sql)
    );
    expect(call).toBeTruthy();
    const sql = call!.sql;
    expect(sql).not.toMatch(/FROM posts p/i);
    expect(sql).toMatch(/p\.status = 'published'/);
    expect(sql).toMatch(/p\.deleted_at IS NULL/);
    expect(sql).toMatch(/p\.audience/);
    expect(sql).toMatch(/group_members/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM block_pairs WHERE a = \? AND b = p\.author_id\)/);
    const viewerBinds = call!.params.filter((p) => p === "member-1");
    expect(viewerBinds.length).toBe(3);
  });
});

describe("POST /polls/:id/vote", () => {
  function voteEnv(closesAt: string) {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+polls/i.test(sql)) {
        return { row: { id: "poll1", question: "Q?", closes_at: closesAt, show_voters: 0 } };
      }
      if (/from\s+poll_options/i.test(sql)) {
        return { row: { id: "o1" } };
      }
      return undefined;
    };
    return env;
  }

  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await postJSON(app, "/polls/poll1/vote", { option_id: "o1" }, env);
    expect(res.status).toBe(401);
  });

  it("404s for unknown polls", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+polls/i.test(sql)) return { row: null };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/polls/nope/vote", { option_id: "o1" }, env, h);
    expect(res.status).toBe(404);
  });

  it("rejects votes after the poll closes", async () => {
    const env = voteEnv(new Date(Date.now() - 1000).toISOString());
    const h = memberSession(env);
    const res = await postJSON(app, "/polls/poll1/vote", { option_id: "o1" }, env, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/closed/i);
  });

  it("records a vote with an upsert so members can change it until close", async () => {
    const env = voteEnv(new Date(Date.now() + 86400000).toISOString());
    const h = memberSession(env);
    const res = await postJSON(app, "/polls/poll1/vote", { option_id: "o1" }, env, h);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).option_id).toBe("o1");
    const call = env.DB.calls.find((c) => /poll_votes/i.test(c.sql) && /on\s+conflict/i.test(c.sql));
    expect(call).toBeTruthy();
    expect(call!.params).toContain("member-1");
  });
});

describe("POST /posts/:id/react", () => {
  function reactEnv(existingKind: string | null) {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+feed_posts/i.test(sql)) return { row: { id: "p1", author_id: "author-1" } };
      if (/from\s+post_reactions/i.test(sql)) {
        return existingKind ? { row: { kind: existingKind } } : { row: null };
      }
      return undefined;
    };
    return env;
  }

  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await postJSON(app, "/posts/p1/react", { kind: "thanks" }, env);
    expect(res.status).toBe(401);
  });

  it("rejects unknown reaction kinds", async () => {
    const env = reactEnv(null);
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "angry" }, env, h);
    expect(res.status).toBe(400);
  });

  it("records a reaction with an upsert so members can change it", async () => {
    const env = reactEnv("thanks");
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "celebrate" }, env, h);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).my_reaction).toBe("celebrate");
    const call = env.DB.calls.find((c) => /post_reactions/i.test(c.sql) && /on\s+conflict/i.test(c.sql));
    expect(call).toBeTruthy();
  });

  it("maps the legacy like kind to the canonical thanks reaction", async () => {
    const env = reactEnv(null);
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "like" }, env, h);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).my_reaction).toBe("thanks");
    const call = env.DB.calls.find((c) => /post_reactions/i.test(c.sql) && /on\s+conflict/i.test(c.sql));
    expect(call).toBeTruthy();
    expect(call!.params).toContain("thanks");
    expect(call!.params).not.toContain("like");
  });

  it("removes the reaction when the same thanks is tapped again", async () => {
    const env = reactEnv("like");
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "thanks" }, env, h);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).my_reaction).toBeNull();
    const del = env.DB.calls.find((c) => /delete\s+from\s+post_reactions/i.test(c.sql));
    expect(del).toBeTruthy();
  });

  it("tapping the same reaction again removes it", async () => {
    const env = reactEnv("insightful");
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "insightful" }, env, h);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).my_reaction).toBeNull();
    const del = env.DB.calls.find((c) => /delete\s+from\s+post_reactions/i.test(c.sql));
    expect(del).toBeTruthy();
  });

  it("403s when a block exists between the reactor and the author", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+feed_posts/i.test(sql)) return { row: { id: "p1", author_id: "author-1" } };
      if (/from\s+block_pairs/i.test(sql)) return { row: { 1: 1 } };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "thanks" }, env, h);
    expect(res.status).toBe(403);
    const write = env.DB.calls.find((c) => /post_reactions/i.test(c.sql) && /on\s+conflict/i.test(c.sql));
    expect(write).toBeUndefined();
  });

  it("403s when posting is paused for the reactor", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+feed_posts/i.test(sql)) return { row: { id: "p1", author_id: "author-1" } };
      if (/from\s+active_write_bans/i.test(sql)) return { row: { 1: 1 } };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "support" }, env, h);
    expect(res.status).toBe(403);
    const write = env.DB.calls.find((c) => /post_reactions/i.test(c.sql) && /on\s+conflict/i.test(c.sql));
    expect(write).toBeUndefined();
  });

  it("403s when the block trigger fires on the write itself", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+feed_posts/i.test(sql)) return { row: { id: "p1", author_id: "author-1" } };
      if (/insert\s+into\s+post_reactions/i.test(sql)) {
        throw new Error("D1_ERROR: blocked: TRIGGER trg_post_reactions_block");
      }
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "thanks" }, env, h);
    expect(res.status).toBe(403);
  });

  it("403s when the posting-pause trigger fires on the write itself", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+feed_posts/i.test(sql)) return { row: { id: "p1", author_id: "author-1" } };
      if (/insert\s+into\s+post_reactions/i.test(sql)) {
        throw new Error("D1_ERROR: posting is paused for this member: TRIGGER trg_gate_post_reactions");
      }
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "thanks" }, env, h);
    expect(res.status).toBe(403);
  });

  it("still lets a blocked reactor take back their own reaction", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+feed_posts/i.test(sql)) return { row: { id: "p1", author_id: "author-1" } };
      if (/from\s+block_pairs/i.test(sql)) return { row: { 1: 1 } };
      if (/from\s+post_reactions/i.test(sql)) return { row: { kind: "thanks" } };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "thanks" }, env, h);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).my_reaction).toBeNull();
    const del = env.DB.calls.find((c) => /delete\s+from\s+post_reactions/i.test(c.sql));
    expect(del).toBeTruthy();
  });

  it("404s for unknown posts", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+feed_posts/i.test(sql)) return { row: null };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/nope/react", { kind: "thanks" }, env, h);
    expect(res.status).toBe(404);
  });

  it("checks post existence against feed_posts, not the blog posts table", async () => {
    const env = reactEnv(null);
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "celebrate" }, env, h);
    expect(res.status).toBe(200);
    const call = env.DB.calls.find((c) => /SELECT id, author_id FROM/i.test(c.sql));
    expect(call).toBeTruthy();
    expect(call!.sql).toMatch(/FROM feed_posts/i);
    expect(call!.sql).not.toMatch(/FROM posts /i);
  });
});
describe("GET /polls/:id/results", () => {
  function resultsEnv(showVoters: number) {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+polls/i.test(sql)) {
        return { row: { id: "poll1", question: "Q?", closes_at: new Date(Date.now() + 3600000).toISOString(), show_voters: showVoters } };
      }
      if (/from\s+poll_options/i.test(sql)) {
        return { results: [{ id: "o1", label: "Yes", votes: 2 }] };
      }
      if (/from\s+poll_votes/i.test(sql)) {
        return {
          results: [
            { option_id: "o1", voter_id: "member-2", display_name: "", name: "Kara", avatar_key: null },
          ],
        };
      }
      return undefined;
    };
    return env;
  }

  it("always returns counts but hides voters for private polls", async () => {
    const env = resultsEnv(0);
    const h = memberSession(env);
    const res = await app.request("/polls/poll1/results", { headers: h }, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.total_votes).toBe(2);
    expect(d.voters).toBeUndefined();
  });

  it("lists voters publicly when the poll enabled show_voters", async () => {
    const env = resultsEnv(1);
    const h = memberSession(env);
    const res = await app.request("/polls/poll1/results", { headers: h }, env);
    const d: any = await res.json();
    expect(d.voters.length).toBe(1);
    expect(d.voters[0].voter.display).toBe("K.");
    expect(d.voters[0].voter.email).toBeUndefined();
  });
});

describe("POST /posts deck composer fields (Phase 3 slice 4)", () => {
  it("stores the chosen intent and only_me audience", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "Stuck on the scheduler retry.", intent: "question", audience: "only_me" },
      env,
      h
    );
    expect(res.status).toBe(200);
    const ins = env.DB.inserts.get("feed_posts");
    expect(ins?.length).toBe(1);
    expect(ins?.[0].intent).toBe("question");
    expect(ins?.[0].audience).toBe("only_me");
    expect(ins?.[0].group_id).toBeNull();
  });

  it("defaults to progress intent and members audience when omitted", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(app, "/posts", { body: "Shipped v0.3." }, env, h);
    expect(res.status).toBe(200);
    const ins = env.DB.inserts.get("feed_posts");
    expect(ins?.[0].intent).toBe("progress");
    expect(ins?.[0].audience).toBe("members");
  });

  it("rejects intents the member composer does not offer", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "Team news.", intent: "announcement" },
      env,
      h
    );
    expect(res.status).toBe(400);
    expect(env.DB.inserts.get("feed_posts")).toBeUndefined();
  });

  it("stores a spotlight post for staff", async () => {
    const env = envWithMedia();
    const h = adminSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "Member build of the week: a scheduler that retries.", intent: "spotlight" },
      env,
      h
    );
    expect(res.status).toBe(200);
    const ins = env.DB.inserts.get("feed_posts");
    expect(ins?.length).toBe(1);
    expect(ins?.[0].intent).toBe("spotlight");
    expect(ins?.[0].audience).toBe("members");
  });

  it("rejects a spotlight post from a non-staff member with 403", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "Member build of the week.", intent: "spotlight" },
      env,
      h
    );
    expect(res.status).toBe(403);
    expect(env.DB.inserts.get("feed_posts")).toBeUndefined();
  });

  it("rejects a group audience without a group, and a group on other audiences", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const noGroup = await postJSON(app, "/posts", { body: "Hi.", audience: "group" }, env, h);
    expect(noGroup.status).toBe(400);
    const strayGroup = await postJSON(
      app,
      "/posts",
      { body: "Hi.", audience: "members", group_id: "g1" },
      env,
      h
    );
    expect(strayGroup.status).toBe(400);
    expect(env.DB.inserts.get("feed_posts")).toBeUndefined();
  });

  it("rejects group posts from non-members with 403", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+group_members/i.test(sql)) return { row: null };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "Hi group.", audience: "group", group_id: "g1" },
      env,
      h
    );
    expect(res.status).toBe(403);
    expect(env.DB.inserts.get("feed_posts")).toBeUndefined();
  });

  it("stores group posts for active members", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+group_members/i.test(sql)) return { row: { "1": 1 } };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(
      app,
      "/posts",
      { body: "Hi group.", audience: "group", group_id: "g1" },
      env,
      h
    );
    expect(res.status).toBe(200);
    const ins = env.DB.inserts.get("feed_posts");
    expect(ins?.[0].audience).toBe("group");
    expect(ins?.[0].group_id).toBe("g1");
  });
});

describe("GET /groups/mine (Phase 3 slice 4)", () => {
  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await app.request("/groups/mine", { headers: {} }, env);
    expect(res.status).toBe(401);
  });

  it("lists the caller's active groups in name order", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+groups/i.test(sql)) {
        return {
          results: [
            { id: "g2", name: "Forge Talk", slug: "forge-talk" },
            { id: "g1", name: "Demo Crew", slug: "demo-crew" },
          ],
        };
      }
      return undefined;
    };
    const h = memberSession(env);
    const res = await app.request("/groups/mine", { headers: h }, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.groups.map((g: any) => g.name)).toEqual(["Forge Talk", "Demo Crew"]);
    expect(d.groups[0].slug).toBe("forge-talk");
  });
});

describe("GET /feed/notices (Phase 5 feed header notices)", () => {
  const EVENTS = [
    { id: "e-past", slug: "demo-past", title: "Past demo", starts_at: "2020-01-03T18:00:00.000Z", ends_at: null, location: "Hub", status: "published", kind: "demo_night", demo_slots_open: 0 },
    { id: "e-draft", slug: "demo-draft", title: "Draft demo", starts_at: "2999-01-03T18:00:00.000Z", ends_at: null, location: "Hub", status: "draft", kind: "demo_night", demo_slots_open: 2 },
    { id: "e-other", slug: "workshop", title: "Workshop", starts_at: "2999-01-02T18:00:00.000Z", ends_at: null, location: "Hub", status: "published", kind: "other", demo_slots_open: 0 },
    { id: "e-later", slug: "demo-later", title: "Later demo", starts_at: "2999-01-10T18:00:00.000Z", ends_at: "2999-01-10T20:00:00.000Z", location: "Hub", status: "published", kind: "demo_night", demo_slots_open: 1 },
    { id: "e-next", slug: "demo-next", title: "Next demo", starts_at: "2999-01-08T18:00:00.000Z", ends_at: "2999-01-08T20:00:00.000Z", location: "Hub", status: "published", kind: "demo_night", demo_slots_open: 3 },
  ];
  const COMMENTS: Record<string, { status: string; deleted_at: string | null }[]> = {
    "q-answered": [{ status: "published", deleted_at: null }],
    "q-held": [{ status: "held", deleted_at: null }, { status: "published", deleted_at: "2026-10-01T00:00:00.000Z" }],
  };
  const QUESTIONS = [
    { id: "q-blocked", body: "Blocked question", created_at: "2026-10-10T10:00:00.000Z", author_id: "member-blocked", author_name: "Blocked", display_name: "Blocked B", author_username: "blockedb", avatar_key: null, avatar_r2_key: null, author_role: "member", audience: "members" },
    { id: "q-held", body: "Held comment only", created_at: "2026-10-09T10:00:00.000Z", author_id: "member-2", author_name: "Kara", display_name: "Kara K", author_username: "karak", avatar_key: null, avatar_r2_key: null, author_role: "member", audience: "members" },
    { id: "q-open", body: "Open question", created_at: "2026-10-08T10:00:00.000Z", author_id: "member-2", author_name: "Kara", display_name: "Kara K", author_username: "karak", avatar_key: null, avatar_r2_key: null, author_role: "admin", audience: "members" },
    { id: "q-onlyme", body: "Someone elses private question", created_at: "2026-10-07T10:00:00.000Z", author_id: "member-3", author_name: "Sam", display_name: "Sam S", author_username: "sams", avatar_key: null, avatar_r2_key: null, author_role: "member", audience: "only_me" },
    { id: "q-answered", body: "Answered question", created_at: "2026-10-06T10:00:00.000Z", author_id: "member-2", author_name: "Kara", display_name: "Kara K", author_username: "karak", avatar_key: null, avatar_r2_key: null, author_role: "member", audience: "members" },
  ];

  function noticesEnv() {
    const env = envWithMedia();
    env.DB.handler = (sql, params) => {
      if (/from\s+events\s+e/i.test(sql)) {
        const now = String(params[0]);
        const upcoming = EVENTS.filter(
          (e) => e.status === "published" && e.kind === "demo_night" && e.starts_at >= now
        ).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
        return { results: upcoming };
      }
      if (/from\s+feed_posts\s+p/i.test(sql)) {
        const visible = QUESTIONS.filter((q) => {
          if (q.author_id === "member-blocked") return false;
          if (q.audience === "only_me" && q.author_id !== "member-1") return false;
          const comments = COMMENTS[q.id] || [];
          return !comments.some((cm) => cm.status === "published" && cm.deleted_at === null);
        }).sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
        return { results: visible.slice(0, 3) };
      }
      return { results: [] };
    };
    return env;
  }

  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await app.request("/feed/notices", { headers: {} }, env);
    expect(res.status).toBe(401);
  });

  it("returns the earliest upcoming published demo night, not past, draft, or non-demo events", async () => {
    const env = noticesEnv();
    const h = memberSession(env);
    const res = await app.request("/feed/notices", { headers: h }, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.ok).toBe(true);
    expect(d.next_demo.id).toBe("e-next");
    expect(d.next_demo.slug).toBe("demo-next");
    expect(d.next_demo.title).toBe("Next demo");
    expect(d.next_demo.demo_slots_open).toBe(3);
    expect(d.next_demo.location).toBe("Hub");
  });

  it("lists open questions newest first, excluding answered, blocked, and other members only_me posts", async () => {
    const env = noticesEnv();
    const h = memberSession(env);
    const res = await app.request("/feed/notices", { headers: h }, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.open_questions.map((q: any) => q.id)).toEqual(["q-held", "q-open"]);
    const q = d.open_questions[1];
    expect(q.body).toBe("Open question");
    expect(q.author.display).toBe("Kara K");
    expect(q.author.profile_url).toBe("/@karak");
    expect(q.author.is_staff).toBe(true);
    expect(q.author.email).toBeUndefined();
    expect(q.author.name).toBeUndefined();
  });

  it("queries the demo and question filters the endpoint promises", async () => {
    const env = noticesEnv();
    const h = memberSession(env);
    const res = await app.request("/feed/notices", { headers: h }, env);
    expect(res.status).toBe(200);
    const demoCall = env.DB.calls.find((c) => /FROM events e/i.test(c.sql));
    expect(demoCall).toBeTruthy();
    expect(demoCall!.sql).toMatch(/e\.status = 'published'/);
    expect(demoCall!.sql).toMatch(/e\.kind = 'demo_night'/);
    expect(demoCall!.sql).toMatch(/e\.starts_at >= \?/);
    expect(demoCall!.sql).toMatch(/ORDER BY e\.starts_at ASC LIMIT 1/);
    expect(demoCall!.sql).toMatch(/demo_slots d/);
    expect(demoCall!.sql).toMatch(/d\.status = 'open'/);
    const qCall = env.DB.calls.find((c) => /FROM feed_posts p/i.test(c.sql));
    expect(qCall).toBeTruthy();
    expect(qCall!.sql).toMatch(/p\.intent = 'question'/);
    expect(qCall!.sql).toMatch(/feed_comments fc/);
    expect(qCall!.sql).toMatch(/fc\.status = 'published' AND fc\.deleted_at IS NULL/);
    expect(qCall!.sql).toMatch(/p\.status = 'published'/);
    expect(qCall!.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM block_pairs WHERE a = \? AND b = p\.author_id\)/);
    expect(qCall!.sql).toMatch(/ORDER BY p\.created_at DESC LIMIT 3/);
    expect(qCall!.params.filter((p) => p === "member-1").length).toBe(3);
  });

  it("returns an empty state when there is no demo and no open question", async () => {
    const env = envWithMedia();
    env.DB.handler = () => ({ results: [] });
    const h = memberSession(env);
    const res = await app.request("/feed/notices", { headers: h }, env);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.next_demo).toBeNull();
    expect(d.open_questions).toEqual([]);
  });
});
