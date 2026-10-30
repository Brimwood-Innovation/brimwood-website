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

/* --- Group proposals: three co-founders plus admin approval --- *
 * A shared store lets several member and staff envs act on the same
 * proposal, the way real members would: propose, endorse, approve. */
interface ProposalSeed {
  id: string;
  name: string;
  slug: string;
  purpose: string;
  join_policy: string;
  status: string;
  proposed_by: string;
  created_at: string;
}

interface ProposalStore {
  proposals: Map<string, ProposalSeed>;
  supporters: Map<string, string[]>;
}

function newProposalStore(): ProposalStore {
  const proposals = new Map<string, ProposalSeed>();
  const supporters = new Map<string, string[]>();
  proposals.set("new-builders", {
    id: "prop-1",
    name: "New Builders",
    slug: "new-builders",
    purpose: "A group for people starting their first build.",
    join_policy: "open",
    status: "proposed",
    proposed_by: "member-1",
    created_at: "2026-10-29T00:00:00Z",
  });
  supporters.set("prop-1", ["member-1"]);
  proposals.set("quiet-craft", {
    id: "prop-2",
    name: "Quiet Craft",
    slug: "quiet-craft",
    purpose: "Slow, careful work shared once a week.",
    join_policy: "request",
    status: "proposed",
    proposed_by: "member-9",
    created_at: "2026-10-29T01:00:00Z",
  });
  supporters.set("prop-2", ["member-9"]);
  return { proposals, supporters };
}

function proposalEnv(
  store: ProposalStore,
  user: { kind: "member" | "admin"; id: string }
) {
  const env = mockEnv();
  const cookie =
    user.kind === "admin"
      ? adminSession(env, user.id)
      : memberSession(env, user.id);
  const prev = env.DB.handler;
  env.DB.handler = (sql: string, params: unknown[]) => {
    if (/INSERT INTO groups/i.test(sql)) {
      const [id, slug, name, purpose, joinPolicy, proposedBy] = params as string[];
      store.proposals.set(slug, {
        id,
        name,
        slug,
        purpose,
        join_policy: joinPolicy,
        status: "proposed",
        proposed_by: proposedBy,
        created_at: "2026-10-30T00:00:00Z",
      });
      return;
    }
    if (/INSERT INTO group_proposal_supporters/i.test(sql)) {
      const [groupId, userId] = params as string[];
      const list = store.supporters.get(groupId) ?? [];
      if (!list.includes(userId)) list.push(userId);
      store.supporters.set(groupId, list);
      return;
    }
    if (/UPDATE groups SET status = 'active'/i.test(sql)) {
      const groupId = params[1] as string;
      for (const p of store.proposals.values())
        if (p.id === groupId) p.status = "active";
      return;
    }
    if (/UPDATE groups SET status = 'rejected'/i.test(sql)) {
      const groupId = params[0] as string;
      for (const p of store.proposals.values())
        if (p.id === groupId) p.status = "rejected";
      return;
    }
    if (/FROM group_proposal_supporters/i.test(sql)) {
      return {
        results: (store.supporters.get(params[0] as string) ?? []).map(
          (user_id) => ({ user_id })
        ),
      };
    }
    if (/SELECT id FROM groups WHERE slug/i.test(sql)) {
      const p = store.proposals.get(params[0] as string);
      return { row: p ? { id: p.id } : null };
    }
    if (/FROM groups WHERE slug/i.test(sql)) {
      const p = store.proposals.get(params[0] as string);
      if (!p || p.status !== "proposed") return { row: null };
      return { row: { ...p } };
    }
    if (/FROM groups WHERE status = 'proposed'/i.test(sql)) {
      return {
        results: [...store.proposals.values()]
          .filter((p) => p.status === "proposed")
          .map((p) => ({ ...p })),
      };
    }
    return prev?.(sql, params);
  };
  return { env, cookie };
}

