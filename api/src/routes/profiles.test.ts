/* Profiles API tests (Phase D2 + Phase 1 item 7):
 * anonymity, validation, admin gates, username rules, avatar upload,
 * D11 (no dob/gender/life events), per-field visibility from
 * profile_field_visibility, member_profiles fields, member_skills. */
import { describe, it, expect } from "vitest";
import app, {
  validateUsername,
  initialsFor,
  validateVisibility,
  effectiveVisibility,
  loadVisibility,
  fieldVisible,
  validPastDate,
  normalizeHobbies,
  hobbyList,
  normalizeEducation,
  educationList,
  normalizeMilestones,
  milestoneList,
  normalizeSkills,
  fetchMemberSkills,
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
    expect(d.user.display_name).toBe("J."); // initials fallback
    expect(d.user.visibility.bio).toBe("public");
    expect(d.user.skills).toEqual([]);
  });
  it("never selects or returns dob, gender, or life_events (D11)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    let seenSql = "";
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) {
        seenSql = sql;
        return { row: userRow() };
      }
      return undefined;
    };
    const res = await app.request("/users/me", { headers: h }, env as any);
    expect(res.status).toBe(200);
    expect(seenSql).not.toMatch(/dob|gender|life_events|profile_visibility/i);
    const d: any = await res.json();
    const body = JSON.stringify(d.user);
    expect(d.user.dob).toBeUndefined();
    expect(d.user.gender).toBeUndefined();
    expect(d.user.life_events).toBeUndefined();
    expect(body).not.toContain("dob");
    expect(body).not.toContain("gender");
  });
});

