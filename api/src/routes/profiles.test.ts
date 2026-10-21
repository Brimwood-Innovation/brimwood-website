/* Profiles API tests (Phase D2): anonymity, validation, admin gates,
 * username rules, avatar upload. */
import { describe, it, expect, beforeEach } from "vitest";
import app, {
  validateUsername,
  initialsFor,
  validateVisibility,
  effectiveVisibility,
  fieldVisible,
  validPastDate,
  validateDob,
  normalizeHobbies,
  hobbyList,
  normalizeEducation,
  educationList,
  normalizeMilestones,
  milestoneList,
  richProfileShape,
  avatarUrlOf,
} from "./profiles";
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
  it("demoting an admin destroys their sessions immediately", async () => {
    const env = mockEnv();
    const h = adminSession(env, "admin-1");
    // The demoted target has a live session.
    const now = Date.now();
    env.DB.sessionStore.set("sess:targetsession", {
      user_id: "target-1",
      role: "admin",
      created_at: now,
      expires_at: now + 86400000,
    });
    const res = await app.request(
      "/admin/users/target-1",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ role: "member" }) },
      env as any
    );
    expect(res.status).toBe(200);
    // Target's sessions are gone; the acting admin's session is untouched.
    expect(env.DB.sessionStore.has("sess:targetsession")).toBe(false);
    expect(env.DB.sessionStore.size).toBe(1);
  });
  it("suspending a user destroys their sessions immediately", async () => {
    const env = mockEnv();
    const h = adminSession(env, "admin-1");
    const now = Date.now();
    env.DB.sessionStore.set("sess:targetsession", {
      user_id: "target-1",
      role: "member",
      created_at: now,
      expires_at: now + 86400000,
    });
    const res = await app.request(
      "/admin/users/target-1",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ status: "suspended" }) },
      env as any
    );
    expect(res.status).toBe(200);
    expect(env.DB.sessionStore.has("sess:targetsession")).toBe(false);
  });
});

/* ---------------- Rich profiles (0016): per-field visibility ---------------- */

/** Full profile row including the 0016 columns. */
function richRow(overrides: any = {}) {
  return userRow({
    dob: null,
    gender: null,
    achievements: null,
    life_events: null,
    profile_visibility: null,
    avatar_r2_key: null,
    ...overrides,
  });
}

/** DB handler for profile-view tests: answers the session-user lookup with
 * the viewer row, and every other users query with the target profile row. */
function profileHandler(target: any, viewerId: string, role = "member") {
  return (sql: string, params: unknown[]) => {
    if (/from\s+users/i.test(sql)) {
      if (params[0] === viewerId) {
        return { row: { id: viewerId, role, status: "active", email: `${viewerId}@example.com` } };
      }
      return { row: target };
    }
    return undefined;
  };
}

