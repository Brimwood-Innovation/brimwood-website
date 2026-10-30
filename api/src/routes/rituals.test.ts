/* Route tests: rituals read API - hub home "This week's rituals".
 * Members see active, members-wide rituals plus active-group rituals
 * for groups they actively belong to; staff also see other groups'
 * active rituals. Inactive rituals and rituals tied to proposed,
 * rejected, or archived groups stay hidden from everyone here.
 */
import { describe, it, expect } from "vitest";
import app from "./rituals";
import { mockEnv, memberSession, adminSession } from "../test/helpers";
import type { MockEnv } from "../test/helpers";

interface RitualFixture {
  id: string;
  title: string;
  weekday: number;
  local_time: string;
  tz: string;
  group_id: string | null;
  group_slug: string | null;
  group_name: string | null;
  group_status: string | null;
  active: number;
}

const FIXTURES: RitualFixture[] = [
  { id: "r-mon", title: "Monday debrief", weekday: 1, local_time: "09:00", tz: "America/Toronto", group_id: null, group_slug: null, group_name: null, group_status: null, active: 1 },
  { id: "r-sun", title: "Sunday reset", weekday: 0, local_time: "10:00", tz: "America/Toronto", group_id: null, group_slug: null, group_name: null, group_status: null, active: 1 },
  { id: "r-wed", title: "Wednesday build log", weekday: 3, local_time: "18:30", tz: "America/Toronto", group_id: "g-crew", group_slug: "demo-night-crew", group_name: "Demo Night Crew", group_status: "active", active: 1 },
  { id: "r-fri", title: "Friday feedback", weekday: 5, local_time: "12:00", tz: "America/Toronto", group_id: "g-other", group_slug: "forge-talk", group_name: "Forge Talk", group_status: "active", active: 1 },
  { id: "r-draft", title: "Draft ritual", weekday: 2, local_time: "10:00", tz: "America/Toronto", group_id: null, group_slug: null, group_name: null, group_status: null, active: 0 },
  { id: "r-prop", title: "Proposed group ritual", weekday: 4, local_time: "10:00", tz: "America/Toronto", group_id: "g-draft", group_slug: "draft-group", group_name: "Draft Group", group_status: "proposed", active: 1 },
];

/* member-1 actively belongs to g-crew only; admin-1 is staff. */
function ritualsEnv(staff = false) {
  const env = mockEnv();
  const cookie = staff
    ? adminSession(env, "admin-1")
    : memberSession(env, "member-1");
  const prev = env.DB.handler;
  env.DB.handler = (sql: string, params: unknown[]) => {
    if (/FROM rituals/i.test(sql)) {
      const userId = params[0] as string;
      const staffFlag = params[1] as number;
      const limit = params[2] as number;
      const visible = FIXTURES.filter((r) => {
        if (r.active !== 1) return false;
        if (r.group_id === null) return true;
        if (r.group_status !== "active") return false;
        if (staffFlag === 1) return true;
        return userId === "member-1" && r.group_id === "g-crew";
      }).sort((a, b) => {
        const day = (w: number) => (w + 6) % 7;
        return (
          day(a.weekday) - day(b.weekday) ||
          a.local_time.localeCompare(b.local_time) ||
          a.title.localeCompare(b.title)
        );
      }).slice(0, limit);
      return {
        results: visible.map((r) => ({
          id: r.id,
          title: r.title,
          weekday: r.weekday,
          local_time: r.local_time,
          tz: r.tz,
          group_slug: r.group_slug,
          group_name: r.group_name,
        })),
      };
    }
    return prev?.(sql, params);
  };
  return { env, cookie };
}

const get = (env: MockEnv, cookie: Record<string, string>, path: string) =>
  app.request(path, { method: "GET", headers: { ...cookie } }, env as any);

describe("rituals list", () => {
  it("lists members-wide and own-group rituals Monday first, hiding the rest", async () => {
    const { env, cookie } = ritualsEnv();
    const res = await get(env, cookie, "/");
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.rituals.map((r: any) => r.id)).toEqual([
      "r-mon",
      "r-wed",
      "r-sun",
    ]);
    const wed = body.rituals[1];
    expect(wed.group).toEqual({ slug: "demo-night-crew", name: "Demo Night Crew" });
    expect(body.rituals[0].group).toBeNull();
    for (const r of body.rituals) {
      expect(r).not.toHaveProperty("body_template");
      expect(r).not.toHaveProperty("author_id");
      expect(r).not.toHaveProperty("group_id");
    }
  });

  it("lets staff see other groups' active rituals, still hiding drafts and proposed groups", async () => {
    const { env, cookie } = ritualsEnv(true);
    const res = await get(env, cookie, "/");
    const body: any = await res.json();
    expect(body.rituals.map((r: any) => r.id)).toEqual([
      "r-mon",
      "r-wed",
      "r-fri",
      "r-sun",
    ]);
  });

  it("requires sign-in", async () => {
    const { env } = ritualsEnv();
    const res = await app.request("/", { method: "GET" }, env as any);
    expect(res.status).toBe(401);
  });
});