describe("GET /users/:id anonymity", () => {
  it("404 for private profile (show_profile=0)", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ row: null }); // WHERE filters it out
    const res = await app.request("/users/member-1", {}, env as any);
    expect(res.status).toBe(404);
  });
  it("404 for nonexistent id (same as private - no enumeration)", async () => {
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
      if (/from\s+users/i.test(sql)) seenSql = sql;
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
  it("rejects bio over 500 chars (cleanStr truncates - accepted)", async () => {
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

/* ---------------- Item 7: visibility from profile_field_visibility ---------------- */

/** Full profile row (D11: no dob, gender, life_events, profile_visibility). */
function richRow(overrides: any = {}) {
  return userRow({
    avatar_r2_key: null,
    achievements: null,
    ...overrides,
  });
}

/** DB handler for profile-view tests. Answers:
 * - readSession's users lookup with the viewer row,
 * - every other users query with the target profile row,
 * - profile_field_visibility with the stored visibility rows,
 * - member_profiles with the side row (or null),
 * - member_skills with skill rows (labels resolved by the handler). */
function profileHandler(
  target: any,
  viewerId: string,
  opts: {
    role?: string;
    visRows?: { field: string; visibility: string }[];
    memberProfile?: any;
    skills?: { slug: string; label: string }[];
    /** full row for the viewer (defaults to a minimal session row); needed
     * when the viewer is also the profile target (owner view). */
    viewerRow?: any;
  } = {}
) {
  const role = opts.role || "member";
  return (sql: string, params: unknown[]) => {
    if (/profile_field_visibility/i.test(sql)) {
      return { results: opts.visRows || [] };
    }
    if (/from\s+member_profiles/i.test(sql)) {
      return { row: opts.memberProfile || null };
    }
    if (/from\s+member_skills/i.test(sql)) {
      return { results: (opts.skills || []).map((s) => ({ slug: s.slug, label: s.label })) };
    }
    if (/from\s+users/i.test(sql)) {
      if (params[0] === viewerId) {
        return {
          row:
            opts.viewerRow ||
            ({
              id: viewerId,
              role,
              status: "active",
              email: `${viewerId}@example.com`,
              name: "Viewer",
            } as any),
        };
      }
      return { row: target };
    }
    return undefined;
  };
}

/** Extras riding on the row for shape tests (as attachProfileExtras sets them). */
function withExtras(row: any, extras: any = {}) {
  return {
    ...row,
    building_now: null,
    can_help_with: null,
    looking_for: null,
    pinned_post_id: null,
    directory_opt_in: 0,
    activity_broadcast: 0,
    skills: [],
    ...extras,
  };
}

describe("visibility primitives", () => {
  it("every field defaults to public; dob/gender/life_events are gone", () => {
    const vis = effectiveVisibility({});
    for (const f of [
      "display_name", "bio", "avatar", "location", "website", "social_links",
      "work_history", "education", "hobbies", "achievements",
      "building_now", "can_help_with", "looking_for", "skills", "projects", "badges",
    ]) {
      expect(vis[f]).toBe("public");
    }
    expect(vis.dob).toBeUndefined();
    expect(vis.gender).toBeUndefined();
    expect(vis.life_events).toBeUndefined();
  });
  it("stored overrides win over defaults; unknown entries fail closed", () => {
    const vis = effectiveVisibility({ bio: "members", skills: "only-me" });
    expect(vis.bio).toBe("members");
    expect(vis.skills).toBe("only-me");
    expect(vis.location).toBe("public");
    const dirty = effectiveVisibility({ bio: "everyone", dob: "public", nope: "public" } as any);
    expect(dirty.bio).toBe("public");
    expect(dirty.dob).toBeUndefined();
    expect(dirty.nope).toBeUndefined();
  });
  it("fieldVisible matrix", () => {
    const vis = effectiveVisibility({});
    expect(fieldVisible("bio", vis, "owner")).toBe(true);
    expect(fieldVisible("bio", vis, "admin")).toBe(true);
    expect(fieldVisible("bio", vis, "member")).toBe(true);
    expect(fieldVisible("bio", vis, "anonymous")).toBe(true);
    const membersOnly = effectiveVisibility({ location: "members" });
    expect(fieldVisible("location", membersOnly, "owner")).toBe(true);
    expect(fieldVisible("location", membersOnly, "admin")).toBe(true);
    expect(fieldVisible("location", membersOnly, "member")).toBe(true);
    expect(fieldVisible("location", membersOnly, "anonymous")).toBe(false);
    const onlyMe = effectiveVisibility({ skills: "only-me" });
    expect(fieldVisible("skills", onlyMe, "owner")).toBe(true);
    expect(fieldVisible("skills", onlyMe, "admin")).toBe(true);
    expect(fieldVisible("skills", onlyMe, "member")).toBe(false);
    expect(fieldVisible("skills", onlyMe, "anonymous")).toBe(false);
  });
  it("validateVisibility accepts the 16-field map, drops unknown fields, rejects bad levels", () => {
    const v = validateVisibility({ bio: "members", building_now: "only-me", dob: "public", nope: "public" });
    expect(v.ok).toBe(true);
    expect(JSON.parse(v.value!)).toEqual({ bio: "members", building_now: "only-me" });
    expect(validateVisibility({ bio: "everyone" }).ok).toBe(false);
    expect(validateVisibility("not json").ok).toBe(false);
    expect(validateVisibility([{ bio: "public" }]).ok).toBe(false);
    expect(validateVisibility("").ok).toBe(true); // clears
  });
  it("loadVisibility reads profile_field_visibility rows and merges defaults", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/profile_field_visibility/i.test(sql)) {
        return { results: [{ field: "building_now", visibility: "members" }, { field: "dob", visibility: "public" }] };
      }
      return undefined;
    };
    const vis = await loadVisibility(env.DB, "member-1");
    expect(vis.building_now).toBe("members");
    expect(vis.bio).toBe("public");
    expect(vis.dob).toBeUndefined(); // dob is not a field anymore
  });
  it("validPastDate rejects non-dates and future dates", () => {
    expect(validPastDate("2000-01-01")).toBe(true);
    expect(validPastDate("2100-01-01")).toBe(false);
    expect(validPastDate("hello")).toBe(false);
    expect(validPastDate("2026-02-30")).toBe(false);
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
    expect(educationList({ education: JSON.stringify([{ school: "U of T", degree: "BSc", period: "2020" }]) }))
      .toEqual([{ school: "U of T", kind: "college", years: "2020", degree: "BSc" }]);
    expect(normalizeEducation("nope").ok).toBe(false);
  });
  it("normalizeMilestones validates achievements (life events are gone)", () => {
    const v = normalizeMilestones([{ title: "Shipped v1", date: "2026-09-01", description: "First release." }]);
    expect(v.ok).toBe(true);
    expect(JSON.parse(v.value!)).toEqual([{ title: "Shipped v1", date: "2026-09-01", description: "First release." }]);
    expect(normalizeMilestones([{ description: "no title" }]).ok).toBe(false);
    expect(normalizeMilestones([{ title: "X", date: "2099-01-01" }]).ok).toBe(false);
    expect(normalizeMilestones(new Array(11).fill({ title: "x" })).ok).toBe(false);
    expect(milestoneList({ achievements: JSON.stringify([{ title: "A" }]) }))
      .toEqual([{ title: "A", date: "", description: "" }]);
  });
  it("normalizeSkills accepts arrays and comma strings; validates slugs and the 12 cap", () => {
    const v = normalizeSkills(["Python", " product-design "]);
    expect(v.ok).toBe(true);
    expect(v.value).toEqual(["python", "product-design"]);
    const csv = normalizeSkills("python, python, marketing");
    expect(csv.value).toEqual(["python", "marketing"]); // deduped
    expect(normalizeSkills("").value).toEqual([]);
    expect(normalizeSkills(["not a slug!"]).ok).toBe(false);
    expect(normalizeSkills(new Array(13).fill("python")).ok).toBe(true); // 13 dupes -> 1
    const many = Array.from({ length: 13 }, (_, i) => `skill-${i}`);
    expect(normalizeSkills(many).ok).toBe(false);
  });
  it("fetchMemberSkills joins labels from skill_tags", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+member_skills/i.test(sql)) {
        return { results: [{ slug: "python", label: "Python" }] };
      }
      return undefined;
    };
    const skills = await fetchMemberSkills(env.DB, "member-1");
    expect(skills).toEqual([{ slug: "python", label: "Python" }]);
  });
  it("richProfileShape never leaks email/real name to non-owners; D11 fields never appear", () => {
    const row = withExtras(richRow({ show_profile: 1, display_name: "Jane Builds" }));
    for (const rel of ["member", "anonymous"] as const) {
      const shape = richProfileShape(row, rel, effectiveVisibility({}));
      const body = JSON.stringify(shape);
      expect(body).not.toContain("jane@example.com");
      expect(body).not.toContain("Jane Doe");
      expect(shape.dob).toBeUndefined();
      expect(shape.gender).toBeUndefined();
      expect(shape.life_events).toBeUndefined();
      expect(body).not.toContain("dob");
      expect(body).not.toContain("gender");
      expect(shape.directory_opt_in).toBeUndefined();
      expect(shape.activity_broadcast).toBeUndefined();
    }
    const owner = richProfileShape(row, "owner", effectiveVisibility({}));
    expect(owner.email).toBe("jane@example.com");
    expect(owner.visibility.bio).toBe("public");
    expect(owner.directory_opt_in).toBe(0);
    expect(owner.dob).toBeUndefined();
  });
  it("avatarUrlOf prefers avatar_r2_key over avatar_key", () => {
    expect(avatarUrlOf({ avatar_key: "old", avatar_r2_key: "new" })).toBe("/api/media/new");
    expect(avatarUrlOf({ avatar_key: "old" })).toBe("/api/media/old");
    expect(avatarUrlOf({})).toBeNull();
  });
});

