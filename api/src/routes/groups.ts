/* Member groups (deck section 20 groups screen).
 *
 * Mounted at "/api/groups". Every route is behind requireUser
 * (members only); a non-member gets 404 for a group they cannot see,
 * never a leak about whether a proposed or rejected group exists.
 *
 * Deck rules, element by element:
 *   - Group cards show recent activity, never a member count.
 *   - Join policy is Open, Ask to join or Invite only
 *     (groups.join_policy). Open joins at once; Ask to join files a
 *     request with the group's join answers and waits for a group
 *     admin; Invite only cannot be joined from this screen.
 *   - A group has up to 5 join questions, text or yes/no
 *     (group_join_questions); required questions must be answered.
 *   - Quiet groups archive after 30 days and keep their posts; a
 *     group admin or staff can reopen one.
 *   - Group posts stay visible only to active group members.
 *
 * Proposing a new group (Phase 5 cycle 41, the recorded Phase 3
 * follow-up): any member proposes a group (name, purpose, join policy,
 * optional address slug); the proposer is co-founder one. Two more
 * distinct members endorse the proposal, then staff approve it and the
 * co-founders become the group (proposer as group admin, endorsers as
 * members). Staff can also reject a proposal. A proposed or rejected
 * group never appears in the group list or detail: proposal endpoints
 * below are the only way to see one, and only its proposer, its
 * supporters, or staff can see it. No member ids are exposed: cards
 * carry only the supporter count and the caller's own flags, so the
 * anonymity rule (share the what, never the who) holds here too.
 * Mutating routes are covered by the global CSRF guard.
 */
import { Hono } from "hono";
import { requireUser, type Session } from "../lib/auth";
import type { Bindings } from "../index";
import { cleanStr, isRecord } from "../lib/validate";
import { emitNotification } from "./notifications";

const app = new Hono<{ Bindings: Bindings; Variables: { user: Session } }>();

app.use(requireUser);

const GROUP_LIMIT = 100;
const POST_LIMIT = 20;

/** Co-founders needed before staff can approve a proposal. */
const COFOUNDERS_REQUIRED = 3;
const JOIN_POLICIES = ["open", "request", "invite"];
const SLUG_RE = /^[a-z0-9-]{3,40}$/;

/** Address slug from a group name: lowercase, dashes, nothing else. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface ProposalRow {
  id: string;
  name: string;
  slug: string;
  purpose: string;
  join_policy: string;
  status: string;
  proposed_by: string | null;
  created_at: string;
}

interface ProposalCard {
  id: string;
  name: string;
  slug: string;
  purpose: string;
  join_policy: string;
  status: string;
  supporters: number;
  ready: boolean;
  is_proposer: boolean;
  is_supporter: boolean;
}

function proposalCard(
  p: ProposalRow,
  supporterIds: string[],
  userId: string
): ProposalCard {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    purpose: p.purpose,
    join_policy: p.join_policy,
    status: p.status,
    supporters: supporterIds.length,
    ready: supporterIds.length >= COFOUNDERS_REQUIRED,
    is_proposer: p.proposed_by === userId,
    is_supporter: supporterIds.includes(userId),
  };
}

async function proposalSupporters(
  DB: D1Database,
  groupId: string
): Promise<string[]> {
  const rows = await DB.prepare(
    `SELECT user_id FROM group_proposal_supporters WHERE group_id = ? ORDER BY created_at`
  )
    .bind(groupId)
    .all();
  return ((rows.results as { user_id: string }[]) || []).map((r) => r.user_id);
}

/** A proposed group row by slug, or null when it is not proposed. */
async function findProposal(
  DB: D1Database,
  slug: string
): Promise<ProposalRow | null> {
  return (await DB.prepare(
    `SELECT id, name, slug, purpose, join_policy, status, proposed_by, created_at
     FROM groups WHERE slug = ? AND status = 'proposed'`
  )
    .bind(slug)
    .first()) as ProposalRow | null;
}

interface GroupRow {
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

function groupCard(g: GroupRow, isStaff: boolean) {
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    purpose: g.purpose,
    join_policy: g.join_policy,
    status: g.status,
    archived_at: g.archived_at,
    last_post_at: g.last_post_at,
    posts_this_week: g.posts_this_week,
    my_state: g.my_state,
    my_role: g.my_role,
    can_reopen:
      g.status === "archived" && (g.my_role === "admin" || isStaff),
  };
}