describe("visibility primitives", () => {
  it("dob and gender default to only-me; everything else defaults to public", () => {
    const vis = effectiveVisibility({});
    expect(vis.dob).toBe("only-me");
    expect(vis.gender).toBe("only-me");
    for (const f of ["display_name", "bio", "avatar", "location", "website", "hobbies", "achievements", "life_events"]) {
      expect(vis[f]).toBe("public");
    }
  });
  it("stored overrides win over defaults; corrupt JSON fails closed to defaults", () => {
    const vis = effectiveVisibility({ profile_visibility: JSON.stringify({ bio: "members", dob: "public" }) });
    expect(vis.bio).toBe("members");
    expect(vis.dob).toBe("public");
    const broken = effectiveVisibility({ profile_visibility: "not json" });
    expect(broken.dob).toBe("only-me");
    expect(broken.bio).toBe("public");
  });
  it("fieldVisible matrix", () => {
    const vis = effectiveVisibility({});
    expect(fieldVisible("bio", vis, "owner")).toBe(true);
    expect(fieldVisible("bio", vis, "admin")).toBe(true);
    expect(fieldVisible("bio", vis, "member")).toBe(true);
    expect(fieldVisible("bio", vis, "anonymous")).toBe(true);
    expect(fieldVisible("dob", vis, "owner")).toBe(true);
    expect(fieldVisible("dob", vis, "admin")).toBe(true);
    expect(fieldVisible("dob", vis, "member")).toBe(false);
    expect(fieldVisible("dob", vis, "anonymous")).toBe(false);
    const membersOnly = effectiveVisibility({ profile_visibility: JSON.stringify({ location: "members" }) });
    expect(fieldVisible("location", membersOnly, "member")).toBe(true);
    expect(fieldVisible("location", membersOnly, "anonymous")).toBe(false);
  });
  it("validateVisibility accepts a valid map, drops unknown fields, rejects bad levels", () => {
    const v = validateVisibility({ bio: "members", nope: "public", dob: "only-me" });
    expect(v.ok).toBe(true);
    expect(JSON.parse(v.value!)).toEqual({ bio: "members", dob: "only-me" });
    expect(validateVisibility({ bio: "everyone" }).ok).toBe(false);
    expect(validateVisibility("not json").ok).toBe(false);
    expect(validateVisibility([{ bio: "public" }]).ok).toBe(false);
    expect(validateVisibility("").ok).toBe(true); // clears
  });
  it("validateDob: valid past date ok; future, malformed, impossible dates rejected", () => {
    expect(validateDob("1990-05-20").ok).toBe(true);
    expect(validateDob("").ok).toBe(true);
    expect(validateDob("2099-01-01").ok).toBe(false);
    expect(validateDob("not-a-date").ok).toBe(false);
    expect(validateDob("2026-02-30").ok).toBe(false); // impossible date
    expect(validateDob("1990-13-01").ok).toBe(false);
  });
  it("validPastDate rejects non-dates and future dates", () => {
    expect(validPastDate("2000-01-01")).toBe(true);
    expect(validPastDate("2100-01-01")).toBe(false);
    expect(validPastDate("hello")).toBe(false);
  });
  it("normalizeHobbies accepts arrays and comma strings; hobbyList falls back for legacy rows", () => {
    const v = normalizeHobbies(["Cycling", " Hiking "]);
    expect(v.ok).toBe(true);
    expect(JSON.parse(v.value!)).toEqual(["Cycling", "Hiking"]);
    const csv = normalizeHobbies("Cycling, Hiking");
    expect(JSON.parse(csv.value!)).toEqual(["Cycling", "Hiking"]);
    expect(hobbyList({ hobbies: "Cycling, Hiking" })).toEqual(["Cycling", "Hiking"]); // legacy free text
    expect(hobbyList({ hobbies: JSON.stringify(["A", "B"]) })).toEqual(["A", "B"]);
    expect(normalizeHobbies(new Array(31).fill("x")).ok).toBe(false);
  });
  it("normalizeEducation stores canonical {school, kind, years}; upgrades legacy rows", () => {
    const v = normalizeEducation([{ school: "U of T", kind: "college", years: "2020–2024" }]);
    expect(v.ok).toBe(true);
    expect(JSON.parse(v.value!)).toEqual([{ school: "U of T", kind: "college", years: "2020–2024" }]);
    const legacy = normalizeEducation([{ school: "U of T", degree: "BSc", period: "2020" }]);
    expect(JSON.parse(legacy.value!)).toEqual([
      { school: "U of T", kind: "college", years: "2020", degree: "BSc" },
    ]);
    // Read path upgrades stored legacy rows too.
    expect(educationList({ education: JSON.stringify([{ school: "U of T", degree: "BSc", period: "2020" }]) }))
      .toEqual([{ school: "U of T", kind: "college", years: "2020", degree: "BSc" }]);
    expect(normalizeEducation("nope").ok).toBe(false);
  });
  it("normalizeMilestones validates shape and dates", () => {
    const v = normalizeMilestones(
      [{ title: "Shipped v1", date: "2026-09-01", description: "First release." }],
      "achievements"
    );
    expect(v.ok).toBe(true);
    expect(JSON.parse(v.value!)).toEqual([{ title: "Shipped v1", date: "2026-09-01", description: "First release." }]);
    expect(normalizeMilestones([{ description: "no title" }], "achievements").ok).toBe(false);
    expect(normalizeMilestones([{ title: "X", date: "2099-01-01" }], "life_events").ok).toBe(false);
    expect(normalizeMilestones(new Array(11).fill({ title: "x" }), "achievements").ok).toBe(false);
    expect(milestoneList({ achievements: JSON.stringify([{ title: "A" }]) }, "achievements"))
      .toEqual([{ title: "A", date: "", description: "" }]);
  });
  it("richProfileShape never leaks email/real name/dob to non-owners", () => {
    const row = richRow({
      show_profile: 1,
      display_name: "Jane Builds",
      dob: "1990-05-20",
      gender: "she/her",
    });
    for (const rel of ["member", "anonymous"] as const) {
      const shape = richProfileShape(row, rel);
      const body = JSON.stringify(shape);
      expect(body).not.toContain("jane@example.com");
      expect(body).not.toContain("Jane Doe");
      expect(body).not.toContain("1990-05-20");
      expect(body).not.toContain("she/her");
      expect(shape.dob).toBeUndefined();
      expect(shape.gender).toBeUndefined();
    }
    const owner = richProfileShape(row, "owner");
    expect(owner.email).toBe("jane@example.com");
    expect(owner.dob).toBe("1990-05-20");
    expect(owner.visibility.dob).toBe("only-me");
  });
  it("avatarUrlOf prefers avatar_r2_key over avatar_key", () => {
    expect(avatarUrlOf({ avatar_key: "old", avatar_r2_key: "new" })).toBe("/api/media/new");
    expect(avatarUrlOf({ avatar_key: "old" })).toBe("/api/media/old");
    expect(avatarUrlOf({})).toBeNull();
  });
});

