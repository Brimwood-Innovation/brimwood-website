/* Route tests: groups - deck section 20 groups screen.
 * Cards show activity, never a member count; join follows the group
 * join policy; archived groups reopen only for a group admin or staff.
 */
import { describe, it, expect } from "vitest";
import app from "./groups";
import { mockEnv, memberSession, adminSession, postJSON } from "../test/helpers";
import type { MockEnv } from "../test/helpers";

interface GroupFixture {
  id: string;
  name: string;
  slug: string;
  purpose: string;
  join_policy: string;
  status: string;
  archived_at: string | null;
  last_post_at: string | null;
  posts_this_week: number;
  my_state: string | null;
  my_role: string | null;
}

const OPEN: GroupFixture = {
  id: "g-open",
  name: "Demo Night Crew",
  slug: "demo-night-crew",
  purpose: "Demos, feedback and Wednesday logistics.",
  join_policy: "open",
  status: "active",
  archived_at: null,
  last_post_at: "2026-10-25T20:00:00Z",
  posts_this_week: 18,
  my_state: null,
  my_role: null,
};

const ASK: GroupFixture = {
  id: "g-ask",
  name: "Forge Talk",
  slug: "forge-talk",
  purpose: "Weekly build talk.",
  join_policy: "request",
  status: "active",
  archived_at: null,
  last_post_at: "2026-10-25T22:00:00Z",
  posts_this_week: 6,
  my_state: null,
  my_role: null,
};

const ARCHIVED: GroupFixture = {
  id: "g-arch",
  name: "Hardware Corner",
  slug: "hardware-corner",
  purpose: "Benches, boards and parts.",
  join_policy: "open",
  status: "archived",
  archived_at: "2026-09-20T00:00:00Z",
  last_post_at: "2026-09-19T10:00:00Z",
  posts_this_week: 0,
  my_state: "active",
  my_role: "member",
};

const QUESTIONS = [
  { id: "q1", prompt: "What are you building right now?", kind: "text", required: 1, position: 0 },
  { id: "q2", prompt: "Do you agree to the group rules?", kind: "yes_no", required: 1, position: 1 },
];

const POSTS = [
  { id: "p1", body: "Shipped the first build.", intent: "progress", created_at: "2026-10-25T21:00:00Z", display_name: "Ada", username: "ada" },
];

function groupsEnv(opts: {
  groups?: GroupFixture[];
  questions?: typeof QUESTIONS;
  posts?: typeof POSTS;
  admins?: string[];
  staff?: boolean;
} = {}) {
  const env = mockEnv();
  const cookie = opts.staff
    ? adminSession(env, "admin-1")
    : memberSession(env, "member-1");
  const prev = env.DB.handler;
  const groups = opts.groups ?? [OPEN, ASK, ARCHIVED];
  env.DB.handler = (sql: string, params: unknown[]) => {
    if (/FROM groups g/i.test(sql) && /WHERE g\.slug/i.test(sql)) {
      const slug = params[1] as string;
      const g = groups.find((x) => x.slug === slug);
      if (!g || (g.status !== "active" && g.status !== "archived"))
        return { row: null };
      return { row: { ...g } };
    }
    if (/FROM groups g/i.test(sql)) return { results: groups.map((g) => ({ ...g })) };
    if (/FROM group_join_questions/i.test(sql)) return { results: opts.questions ?? QUESTIONS };
    if (/FROM feed_posts p JOIN users/i.test(sql)) return { results: opts.posts ?? POSTS };
    if (/FROM group_members/i.test(sql) && /role = 'admin'/i.test(sql))
      return { results: (opts.admins ?? ["member-9"]).map((user_id) => ({ user_id })) };
    if (/FROM notification_kinds/i.test(sql)) return { row: { legacy: 0 } };
    if (/FROM notification_preferences/i.test(sql)) return { row: null };
    return prev?.(sql, params);
  };
  return { env, cookie };
}

const get = (env: MockEnv, cookie: Record<string, string>, path: string) =>
  app.request(path, { method: "GET", headers: { ...cookie } }, env as any);

describe("groups list", () => {
  it("lists active then archived with activity and no member count", async () => {
    const { env, cookie } = groupsEnv();
    const res = await get(env, cookie, "/");
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.groups.map((g: any) => g.slug)).toEqual([
      "demo-night-crew",
      "forge-talk",
      "hardware-corner",
    ]);
    const crew = body.groups[0];
    expect(crew.posts_this_week).toBe(18);
    expect(crew).not.toHaveProperty("member_count");
    expect(crew).not.toHaveProperty("members");
    expect(body.groups[2].status).toBe("archived");
  });

  it("requires sign-in", async () => {
    const { env } = groupsEnv();
    const res = await app.request("/", { method: "GET" }, env as any);
    expect(res.status).toBe(401);
  });
});

