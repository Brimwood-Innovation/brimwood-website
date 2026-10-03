/* Route tests: comments — validation, moderation default, privacy, admin gates. */
import { describe, it, expect } from "vitest";
import app from "./comments";
import {
  mockEnv,
  adminSession,
  memberSession,
  turnstileStub,
  postJSON,
  postRaw,
} from "../test/helpers";

const good = {
  post_slug: "hello-world",
  name: "Ada",
  email: "ada@example.com",
  body: "This is a thoughtful comment with enough length.",
  "cf-turnstile-response": "tok",
};

describe("POST /comments validation", () => {
  it("rejects missing post_slug", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/comments", { ...good, post_slug: "" }, env);
      expect(res.status).toBe(400);
    } finally {
      r();
    }
  });

  it("rejects short names", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/comments", { ...good, name: "A" }, env);
      expect(res.status).toBe(400);
    } finally {
      r();
    }
  });

  it("rejects invalid email", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/comments", { ...good, email: "not-an-email" }, env);
      expect(res.status).toBe(400);
    } finally {
      r();
    }
  });

  it("rejects short bodies", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/comments", { ...good, body: "short" }, env);
      expect(res.status).toBe(400);
    } finally {
      r();
    }
  });

  it("rejects malformed JSON with 400", async () => {
    const env = mockEnv();
    const res = await postRaw(app, "/comments", "{not json", env);
    expect(res.status).toBe(400);
  });

  it("fails closed when Turnstile rejects", async () => {
    const env = mockEnv();
    const r = await turnstileStub(false);
    try {
      const res = await postJSON(app, "/comments", good, env);
      expect(res.status).toBe(400);
      expect(env.DB.inserts.get("comments")?.length || 0).toBe(0);
    } finally {
      r();
    }
  });

  it("stores as pending and always returns {ok:true}", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      const res = await postJSON(app, "/comments", good, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const rows = env.DB.inserts.get("comments")!;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].email).toBe("ada@example.com");
    } finally {
      r();
    }
  });

  it("rate-limits at 5/hour per IP", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      for (let i = 0; i < 5; i++) {
        const res = await postJSON(app, "/comments", good, env);
        expect(res.status).toBe(200);
      }
      const res = await postJSON(app, "/comments", good, env);
      expect(res.status).toBe(429);
    } finally {
      r();
    }
  });
});

describe("GET /comments/:slug privacy", () => {
  it("selects only name/body/created_at — email can never leak", async () => {
    const env = mockEnv();
    let seen = "";
    env.DB.handler = (sql) => {
      seen = sql;
      return { results: [{ name: "Ada", body: "hi", created_at: "2026-01-01" }] };
    };
    const res = await app.request("/comments/hello-world", {}, env as any);
    expect(res.status).toBe(200);
    const selectClause = seen.split(/from/i)[0].toLowerCase();
    expect(selectClause).not.toMatch(/email/);
    const data = (await res.json()) as any;
    expect(data.comments[0]).toEqual({ name: "Ada", body: "hi", created_at: "2026-01-01" });
  });

  it("only approved comments are queried", async () => {
    const env = mockEnv();
    let seen = "";
    env.DB.handler = (sql) => {
      seen = sql;
      return { results: [] };
    };
    await app.request("/comments/x", {}, env as any);
    expect(seen).toMatch(/status\s*=\s*'approved'/);
  });
});

describe("admin moderation gates", () => {
  const queue = (env: ReturnType<typeof mockEnv>, headers: Record<string, string> = {}) =>
    app.request("/admin/comments", { headers }, env as any);

  it("rejects unauthenticated requests (403)", async () => {
    const env = mockEnv();
    expect((await queue(env)).status).toBe(403);
  });

  it("rejects non-admin members (403)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    expect((await queue(env, h)).status).toBe(403);
  });

  it("serves the queue plus counts to admins", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    env.DB.handler = (sql) => {
      if (/group\s+by/i.test(sql)) return { results: [{ status: "pending", n: 2 }] };
      return { results: [{ id: "c1", status: "pending" }] };
    };
    const res = await queue(env, h);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.counts).toHaveLength(1);
  });

  it("PATCH rejects invalid status transitions", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await app.request(
      "/admin/comments/c1",
      { method: "PATCH", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ status: "pending" }) },
      env as any
    );
    expect(res.status).toBe(400);
  });

  it("PATCH 404s on unknown comment", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await app.request(
      "/admin/comments/nope",
      { method: "PATCH", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ status: "approved" }) },
      env as any
    );
    expect(res.status).toBe(404);
  });

  it("PATCH approve writes audit_log", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    env.DB.handler = (sql) => {
      if (/from\s+comments\s+where\s+id/i.test(sql)) return { row: { post_slug: "p", name: "Ada" } };
    };
    const res = await app.request(
      "/admin/comments/c1",
      { method: "PATCH", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ status: "approved" }) },
      env as any
    );
    expect(res.status).toBe(200);
    const audits = env.DB.inserts.get("audit_log")!;
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("comment.approved");
  });
});
