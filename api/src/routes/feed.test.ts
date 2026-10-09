/* Route tests: feed — posts, media posts, polls, reels, voting, results. */
import { describe, it, expect } from "vitest";
import app from "./feed";
import { mockEnv, memberSession, postJSON, type MockEnv } from "../test/helpers";

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

/* Real magic bytes per MIME (security-max: uploads are magic-byte checked). */
const TEST_MAGIC: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "video/mp4": [0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};
function uploadForm(filename: string, mime: string, size: number, durationS?: string, h?: Record<string, string>, spoof = false) {
  const bytes = new Uint8Array(size);
  if (!spoof) bytes.set(TEST_MAGIC[mime] || []);
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

  it("rejects files whose bytes don't match the declared type", async () => {
    const env = envWithMedia();
    const h = memberSession(env);
    const res = await app.request(uploadForm("evil.jpg", "image/jpeg", 500, undefined, h, true), {}, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/doesn't match/);
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
    const ins = env.DB.inserts.get("posts");
    expect(ins?.length).toBe(1);
    expect(ins?.[0].author_id).toBe("member-1");
    expect(ins?.[0].body).toBe("Demo day went well.");
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
    expect(env.DB.inserts.get("posts")?.length || 0).toBe(0);
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

describe("GET /feed", () => {
  function feedEnv() {
    const env = envWithMedia({ "feed-a.jpg": { contentType: "image/jpeg" } });
    const future = new Date(Date.now() + 86400000).toISOString();
    env.DB.handler = (sql, params) => {
      if (/from\s+posts/i.test(sql)) {
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
      if (/from\s+posts/i.test(sql)) return { row: { id: "p1" } };
      if (/from\s+post_reactions/i.test(sql)) {
        return existingKind ? { row: { kind: existingKind } } : { row: null };
      }
      return undefined;
    };
    return env;
  }

  it("requires sign in", async () => {
    const env = envWithMedia();
    const res = await postJSON(app, "/posts/p1/react", { kind: "like" }, env);
    expect(res.status).toBe(401);
  });

  it("rejects unknown reaction kinds", async () => {
    const env = reactEnv(null);
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "angry" }, env, h);
    expect(res.status).toBe(400);
  });

  it("records a reaction with an upsert so members can change it", async () => {
    const env = reactEnv("like");
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/p1/react", { kind: "celebrate" }, env, h);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).my_reaction).toBe("celebrate");
    const call = env.DB.calls.find((c) => /post_reactions/i.test(c.sql) && /on\s+conflict/i.test(c.sql));
    expect(call).toBeTruthy();
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

  it("404s for unknown posts", async () => {
    const env = envWithMedia();
    env.DB.handler = (sql) => {
      if (/from\s+posts/i.test(sql)) return { row: null };
      return undefined;
    };
    const h = memberSession(env);
    const res = await postJSON(app, "/posts/nope/react", { kind: "like" }, env, h);
    expect(res.status).toBe(404);
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