describe("group detail", () => {
  it("returns join questions for ask-to-join groups and no posts for non-members", async () => {
    const { env, cookie } = groupsEnv();
    const res = await get(env, cookie, "/forge-talk");
    const body: any = await res.json();
    expect(body.group.slug).toBe("forge-talk");
    expect(body.questions.map((q: any) => q.id)).toEqual(["q1", "q2"]);
    expect(body.posts).toEqual([]);
  });

  it("returns posts for active members and no questions for open groups", async () => {
    const { env, cookie } = groupsEnv();
    const res = await get(env, cookie, "/hardware-corner");
    const body: any = await res.json();
    expect(body.group.status).toBe("archived");
    expect(body.questions).toEqual([]);
    expect(body.posts.map((p: any) => p.id)).toEqual(["p1"]);
  });

  it("404s for a proposed group", async () => {
    const proposed = { ...OPEN, slug: "draft-group", status: "proposed" };
    const { env, cookie } = groupsEnv({ groups: [proposed] });
    const res = await get(env, cookie, "/draft-group");
    expect(res.status).toBe(404);
  });
});

describe("join", () => {
  it("joins an open group at once", async () => {
    const { env, cookie } = groupsEnv();
    const res = await postJSON(app, "/demo-night-crew/join", {}, env, cookie);
    const body = await res.json();
    expect(body).toEqual({ ok: true, state: "active" });
    expect(env.DB.inserts.get("group_members")?.length).toBe(1);
  });

  it("files a request with valid answers and notifies a group admin", async () => {
    const { env, cookie } = groupsEnv();
    const res = await postJSON(
      app,
      "/forge-talk/join",
      { answers: [{ question_id: "q1", answer: "A booking tool." }, { question_id: "q2", answer: "Yes" }] },
      env,
      cookie
    );
    const body = await res.json();
    expect(body).toEqual({ ok: true, state: "requested" });
    expect(env.DB.inserts.get("group_join_answers")?.length).toBe(2);
    expect(env.DB.inserts.get("notification_items")?.length).toBe(1);
  });

  it("rejects a missing required answer and a bad yes/no answer", async () => {
    const { env, cookie } = groupsEnv();
    const missing = await postJSON(
      app,
      "/forge-talk/join",
      { answers: [{ question_id: "q2", answer: "Yes" }] },
      env,
      cookie
    );
    expect(missing.status).toBe(400);
    const bad = await postJSON(
      app,
      "/forge-talk/join",
      { answers: [{ question_id: "q1", answer: "A tool." }, { question_id: "q2", answer: "Maybe" }] },
      env,
      cookie
    );
    expect(bad.status).toBe(400);
  });

  it("refuses invite-only and archived groups", async () => {
    const invite = { ...OPEN, slug: "invite-only", join_policy: "invite" };
    const notMember = { ...ARCHIVED, my_state: null, my_role: null };
    const { env, cookie } = groupsEnv({ groups: [invite, notMember] });
    const inv = await postJSON(app, "/invite-only/join", {}, env, cookie);
    expect(inv.status).toBe(403);
    const arch = await postJSON(app, "/hardware-corner/join", {}, env, cookie);
    expect(arch.status).toBe(400);
  });

  it("is idempotent for active and requested members", async () => {
    const active = { ...OPEN, my_state: "active" };
    const requested = { ...ASK, my_state: "requested" };
    const { env, cookie } = groupsEnv({ groups: [active, requested] });
    const a = await postJSON(app, "/demo-night-crew/join", {}, env, cookie);
    expect((await a.json()).state).toBe("active");
    const r = await postJSON(app, "/forge-talk/join", {}, env, cookie);
    expect((await r.json()).state).toBe("requested");
    expect(env.DB.inserts.get("group_members")).toBeUndefined();
  });
});

describe("reopen", () => {
  it("lets a group admin reopen an archived group", async () => {
    const adminMember = { ...ARCHIVED, my_role: "admin" };
    const { env, cookie } = groupsEnv({ groups: [adminMember] });
    const res = await postJSON(app, "/hardware-corner/reopen", {}, env, cookie);
    expect((await res.json()).state).toBe("active");
    expect(
      env.DB.calls.some((c) => /UPDATE groups SET status = 'active'/i.test(c.sql))
    ).toBe(true);
  });

  it("lets staff reopen and refuses plain members and active groups", async () => {
    const { env, cookie } = groupsEnv({ groups: [ARCHIVED], staff: true });
    const staff = await postJSON(app, "/hardware-corner/reopen", {}, env, cookie);
    expect(staff.status).toBe(200);
    const { env: env2, cookie: cookie2 } = groupsEnv({ groups: [ARCHIVED] });
    const member = await postJSON(app, "/hardware-corner/reopen", {}, env2, cookie2);
    expect(member.status).toBe(403);
    const { env: env3, cookie: cookie3 } = groupsEnv({ groups: [OPEN] });
    const active = await postJSON(app, "/demo-night-crew/reopen", {}, env3, cookie3);
    expect(active.status).toBe(400);
  });
});