describe("group proposals", () => {
  it("creates a proposal with the proposer as co-founder one", async () => {
    const store = newProposalStore();
    const { env, cookie } = proposalEnv(store, { kind: "member", id: "member-1" });
    const res = await postJSON(
      app,
      "/proposals",
      { name: "Night Owls Club", purpose: "People building late at night together." },
      env,
      cookie
    );
    const body: any = await res.json();
    expect(res.status).toBe(201);
    expect(body.proposal.slug).toBe("night-owls-club");
    expect(body.proposal.supporters).toBe(1);
    expect(body.proposal.ready).toBe(false);
    expect(body.proposal.is_proposer).toBe(true);
    expect(env.DB.inserts.get("groups")?.[0]).toMatchObject({
      status: "proposed",
      proposed_by: "member-1",
    });
    expect(env.DB.inserts.get("group_proposal_supporters")?.length).toBe(1);
  });

  it("rejects a short purpose, a bad slug, and a taken slug", async () => {
    const store = newProposalStore();
    const { env, cookie } = proposalEnv(store, { kind: "member", id: "member-1" });
    const short = await postJSON(app, "/proposals", { name: "Owls", purpose: "Short." }, env, cookie);
    expect(short.status).toBe(400);
    const badSlug = await postJSON(
      app,
      "/proposals",
      { name: "Owls Club", purpose: "People building late at night together.", slug: "Bad Slug!" },
      env,
      cookie
    );
    expect(badSlug.status).toBe(400);
    const taken = await postJSON(
      app,
      "/proposals",
      { name: "Other", purpose: "People building late at night together.", slug: "new-builders" },
      env,
      cookie
    );
    expect(taken.status).toBe(409);
  });

  it("lists only own proposals for members and all for staff", async () => {
    const store = newProposalStore();
    const member = proposalEnv(store, { kind: "member", id: "member-1" });
    const mine = await get(member.env, member.cookie, "/proposals");
    const mineBody: any = await mine.json();
    expect(mineBody.proposals.map((p: any) => p.slug)).toEqual(["new-builders"]);
    const staff = proposalEnv(store, { kind: "admin", id: "admin-1" });
    const all = await get(staff.env, staff.cookie, "/proposals");
    const allBody: any = await all.json();
    expect(allBody.proposals.map((p: any) => p.slug)).toEqual([
      "new-builders",
      "quiet-craft",
    ]);
  });

  it("endorses to three co-founders and ignores a repeat endorsement", async () => {
    const store = newProposalStore();
    const second = proposalEnv(store, { kind: "member", id: "member-2" });
    const two = await postJSON(app, "/proposals/new-builders/endorse", {}, second.env, second.cookie);
    const twoBody: any = await two.json();
    expect(twoBody.proposal.supporters).toBe(2);
    expect(twoBody.proposal.ready).toBe(false);
    const third = proposalEnv(store, { kind: "member", id: "member-3" });
    const three = await postJSON(app, "/proposals/new-builders/endorse", {}, third.env, third.cookie);
    const body: any = await three.json();
    expect(body.proposal.supporters).toBe(3);
    expect(body.proposal.ready).toBe(true);
    const again = await postJSON(app, "/proposals/new-builders/endorse", {}, third.env, third.cookie);
    expect((await again.json()).proposal.supporters).toBe(3);
    expect(third.env.DB.inserts.get("group_proposal_supporters")?.length).toBe(1);
  });

  it("hides a proposal from strangers but shows it to staff", async () => {
    const store = newProposalStore();
    const stranger = proposalEnv(store, { kind: "member", id: "member-7" });
    const hidden = await get(stranger.env, stranger.cookie, "/proposals/new-builders");
    expect(hidden.status).toBe(404);
    const staff = proposalEnv(store, { kind: "admin", id: "admin-1" });
    const seen = await get(staff.env, staff.cookie, "/proposals/new-builders");
    expect(seen.status).toBe(200);
    const seenBody: any = await seen.json();
    expect(seenBody.proposal.supporters).toBe(1);
  });

  it("approves only a ready proposal and seats the co-founders", async () => {
    const store = newProposalStore();
    const staff = proposalEnv(store, { kind: "admin", id: "admin-1" });
    const early = await postJSON(app, "/proposals/new-builders/approve", {}, staff.env, staff.cookie);
    expect(early.status).toBe(400);
    const second = proposalEnv(store, { kind: "member", id: "member-2" });
    await postJSON(app, "/proposals/new-builders/endorse", {}, second.env, second.cookie);
    const third = proposalEnv(store, { kind: "member", id: "member-3" });
    await postJSON(app, "/proposals/new-builders/endorse", {}, third.env, third.cookie);
    const member = proposalEnv(store, { kind: "member", id: "member-1" });
    const denied = await postJSON(app, "/proposals/new-builders/approve", {}, member.env, member.cookie);
    expect(denied.status).toBe(403);
    const approved = await postJSON(app, "/proposals/new-builders/approve", {}, staff.env, staff.cookie);
    expect((await approved.json()).status).toBe("active");
    expect(staff.env.DB.inserts.get("group_members")?.length).toBe(3);
    expect(staff.env.DB.inserts.get("group_members")).toContainEqual(
      expect.objectContaining({ group_id: "prop-1", user_id: "member-1", role: "admin", state: "active" })
    );
    expect(staff.env.DB.inserts.get("group_members")).toContainEqual(
      expect.objectContaining({ group_id: "prop-1", user_id: "member-2", role: "member", state: "active" })
    );
  });

  it("rejects on staff decision and then hides the proposal", async () => {
    const store = newProposalStore();
    const staff = proposalEnv(store, { kind: "admin", id: "admin-1" });
    const rejected = await postJSON(app, "/proposals/quiet-craft/reject", {}, staff.env, staff.cookie);
    expect((await rejected.json()).status).toBe("rejected");
    const gone = await get(staff.env, staff.cookie, "/proposals/quiet-craft");
    expect(gone.status).toBe(404);
  });
});