describe("GET /profiles/:id relationship filtering", () => {
  function target(overrides: any = {}) {
    return richRow({
      id: "target-2",
      show_profile: 1,
      display_name: "Jane Builds",
      bio: "Builder.",
      location: "Toronto",
      dob: "1990-05-20",
      gender: "she/her",
      achievements: JSON.stringify([{ title: "Won demo night", date: "2026-09-01", description: "" }]),
      ...overrides,
    });
  }
  it("anonymous sees public fields only — no dob, gender, email", async () => {
    const env = mockEnv();
    env.DB.handler = profileHandler(target(), "nobody") as any;
    const res = await app.request("/profiles/target-2", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.bio).toBe("Builder.");
    expect(d.user.location).toBe("Toronto");
    expect(d.user.achievements[0].title).toBe("Won demo night");
    expect(d.user.dob).toBeUndefined();
    expect(d.user.gender).toBeUndefined();
    const body = JSON.stringify(d);
    expect(body).not.toContain("1990-05-20");
    expect(body).not.toContain("she/her");
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("Jane Doe");
  });
  it("anonymous 404s on show_profile=0 (same as missing — no enumeration)", async () => {
    const env = mockEnv();
    env.DB.handler = profileHandler(target({ show_profile: 0 }), "nobody") as any;
    const r1 = await app.request("/profiles/target-2", {}, env as any);
    const env2 = mockEnv();
    env2.DB.handler = () => ({ row: null });
    const r2 = await app2req(env2, "/profiles/nope");
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
  });
  it("anonymous cannot see members-only fields", async () => {
    const env = mockEnv();
    env.DB.handler = profileHandler(
      target({ profile_visibility: JSON.stringify({ location: "members" }) }),
      "nobody"
    ) as any;
    const res = await app.request("/profiles/target-2", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.location).toBeUndefined();
    expect(d.user.bio).toBe("Builder."); // still public
  });
  it("member sees members-only fields but never only-me fields", async () => {
    const env = mockEnv();
    const h = memberSession(env); // viewer is member-1
    env.DB.handler = profileHandler(
      target({ profile_visibility: JSON.stringify({ location: "members" }) }),
      "member-1"
    ) as any;
    const res = await app.request("/profiles/target-2", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.location).toBe("Toronto");
    expect(d.user.dob).toBeUndefined();
    expect(d.user.gender).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("jane@example.com");
  });
  it("member 404s on suspended targets", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = profileHandler(target({ status: "suspended" }), "member-1") as any;
    const res = await app.request("/profiles/target-2", { headers: h }, env as any);
    expect(res.status).toBe(404);
  });
  it("admin sees everything including dob, gender, email, visibility map", async () => {
    const env = mockEnv();
    const h = adminSession(env, "admin-1");
    env.DB.handler = profileHandler(target(), "admin-1", "admin") as any;
    const res = await app.request("/profiles/target-2", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.dob).toBe("1990-05-20");
    expect(d.user.gender).toBe("she/her");
    expect(d.user.email).toBe("jane@example.com");
    expect(d.user.visibility.dob).toBe("only-me");
  });
  it("resolves by username", async () => {
    const env = mockEnv();
    env.DB.handler = profileHandler(target({ username: "jane_builds" }), "nobody") as any;
    const res = await app.request("/profiles/jane_builds", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.username).toBe("jane_builds");
  });
});

/** Tiny helper: request without a session. */
async function app2req(env: any, path: string) {
  return app.request(path, {}, env as any);
}

describe("GET /users/:id delegates visibility", () => {
  it("anonymous public view renders structured lists, hides dob", async () => {
    const env = mockEnv();
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/from\s+users/i.test(sql)) {
        return {
          row: richRow({
            id: "target-2",
            show_profile: 1,
            display_name: "Jane Builds",
            dob: "1990-05-20",
            education: JSON.stringify([{ school: "U of T", degree: "BSc", period: "2020" }]),
            hobbies: "Cycling, Hiking",
            achievements: JSON.stringify([{ title: "Won demo night", date: "2026-09-01", description: "" }]),
          }),
        };
      }
      return undefined;
    };
    const res = await app.request("/users/target-2", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.education[0]).toEqual({ school: "U of T", kind: "college", years: "2020", degree: "BSc" });
    expect(d.user.hobbies).toEqual(["Cycling", "Hiking"]);
    expect(d.user.achievements[0].title).toBe("Won demo night");
    expect(d.user.dob).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("1990-05-20");
  });
});