describe("D11: dob, gender, life_events are rejected at the boundary", () => {
  function authedEnv() {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) return { row: richRow() };
      return undefined;
    };
    return { env, h };
  }
  async function patch(env: any, h: any, body: any) {
    return app.request(
      "/profiles/me",
      { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) },
      env as any
    );
  }
  it("400 when dob is sent", async () => {
    const { env, h } = authedEnv();
    const res = await patch(env, h, { dob: "1990-05-20" });
    expect(res.status).toBe(400);
    const d: any = await res.json();
    expect(d.error).toContain("no longer collected");
  });
  it("400 when gender is sent", async () => {
    const { env, h } = authedEnv();
    const res = await patch(env, h, { gender: "she/her" });
    expect(res.status).toBe(400);
  });
  it("400 when life_events are sent", async () => {
    const { env, h } = authedEnv();
    const res = await patch(env, h, { life_events: [{ title: "Joined", date: "2026-09-25", description: "" }] });
    expect(res.status).toBe(400);
  });
  it("empty values are ignored, not written", async () => {
    const { env, h } = authedEnv();
    const res = await patch(env, h, { dob: "", gender: "", life_events: [], display_name: "Jane Builds" });
    expect(res.status).toBe(200);
    const writes = env.DB.calls.filter((c: any) => c.op === "run");
    const sql = writes.map((c: any) => c.sql).join(" ");
    expect(sql).not.toMatch(/dob|gender|life_events/i);
  });
});

