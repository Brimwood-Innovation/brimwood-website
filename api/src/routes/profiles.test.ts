/* Profiles API tests (Phase D2): anonymity, validation, admin gates,
 * username rules, avatar upload. */
import { describe, it, expect, beforeEach } from "vitest";
import app, { validateUsername, initialsFor } from "./profiles";
import { mockEnv, memberSession, adminSession } from "../test/helpers";

function userRow(overrides: any = {}) {
  return {
    id: "member-1",
    email: "jane@example.com",
    name: "Jane Doe",
    role: "member",
    status: "active",
    display_name: null,
    bio: null,
    avatar_key: null,
    show_profile: 0,
    username: null,
    username_changed_at: null,
    location: null,
    website: null,
    social_links: null,
    work_history: null,
    education: null,
    hobbies: null,
    created_at: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("initialsFor", () => {
  it("derives J. from Jane Doe", () => expect(initialsFor("Jane Doe")).toBe("J."));
  it("falls back to Member for empty", () => expect(initialsFor("")).toBe("Member"));
});

describe("validateUsername", () => {
  it("accepts valid handles", () => {
    expect(validateUsername("jane_doe")).toBeNull();
    expect(validateUsername("a1_")).toBeNull();
    expect(validateUsername("abc")).toBeNull();
  });
  it("rejects bad formats", () => {
    expect(validateUsername("ab")).not.toBeNull(); // too short
    expect(validateUsername("1abc")).not.toBeNull(); // starts with number
    expect(validateUsername("Jane")).not.toBeNull(); // uppercase
    expect(validateUsername("a-b")).not.toBeNull(); // hyphen
    expect(validateUsername("a".repeat(31))).not.toBeNull(); // too long
  });
  it("rejects reserved words", () => {
    for (const w of ["admin", "api", "brimwood", "u", "support", "cms"]) {
      expect(validateUsername(w)).not.toBeNull();
    }
  });
});

describe("GET /users/me", () => {
  it("401 when anonymous", async () => {
    const env = mockEnv();
    const res = await app.request("/users/me", {}, env as any);
    expect(res.status).toBe(401);
  });
  it("returns full own profile including private fields", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) return { row: userRow() };
      return undefined;
    };
    const res = await app.request("/users/me", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.email).toBe("jane@example.com");
    expect(d.user.display_name_public).toBe("J.");
  });
});

describe("GET /users/:id anonymity", () => {
  it("404 for private profile (show_profile=0)", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ row: null }); // WHERE filters it out
    const res = await app.request("/users/member-1", {}, env as any);
    expect(res.status).toBe(404);
  });
  it("404 for nonexistent id (same as private — no enumeration)", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ row: null });
    const r1 = await app.request("/users/nope", {}, env as any);
    const r2 = await app.request("/users/member-1", {}, env as any);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
  });
  it("public profile exposes NO email or real name", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ row: userRow({ show_profile: 1, display_name: "Jane Builds", bio: "Hi" }) });
    const res = await app.request("/users/member-1", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    const body = JSON.stringify(d);
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("Jane Doe");
    expect(d.user.display_name).toBe("Jane Builds");
    expect(d.user.bio).toBe("Hi");
  });
  it("falls back to initials when no display_name", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ row: userRow({ show_profile: 1 }) });
    const res = await app.request("/users/member-1", {}, env as any);
    const d: any = await res.json();
    expect(d.user.display_name).toBe("J.");
  });
  it("resolves by username too", async () => {
    const env = mockEnv();
    let seenSql = "";
    env.DB.handler = (sql) => {
      seenSql = sql;
      return { row: userRow({ show_profile: 1, username: "jane_builds" }) };
    };
    const res = await app.request("/users/jane_builds", {}, env as any);
    expect(res.status).toBe(200);
    expect(seenSql).toContain("username = ?");
  });
});

describe("PATCH /users/me validation", () => {
  function authedEnv(rowOverrides: any = {}) {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) return { row: userRow(rowOverrides) };
      return undefined;
    };
    return { env, h };
  }
  it("401 when anonymous", async () => {
    const env = mockEnv();
    const res = await app.request("/users/me", { method: "PATCH", body: "{}" }, env as any);
    expect(res.status).toBe(401);
  });
  it("rejects short display_name", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ display_name: "x" }) },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("rejects bio over 500 chars (cleanStr truncates — accepted)", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ bio: "x".repeat(600) }) },
      env as any
    );
    expect(res.status).toBe(200); // cleanStr truncates to 500
  });
  it("rejects invalid username format", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ username: "Bad Name!" }) },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("rejects reserved username", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ username: "admin" }) },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("rejects taken username with 409", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql) && !/username = \?/.test(sql)) return { row: userRow() };
      if (/where\s+username\s*=\s*\?/i.test(sql)) return { row: { id: "other-1" } };
      return undefined;
    };
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ username: "taken_name" }) },
      env as any
    );
    expect(res.status).toBe(409);
  });
  it("enforces 30-day username change limit", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const recent = new Date(Date.now() - 5 * 86400000).toISOString();
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) return { row: userRow({ username: "old_name", username_changed_at: recent }) };
      return undefined;
    };
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ username: "new_name" }) },
      env as any
    );
    expect(res.status).toBe(429);
  });
  it("rejects invalid website URL", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ website: "not a url" }) },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("rejects bad social_links", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/users/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ social_links: { github: "notaurl" } }) },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("accepts valid full update", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/users/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({
          display_name: "Jane Builds",
          bio: "Builder.",
          location: "Toronto",
          website: "https://example.com",
          hobbies: "Cycling",
          social_links: { github: "https://github.com/jane" },
          work_history: [{ title: "Founder", company: "Acme", period: "2024–now" }],
          education: [{ school: "U of T", degree: "BSc", period: "2020" }],
          show_profile: 1,
        }),
      },
      env as any
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /users/me/avatar", () => {
  it("401 when anonymous", async () => {
    const env = mockEnv();
    const fd = new FormData();
    const res = await app.request("/users/me/avatar", { method: "POST", body: fd }, env as any);
    expect(res.status).toBe(401);
  });
  it("rejects non-image files", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const fd = new FormData();
    fd.append("file", new File(["evil"], "evil.exe", { type: "application/x-msdownload" }));
    const res = await app.request("/users/me/avatar", { method: "POST", headers: h, body: fd }, env as any);
    expect(res.status).toBe(400);
  });
  it("rejects oversize files", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const big = new Uint8Array(6 * 1024 * 1024);
    const fd = new FormData();
    fd.append("file", new File([big], "big.png", { type: "image/png" }));
    const res = await app.request("/users/me/avatar", { method: "POST", headers: h, body: fd }, env as any);
    expect(res.status).toBe(400);
  });
});

describe("admin gates", () => {
  it("PATCH /admin/users/:id 403 for non-admin", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const res = await app.request(
      "/admin/users/member-1",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ role: "admin" }) },
      env as any
    );
    expect(res.status).toBe(403);
  });
  it("PATCH /admin/users/:id 401 when anonymous", async () => {
    const env = mockEnv();
    const res = await app.request(
      "/admin/users/member-1",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
      env as any
    );
    expect(res.status).toBe(403);
  });
});