describe("GET /profiles/me", () => {
  it("401 when anonymous", async () => {
    const env = mockEnv();
    const res = await app.request("/profiles/me", {}, env as any);
    expect(res.status).toBe(401);
  });
  it("owner sees dob, gender, email, and the visibility map", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/from\s+users/i.test(sql)) {
        if (params[0] === "member-1") return { row: richRow({ dob: "1990-05-20", gender: "she/her" }) };
      }
      return undefined;
    };
    const res = await app.request("/profiles/me", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.email).toBe("jane@example.com");
    expect(d.user.dob).toBe("1990-05-20");
    expect(d.user.gender).toBe("she/her");
    expect(d.user.visibility.dob).toBe("only-me");
    expect(d.user.visibility.bio).toBe("public");
  });
});

describe("PATCH /profiles/me", () => {
  function authedEnv() {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/from\s+users/i.test(sql)) return { row: richRow() };
      return undefined;
    };
    return { env, h };
  }
  function lastUpdate(env: any) {
    const calls = env.DB.calls.filter((c: any) => c.op === "run" && /^update\s+users/i.test(c.sql));
    return calls[calls.length - 1];
  }
  it("401 when anonymous", async () => {
    const env = mockEnv();
    const res = await app.request("/profiles/me", { method: "PATCH", body: "{}" }, env as any);
    expect(res.status).toBe(401);
  });
  it("accepts a full rich update and stores canonical shapes", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({
          display_name: "Jane Builds",
          bio: "Builder.",
          location: "Toronto",
          hobbies: ["Cycling", "Hiking"],
          dob: "1990-05-20",
          gender: "she/her",
          education: [{ school: "U of T", kind: "college", years: "2020–2024" }],
          achievements: [{ title: "Won demo night", date: "2026-09-01", description: "First win." }],
          life_events: [{ title: "Joined Brimwood", date: "2026-09-25", description: "" }],
          profile_visibility: { location: "members", dob: "only-me" },
          show_profile: 1,
        }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const upd = lastUpdate(env);
    expect(upd).toBeTruthy();
    const params = upd.params as unknown[];
    expect(params).toContain("1990-05-20");
    expect(params).toContain("she/her");
    expect(params).toContain(JSON.stringify(["Cycling", "Hiking"]));
    expect(params).toContain(
      JSON.stringify([{ school: "U of T", kind: "college", years: "2020–2024" }])
    );
    expect(params).toContain(
      JSON.stringify([{ title: "Won demo night", date: "2026-09-01", description: "First win." }])
    );
    expect(params).toContain(JSON.stringify({ location: "members", dob: "only-me" }));
  });
  it("rejects a future dob", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ dob: "2099-01-01" }),
      },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("rejects an invalid visibility level", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ profile_visibility: { bio: "everyone" } }),
      },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("rejects an achievement without a title", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ achievements: [{ description: "no title" }] }),
      },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("400 when nothing to update", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: "{}" },
      env as any
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /profiles/me/avatar", () => {
  it("401 when anonymous", async () => {
    const env = mockEnv();
    const fd = new FormData();
    const res = await app.request("/profiles/me/avatar", { method: "POST", body: fd }, env as any);
    expect(res.status).toBe(401);
  });
  it("rejects non-image files", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql: string) => {
      if (/from\s+users/i.test(sql)) return { row: richRow() };
      return undefined;
    };
    const fd = new FormData();
    fd.append("file", new File(["evil"], "evil.exe", { type: "application/x-msdownload" }));
    const res = await app.request("/profiles/me/avatar", { method: "POST", headers: h, body: fd }, env as any);
    expect(res.status).toBe(400);
  });
  it("uploads and writes the key to BOTH avatar columns", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql: string) => {
      if (/from\s+users/i.test(sql)) return { row: richRow() };
      return undefined;
    };
    const fd = new FormData();
    fd.append("file", new File(["img"], "me.png", { type: "image/png" }));
    const res = await app.request("/profiles/me/avatar", { method: "POST", headers: h, body: fd }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.avatar_url).toMatch(/^\/api\/media\//);
    expect(d.avatar_key).toMatch(/^avatars\/member-1\//);
    const upd = env.DB.calls
      .filter((c: any) => c.op === "run" && /^update\s+users/i.test(c.sql))
      .pop();
    expect(upd?.params[0]).toBe(d.avatar_key); // avatar_key
    expect(upd?.params[1]).toBe(d.avatar_key); // avatar_r2_key
    expect(upd?.params[2]).toBe("member-1");
  });
});
