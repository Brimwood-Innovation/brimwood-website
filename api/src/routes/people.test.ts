/* Route tests: people - deck section 23 people screen.
 * Only opt-in members appear, sorted by name, with builder fields and
 * skills; only-me fields are omitted and cannot match a search; the
 * directory never leaks email or real name.
 */
import { describe, it, expect } from "vitest";
import app from "./people";
import { mockEnv, memberSession } from "../test/helpers";
import type { MockEnv } from "../test/helpers";

interface DirectoryFixture {
  id: string;
  username: string | null;
  display_name: string | null;
  name: string | null;
  is_admin: number;
  is_moderator: number;
  avatar_key: string | null;
  avatar_r2_key: string | null;
  building_now: string | null;
  can_help_with: string | null;
  looking_for: string | null;
}

const ADA: DirectoryFixture = {
  id: "u-ada",
  username: "ada",
  display_name: "Ada",
  name: "Ada Lovelace",
  is_admin: 0,
  is_moderator: 0,
  avatar_key: null,
  avatar_r2_key: null,
  building_now: "Inventory tool for bakeries",
  can_help_with: "Spreadsheets that turn into apps",
  looking_for: "First bakery owners to test",
};

const BO: DirectoryFixture = {
  id: "u-bo",
  username: "bo",
  display_name: "Bo",
  name: "Bo Chen",
  is_admin: 0,
  is_moderator: 1,
  avatar_key: null,
  avatar_r2_key: null,
  building_now: "Scope Canvas, a one-page planner",
  can_help_with: "Python and small automations",
  looking_for: "Feedback on onboarding",
};

const CY: DirectoryFixture = {
  id: "u-cy",
  username: null,
  display_name: "Cy",
  name: "Cy Rao",
  is_admin: 0,
  is_moderator: 0,
  avatar_key: null,
  avatar_r2_key: null,
  building_now: "Booking page for a mobile bike repair",
  can_help_with: "Brand and copy",
  looking_for: "A co-builder who codes",
};

const ERIN: DirectoryFixture = {
  id: "u-erin",
  username: "erin",
  display_name: "Erin",
  name: "Erin Park",
  is_admin: 1,
  is_moderator: 0,
  avatar_key: null,
  avatar_r2_key: null,
  building_now: "Sensor kit for community gardens",
  can_help_with: "Soldering and 3D printing",
  looking_for: "Pilot gardens in the east end",
};

const ROWS = [ADA, BO, CY, ERIN];

const SKILL_ROWS = [
  { user_id: "u-ada", slug: "python", label: "Python" },
  { user_id: "u-ada", slug: "product-design", label: "Product design" },
  { user_id: "u-bo", slug: "python", label: "Python" },
];

const TAGS = ["python", "product-design", "marketing"];

/* user_id -> stored visibility rows; Bo hides their building project. */
const VISIBILITY: Record<string, { field: string; visibility: string }[]> = {
  "u-bo": [{ field: "building_now", visibility: "only-me" }],
};

function peopleEnv() {
  const env = mockEnv();
  const cookie = memberSession(env, "member-1");
  const prev = env.DB.handler;
  const queries: string[] = [];
  env.DB.handler = (sql: string, params: unknown[]) => {
    queries.push(sql);
    if (/FROM profile_field_visibility/i.test(sql)) {
      return { results: VISIBILITY[params[0] as string] || [] };
    }
    if (/FROM skill_tags/i.test(sql)) {
      const slug = params[0] as string;
      return TAGS.includes(slug) ? { row: { slug } } : { row: null };
    }
    if (/FROM member_skills/i.test(sql)) {
      const ids = new Set(params as string[]);
      return { results: SKILL_ROWS.filter((r) => ids.has(r.user_id)) };
    }
    if (/FROM users u JOIN member_profiles/i.test(sql)) {
      return { results: ROWS.map((r) => ({ ...r })) };
    }
    return prev?.(sql, params);
  };
  return { env, cookie, queries };
}

const get = (env: MockEnv, cookie: Record<string, string>, path: string) =>
  app.request(path, { method: "GET", headers: { ...cookie } }, env as any);

describe("people directory", () => {
  it("lists opt-in members sorted by name with builder fields and badges", async () => {
    const { env, cookie, queries } = peopleEnv();
    const res = await get(env, cookie, "/");
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.people.map((p: any) => p.display_name)).toEqual([
      "Ada",
      "Bo",
      "Cy",
      "Erin",
    ]);
    const ada = body.people[0];
    expect(ada.profile_url).toBe("/@ada");
    expect(ada.building_now).toBe("Inventory tool for bakeries");
    expect(ada.can_help_with).toBe("Spreadsheets that turn into apps");
    expect(ada.looking_for).toBe("First bakery owners to test");
    expect(ada.skills.map((s: any) => s.slug)).toEqual([
      "python",
      "product-design",
    ]);
    expect(ada.badge).toBeNull();
    expect(body.people[1].badge).toBe("Moderator");
    expect(body.people[3].badge).toBe("Staff");
    expect(body.people[2].profile_url).toBe("/u/u-cy");
    for (const p of body.people) {
      expect(p).not.toHaveProperty("email");
      expect(p).not.toHaveProperty("name");
    }
    const dirSql = queries.find((q) => /FROM users u JOIN member_profiles/i.test(q)) || "";
    expect(dirSql).toMatch(/directory_opt_in = 1/);
    expect(dirSql).toMatch(/status = 'active'/);
    expect(dirSql).toMatch(/u\.id != \?/);
    expect(dirSql).toMatch(/block_pairs/);
    expect(dirSql).toMatch(/user_effective_roles/);
  });

  it("omits only-me fields from the card", async () => {
    const { env, cookie } = peopleEnv();
    const res = await get(env, cookie, "/");
    const body: any = await res.json();
    const bo = body.people.find((p: any) => p.id === "u-bo");
    expect(bo).not.toHaveProperty("building_now");
    expect(bo.can_help_with).toBe("Python and small automations");
  });

  it("requires sign-in", async () => {
    const { env } = peopleEnv();
    const res = await app.request("/", { method: "GET" }, env as any);
    expect(res.status).toBe(401);
  });

  it("filters by curated skill and rejects an unknown skill", async () => {
    const { env, cookie } = peopleEnv();
    const res = await get(env, cookie, "/?skill=python");
    const body: any = await res.json();
    expect(body.people.map((p: any) => p.display_name)).toEqual(["Ada", "Bo"]);
    const empty = await get(env, cookie, "/?skill=marketing");
    expect((await empty.json() as any).people).toEqual([]);
    const bad = await get(env, cookie, "/?skill=nope");
    expect(bad.status).toBe(400);
  });

  it("searches visible fields only, never a hidden project", async () => {
    const { env, cookie } = peopleEnv();
    const inv = await get(env, cookie, "/?q=inventory");
    expect((await inv.json() as any).people.map((p: any) => p.display_name)).toEqual(["Ada"]);
    const hidden = await get(env, cookie, "/?q=scope");
    expect((await hidden.json() as any).people).toEqual([]);
    const skill = await get(env, cookie, "/?q=python");
    expect((await skill.json() as any).people.map((p: any) => p.display_name)).toEqual(["Ada", "Bo"]);
  });
});