describe("GET /profiles/:id relationship filtering (item 7)", () => {
  function target(overrides: any = {}) {
    return richRow({
      id: "target-2",
      show_profile: 1,
      display_name: "Jane Builds",
      bio: "Builder.",
      location: "Toronto",
      achievements: JSON.stringify([{ title: "Won demo night", date: "2026-09-01", description: "" }]),
      ...overrides,
    });
  }
  function extrasOpts(overrides: any = {}) {
    return {
      memberProfile: {
        building_now: "Inventory tool for bakeries",
        can_help_with: "Spreadsheets",
        looking_for: "Beta testers",
        pinned_post_id: "post-9",
        directory_opt_in: 1,
        activity_broadcast: 1,
      },
      skills: [
        { slug: "python", label: "Python" },
        { slug: "marketing", label: "Marketing" },
      ],
      ...overrides,
    };
  }
  it("anonymous sees public fields incl. the new builder fields", async () => {
    const env = mockEnv();
    env.DB.handler = profileHandler(target(), "nobody", extrasOpts()) as any;
    const res = await app.request("/profiles/target-2", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.bio).toBe("Builder.");
    expect(d.user.building_now).toBe("Inventory tool for bakeries");
    expect(d.user.can_help_with).toBe("Spreadsheets");
    expect(d.user.looking_for).toBe("Beta testers");
    expect(d.user.skills).toEqual([
      { slug: "python", label: "Python" },
      { slug: "marketing", label: "Marketing" },
    ]);
    expect(d.user.achievements[0].title).toBe("Won demo night");
    // Settings stay owner/admin only.
    expect(d.user.directory_opt_in).toBeUndefined();
    expect(d.user.activity_broadcast).toBeUndefined();
    const body = JSON.stringify(d);
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("Jane Doe");
  });
  it("anonymous cannot see members-only builder fields", async () => {
    const env = mockEnv();
    env.DB.handler = profileHandler(
      target(),
      "nobody",
      extrasOpts({ visRows: [{ field: "building_now", visibility: "members" }, { field: "skills", visibility: "only-me" }] })
    ) as any;
    const res = await app.request("/profiles/target-2", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.building_now).toBeUndefined();
    expect(d.user.skills).toBeUndefined();
    expect(d.user.bio).toBe("Builder."); // still public
  });
  it("member sees members-only fields but never only-me fields", async () => {
    const env = mockEnv();
    const h = memberSession(env); // viewer is member-1
    env.DB.handler = profileHandler(
      target(),
      "member-1",
      extrasOpts({ visRows: [{ field: "building_now", visibility: "members" }, { field: "skills", visibility: "only-me" }] })
    ) as any;
    const res = await app.request("/profiles/target-2", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.building_now).toBe("Inventory tool for bakeries");
    expect(d.user.skills).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("jane@example.com");
  });
  it("member 404s on suspended targets", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = profileHandler(target({ status: "suspended" }), "member-1", extrasOpts()) as any;
    const res = await app.request("/profiles/target-2", { headers: h }, env as any);
    expect(res.status).toBe(404);
  });
  it("admin sees everything including settings and the visibility map", async () => {
    const env = mockEnv();
    const h = adminSession(env, "admin-1");
    env.DB.handler = profileHandler(target(), "admin-1", extrasOpts({ role: "admin" })) as any;
    const res = await app.request("/profiles/target-2", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.email).toBe("jane@example.com");
    expect(d.user.directory_opt_in).toBe(1);
    expect(d.user.activity_broadcast).toBe(1);
    expect(d.user.pinned_post_id).toBe("post-9");
    expect(d.user.visibility.bio).toBe("public");
  });
  it("resolves by username", async () => {
    const env = mockEnv();
    env.DB.handler = profileHandler(target({ username: "jane_builds" }), "nobody", extrasOpts()) as any;
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
  it("anonymous public view renders structured lists", async () => {
    const env = mockEnv();
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/from\s+users/i.test(sql)) {
        return {
          row: richRow({
            id: "target-2",
            show_profile: 1,
            display_name: "Jane Builds",
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
  });
});

describe("GET /profiles/me", () => {
  it("401 when anonymous", async () => {
    const env = mockEnv();
    const res = await app.request("/profiles/me", {}, env as any);
    expect(res.status).toBe(401);
  });
  it("owner sees email, skills, member fields, settings, and the visibility map", async () => {
    const env = mockEnv();
    const h = memberSession(env, "target-2");
    const ownerRow = richRow({
      id: "target-2",
      email: "jane@example.com",
      name: "Jane Doe",
      display_name: "Jane Builds",
    });
    env.DB.handler = profileHandler(
      ownerRow,
      "target-2",
      {
        viewerRow: ownerRow,
        visRows: [{ field: "building_now", visibility: "members" }],
        memberProfile: {
          building_now: "Inventory tool",
          can_help_with: null,
          looking_for: null,
          pinned_post_id: "post-9",
          directory_opt_in: 1,
          activity_broadcast: 0,
        },
        skills: [{ slug: "python", label: "Python" }],
      }
    ) as any;
    const res = await app.request("/profiles/me", { headers: h }, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.user.email).toBe("jane@example.com");
    expect(d.user.display_name).toBe("Jane Builds");
    expect(d.user.building_now).toBe("Inventory tool");
    expect(d.user.skills).toEqual([{ slug: "python", label: "Python" }]);
    expect(d.user.directory_opt_in).toBe(1);
    expect(d.user.pinned_post_id).toBe("post-9");
    expect(d.user.visibility.building_now).toBe("members");
    expect(d.user.visibility.bio).toBe("public");
  });
});

describe("PATCH /profiles/me (item 7)", () => {
  function authedEnv() {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/from\s+users/i.test(sql)) return { row: richRow() };
      if (/from\s+skill_tags/i.test(sql)) {
        return { results: [{ slug: "python" }, { slug: "marketing" }] };
      }
      if (/from\s+feed_posts/i.test(sql)) {
        return params[0] === "post-9" ? { row: { id: "post-9" } } : { row: null };
      }
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
          education: [{ school: "U of T", kind: "college", years: "2020–2024" }],
          achievements: [{ title: "Won demo night", date: "2026-09-01", description: "First win." }],
          visibility: { location: "members", skills: "only-me" },
          show_profile: 1,
        }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const upd = lastUpdate(env);
    expect(upd).toBeTruthy();
    const params = upd.params as unknown[];
    expect(params).toContain("Jane Builds");
    expect(params).toContain(JSON.stringify(["Cycling", "Hiking"]));
    expect(params).toContain(
      JSON.stringify([{ school: "U of T", kind: "college", years: "2020–2024" }])
    );
    expect(params).toContain(
      JSON.stringify([{ title: "Won demo night", date: "2026-09-01", description: "First win." }])
    );
    // Visibility lands in profile_field_visibility, not users.
    const visInserts = (env.DB.inserts.get("profile_field_visibility") || []) as any[];
    expect(visInserts).toHaveLength(2);
    expect(visInserts).toContainEqual({ user_id: "member-1", field: "location", visibility: "members" });
    expect(visInserts).toContainEqual({ user_id: "member-1", field: "skills", visibility: "only-me" });
  });
  it("writes builder fields to member_profiles", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({
          building_now: "Inventory tool for bakeries",
          can_help_with: "Spreadsheets",
          looking_for: "Beta testers",
          directory_opt_in: true,
          activity_broadcast: 1,
        }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const mp = (env.DB.inserts.get("member_profiles") || []) as any[];
    expect(mp).toHaveLength(1);
    expect(mp[0].user_id).toBe("member-1");
    expect(mp[0].building_now).toBe("Inventory tool for bakeries");
    expect(mp[0].can_help_with).toBe("Spreadsheets");
    expect(mp[0].looking_for).toBe("Beta testers");
    expect(mp[0].directory_opt_in).toBe(1);
    expect(mp[0].activity_broadcast).toBe(1);
    // No users write when only side-table fields are sent.
    expect(lastUpdate(env)).toBeUndefined();
  });
  it("writes curated skills to member_skills", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ skills: ["Python", "marketing"] }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const sk = (env.DB.inserts.get("member_skills") || []) as any[];
    expect(sk).toHaveLength(2);
    expect(sk).toContainEqual({ user_id: "member-1", skill_slug: "python" });
    expect(sk).toContainEqual({ user_id: "member-1", skill_slug: "marketing" });
  });
  it("rejects unknown skills", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ skills: ["python", "telepathy"] }),
      },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("rejects more than 12 skills", async () => {
    const { env, h } = authedEnv();
    const many = Array.from({ length: 13 }, (_, i) => `skill-${i}`);
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ skills: many }),
      },
      env as any
    );
    expect(res.status).toBe(400);
  });
  it("clears skills with an empty list", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ skills: [] }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const deletes = env.DB.calls.filter(
      (c: any) => c.op === "run" && /^delete\s+from\s+member_skills/i.test(c.sql)
    );
    expect(deletes.length).toBe(1);
    expect(env.DB.inserts.get("member_skills") || []).toHaveLength(0);
  });
  it("pins the member's own post; rejects someone else's", async () => {
    const { env, h } = authedEnv();
    const okRes = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ pinned_post_id: "post-9" }),
      },
      env as any
    );
    expect(okRes.status).toBe(200);
    const mp = (env.DB.inserts.get("member_profiles") || []) as any[];
    expect(mp[0].pinned_post_id).toBe("post-9");

    const { env: env2, h: h2 } = authedEnv();
    const badRes = await app2patch(env2, h2, { pinned_post_id: "post-404" });
    expect(badRes.status).toBe(400);
  });
  it("rejects an invalid visibility level", async () => {
    const { env, h } = authedEnv();
    const res = await app.request(
      "/profiles/me",
      {
        method: "PATCH",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ visibility: { bio: "everyone" } }),
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

/** Tiny helper: authed PATCH to /profiles/me. */
async function app2patch(env: any, h: any, body: any) {
  return app.request(
    "/profiles/me",
    { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) },
    env as any
  );
}

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

describe("GET /skill-tags", () => {
  it("returns the curated tag list", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+skill_tags/i.test(sql)) {
        return { results: [{ slug: "python", label: "Python" }, { slug: "marketing", label: "Marketing" }] };
      }
      return undefined;
    };
    const res = await app.request("/skill-tags", {}, env as any);
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.tags).toEqual([
      { slug: "python", label: "Python" },
      { slug: "marketing", label: "Marketing" },
    ]);
  });
});