/** Active or archived group row with the caller's membership, or null. */
async function findGroup(
  DB: D1Database,
  slug: string,
  userId: string
): Promise<GroupRow | null> {
  return (await DB.prepare(
    `SELECT g.id, g.name, g.slug, g.purpose, g.join_policy, g.status,
            g.archived_at, g.last_post_at,
            (SELECT COUNT(*) FROM feed_posts p
             WHERE p.group_id = g.id AND p.status = 'published'
             AND p.created_at >= datetime('now', '-7 days')) AS posts_this_week,
            gm.state AS my_state, gm.role AS my_role
     FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
     WHERE g.slug = ? AND g.status IN ('active', 'archived')`
  )
    .bind(userId, slug)
    .first()) as GroupRow | null;
}

/* --- Proposals: list what the caller may see --- *
 * Staff see every proposed group; a member sees only proposals they
 * proposed or endorsed. Anyone else gets an empty list, never a leak.
 * Registered before "/:slug" so "proposals" is not read as a slug. */
app.get("/proposals", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const isStaff = user.role === "admin";
  const rows = await DB.prepare(
    `SELECT id, name, slug, purpose, join_policy, status, proposed_by, created_at
     FROM groups WHERE status = 'proposed' ORDER BY created_at ASC LIMIT ?`
  )
    .bind(GROUP_LIMIT)
    .all();
  const proposals: ProposalCard[] = [];
  for (const p of ((rows.results as unknown) as ProposalRow[]) || []) {
    const supporters = await proposalSupporters(DB, p.id);
    const card = proposalCard(p, supporters, user.userId);
    if (isStaff || card.is_proposer || card.is_supporter) proposals.push(card);
  }
  return c.json({ ok: true, proposals });
});

/* --- Member: propose a new group; the proposer is co-founder one --- */
app.post("/proposals", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const data: unknown = await c.req.json().catch(() => null);
  if (!isRecord(data))
    return c.json({ ok: false, error: "Send a name and a purpose." }, 400);
  const name = cleanStr(data.name, 60);
  const purpose = cleanStr(data.purpose, 200);
  const joinPolicy =
    typeof data.join_policy === "string" ? data.join_policy : "open";
  if (name.length < 2 || name.length > 60)
    return c.json(
      { ok: false, error: "Give the group a name of 2 to 60 characters." },
      400
    );
  if (purpose.length < 10 || purpose.length > 200)
    return c.json(
      { ok: false, error: "Describe the purpose in 10 to 200 characters." },
      400
    );
  if (!JOIN_POLICIES.includes(joinPolicy))
    return c.json(
      { ok: false, error: "Join policy must be open, request, or invite." },
      400
    );
  const slug =
    typeof data.slug === "string" && data.slug.trim()
      ? data.slug.trim().toLowerCase()
      : slugify(name);
  if (!SLUG_RE.test(slug))
    return c.json(
      {
        ok: false,
        error:
          "Pick an address of 3 to 40 lowercase letters, numbers, or dashes.",
      },
      400
    );
  const taken = await DB.prepare(`SELECT id FROM groups WHERE slug = ?`)
    .bind(slug)
    .first();
  if (taken)
    return c.json(
      { ok: false, error: "That group address is already taken." },
      409
    );
  const id = crypto.randomUUID();
  await DB.batch([
    DB.prepare(
      `INSERT INTO groups (id, slug, name, purpose, join_policy, status, proposed_by)
       VALUES (?, ?, ?, ?, ?, 'proposed', ?)`
    ).bind(id, slug, name, purpose, joinPolicy, user.userId),
    DB.prepare(
      `INSERT INTO group_proposal_supporters (group_id, user_id) VALUES (?, ?)`
    ).bind(id, user.userId),
  ]);
  const row: ProposalRow = {
    id,
    name,
    slug,
    purpose,
    join_policy: joinPolicy,
    status: "proposed",
    proposed_by: user.userId,
    created_at: "",
  };
  return c.json(
    { ok: true, proposal: proposalCard(row, [user.userId], user.userId) },
    201
  );
});

/* --- Proposal detail: proposer, supporters, or staff only --- */
app.get("/proposals/:slug", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const slug = (c.req.param("slug") || "").slice(0, 40);
  const p = await findProposal(DB, slug);
  if (!p) return c.json({ ok: false, error: "Not found." }, 404);
  const supporters = await proposalSupporters(DB, p.id);
  const card = proposalCard(p, supporters, user.userId);
  if (user.role !== "admin" && !card.is_proposer && !card.is_supporter)
    return c.json({ ok: false, error: "Not found." }, 404);
  return c.json({ ok: true, proposal: card });
});

/* --- Member: endorse a proposal, becoming a co-founder --- *
 * Any signed-in member may endorse: the two co-founders beyond the
 * proposer are not participants yet, so no participant check applies.
 * Endorsing twice is a no-op, never a second count. */
app.post("/proposals/:slug/endorse", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const slug = (c.req.param("slug") || "").slice(0, 40);
  const p = await findProposal(DB, slug);
  if (!p) return c.json({ ok: false, error: "Not found." }, 404);
  let supporters = await proposalSupporters(DB, p.id);
  if (!supporters.includes(user.userId)) {
    await DB.prepare(
      `INSERT INTO group_proposal_supporters (group_id, user_id) VALUES (?, ?)`
    )
      .bind(p.id, user.userId)
      .run();
    supporters = await proposalSupporters(DB, p.id);
  }
  return c.json({
    ok: true,
    proposal: proposalCard(p, supporters, user.userId),
  });
});

/* --- Staff: approve a ready proposal; co-founders become the group --- */
app.post("/proposals/:slug/approve", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  if (user.role !== "admin")
    return c.json(
      { ok: false, error: "Only staff can approve a group proposal." },
      403
    );
  const slug = (c.req.param("slug") || "").slice(0, 40);
  const p = await findProposal(DB, slug);
  if (!p) return c.json({ ok: false, error: "Not found." }, 404);
  const supporters = await proposalSupporters(DB, p.id);
  if (supporters.length < COFOUNDERS_REQUIRED)
    return c.json(
      {
        ok: false,
        error: `A group needs ${COFOUNDERS_REQUIRED} co-founders before approval.`,
      },
      400
    );
  const stmts: D1PreparedStatement[] = [
    DB.prepare(
      `UPDATE groups SET status = 'active', approved_by = ?,
       approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(user.userId, p.id),
  ];
  for (const supporterId of supporters) {
    stmts.push(
      DB.prepare(
        `INSERT INTO group_members (group_id, user_id, role, state)
         VALUES (?, ?, ?, 'active')`
      ).bind(
        p.id,
        supporterId,
        supporterId === p.proposed_by ? "admin" : "member"
      )
    );
  }
  await DB.batch(stmts);
  return c.json({ ok: true, status: "active", slug: p.slug });
});

/* --- Staff: reject a proposal; its address stays reserved --- */
app.post("/proposals/:slug/reject", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  if (user.role !== "admin")
    return c.json(
      { ok: false, error: "Only staff can reject a group proposal." },
      403
    );
  const slug = (c.req.param("slug") || "").slice(0, 40);
  const p = await findProposal(DB, slug);
  if (!p) return c.json({ ok: false, error: "Not found." }, 404);
  await DB.prepare(`UPDATE groups SET status = 'rejected' WHERE id = ?`)
    .bind(p.id)
    .run();
  return c.json({ ok: true, status: "rejected", slug: p.slug });
});

/* --- Member: list groups, active first, archived last --- */

app.get("/", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const rows = await DB.prepare(
    `SELECT g.id, g.name, g.slug, g.purpose, g.join_policy, g.status,
            g.archived_at, g.last_post_at,
            (SELECT COUNT(*) FROM feed_posts p
             WHERE p.group_id = g.id AND p.status = 'published'
             AND p.created_at >= datetime('now', '-7 days')) AS posts_this_week,
            gm.state AS my_state, gm.role AS my_role
     FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
     WHERE g.status IN ('active', 'archived')
     ORDER BY (g.status = 'archived'), g.last_post_at DESC, g.name
     LIMIT ?`
  )
    .bind(user.userId, GROUP_LIMIT)
    .all();
  const isStaff = user.role === "admin";
  return c.json({
    ok: true,
    groups: (((rows.results as unknown) as GroupRow[]) || []).map((g) =>
      groupCard(g, isStaff)
    ),
  });
});

/* --- Member: one group, its join questions, and its recent posts --- */

app.get("/:slug", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const slug = (c.req.param("slug") || "").slice(0, 40);
  const g = await findGroup(DB, slug, user.userId);
  if (!g) return c.json({ ok: false, error: "Not found." }, 404);
  const isStaff = user.role === "admin";
  let questions: {
    id: string;
    prompt: string;
    kind: string;
    required: number;
    position: number;
  }[] = [];
  if (g.join_policy === "request") {
    const q = await DB.prepare(
      `SELECT id, prompt, kind, required, position
       FROM group_join_questions WHERE group_id = ? ORDER BY position`
    )
      .bind(g.id)
      .all();
    questions = (q.results as typeof questions) || [];
  }
  let posts: {
    id: string;
    body: string;
    intent: string;
    created_at: string;
    display_name: string | null;
    username: string | null;
  }[] = [];
  if (g.my_state === "active") {
    const p = await DB.prepare(
      `SELECT p.id, p.body, p.intent, p.created_at,
              u.display_name, u.username
       FROM feed_posts p JOIN users u ON u.id = p.author_id
       WHERE p.group_id = ? AND p.status = 'published' AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC LIMIT ?`
    )
      .bind(g.id, POST_LIMIT)
      .all();
    posts = (p.results as typeof posts) || [];
  }
  return c.json({ ok: true, group: groupCard(g, isStaff), questions, posts });
});

/* --- Member: join a group, or file a join request --- */

app.post("/:slug/join", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const slug = (c.req.param("slug") || "").slice(0, 40);
  const g = await findGroup(DB, slug, user.userId);
  if (!g) return c.json({ ok: false, error: "Not found." }, 404);
  if (g.my_state === "active")
    return c.json({ ok: true, state: "active" });
  if (g.my_state === "requested")
    return c.json({ ok: true, state: "requested" });
  if (g.my_state === "removed")
    return c.json(
      { ok: false, error: "You cannot rejoin this group." },
      403
    );
  if (g.status === "archived")
    return c.json(
      { ok: false, error: "This group is archived. A group admin or staff can reopen it." },
      400
    );
  if (g.join_policy === "invite")
    return c.json(
      { ok: false, error: "This group is invite only." },
      403
    );

  const upsert = (state: string) =>
    DB.prepare(
      `INSERT INTO group_members (group_id, user_id, role, state)
       VALUES (?, ?, 'member', ?)
       ON CONFLICT(group_id, user_id) DO UPDATE SET state = excluded.state`
    )
      .bind(g.id, user.userId, state);

  if (g.join_policy === "open") {
    await upsert("active").run();
    return c.json({ ok: true, state: "active" });
  }

  // Ask to join: validate the answers, then file request plus answers.
  const data: unknown = await c.req.json().catch(() => null);
  if (!isRecord(data) || !Array.isArray(data.answers))
    return c.json(
      { ok: false, error: "Answer the join questions to request to join." },
      400
    );
  const questions = await DB.prepare(
    `SELECT id, prompt, kind, required FROM group_join_questions
     WHERE group_id = ? ORDER BY position`
  )
    .bind(g.id)
    .all();
  const qs = (questions.results as {
    id: string;
    prompt: string;
    kind: string;
    required: number;
  }[]) || [];
  const byId = new Map<string, string>();
  for (const a of data.answers as unknown[]) {
    if (!isRecord(a) || typeof a.question_id !== "string") continue;
    byId.set(
      a.question_id,
      typeof a.answer === "string" ? a.answer : ""
    );
  }
  for (const q of qs) {
    const answer = (byId.get(q.id) || "").trim();
    if (q.required === 1 && !answer)
      return c.json(
        { ok: false, error: `Answer this question: ${q.prompt}` },
        400
      );
    if (answer && q.kind === "yes_no" && answer !== "Yes" && answer !== "No")
      return c.json(
        { ok: false, error: `Answer Yes or No: ${q.prompt}` },
        400
      );
    if (answer.length > 500)
      return c.json(
        { ok: false, error: `Keep it under 500 characters: ${q.prompt}` },
        400
      );
  }
  for (const id of byId.keys()) {
    if (!qs.some((q) => q.id === id))
      return c.json(
        { ok: false, error: "One of the answers names an unknown question." },
        400
      );
  }
  const stmts: D1PreparedStatement[] = [upsert("requested")];
  for (const q of qs) {
    const answer = (byId.get(q.id) || "").trim();
    if (!answer) continue;
    stmts.push(
      DB.prepare(
        `INSERT INTO group_join_answers (group_id, user_id, question_id, answer)
         VALUES (?, ?, ?, ?)`
      ).bind(g.id, user.userId, q.id, cleanStr(answer, 500))
    );
  }
  await DB.batch(stmts);
  const admins = await DB.prepare(
    `SELECT user_id FROM group_members
     WHERE group_id = ? AND role = 'admin' AND state = 'active'`
  )
    .bind(g.id)
    .all();
  for (const row of (admins.results as { user_id: string }[]) || []) {
    await emitNotification(DB, {
      userId: row.user_id,
      kind: "group_join_request",
      actorId: user.userId,
      targetType: "group",
      targetId: g.id,
      preview: `A member asked to join ${g.name}.`,
    });
  }
  return c.json({ ok: true, state: "requested" });
});

/* --- Group admin or staff: reopen an archived group --- */

app.post("/:slug/reopen", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const slug = (c.req.param("slug") || "").slice(0, 40);
  const g = await findGroup(DB, slug, user.userId);
  if (!g) return c.json({ ok: false, error: "Not found." }, 404);
  if (g.status !== "archived")
    return c.json(
      { ok: false, error: "Only an archived group can be reopened." },
      400
    );
  if (g.my_role !== "admin" && user.role !== "admin")
    return c.json(
      { ok: false, error: "Only a group admin or staff can reopen this group." },
      403
    );
  await DB.prepare(
    `UPDATE groups SET status = 'active', archived_at = NULL WHERE id = ?`
  )
    .bind(g.id)
    .run();
  return c.json({ ok: true, state: "active" });
});

export default app;
