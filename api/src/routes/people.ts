/* Member directory (deck section 23 people screen).
 *
 * Mounted at "/api/people". Every route is behind requireUser
 * (members only); a signed-out visitor gets 401, never a partial list.
 *
 * Deck rules, element by element:
 *   - Only members who choose to be listed appear: member_profiles
 *     directory_opt_in = 1, and only active accounts. The caller never
 *     appears in their own directory (their profile lives at
 *     /members/profile); the prototype excludes the signed-in member too.
 *   - Sorted by name, no ranking, never a member count on a card.
 *   - Cards show Building (the member's project), Can help with,
 *     Looking for, and skill badges, plus a Message action that opens
 *     the 1:1 DM through the shared messageMember helper.
 *   - Badges come from user_effective_roles (0024), not users.role:
 *     users.role only ever holds admin or member, while moderator and
 *     editor live in user_roles. Admin shows Staff, moderator shows
 *     Moderator, everyone else shows no badge.
 *   - Skill chips filter by the curated skill_tags list; an unknown
 *     slug is a 400, never a silent empty list.
 *   - Search matches display name, the builder fields, and skill
 *     labels only. It never matches the real name column, so the
 *     directory cannot be used as an oracle for a member's real name.
 *   - Neither side of a block appears: block_pairs is the both-ways
 *     view from 0025, so one NOT EXISTS covers both directions.
 *   - Per-field visibility is honoured server-side: a field a member
 *     set to only-me is omitted from their card and cannot match a
 *     search, exactly as the profile views filter it.
 *
 * Not in this slice: the chat picker at /api/chat/people stays as it
 * is. It serves starting a chat (any active member, name search,
 * 20 rows) while this route serves the opt-in directory with builder
 * fields and skills. The hub search page renders a People section
 * from this route for signed-in visitors.
 *
 * No email or real name ever leaves this route. display_name falls
 * back to initials, the same fallback the profile views use.
 */
import { Hono } from "hono";
import { requireUser, type Session } from "../lib/auth";
import type { Bindings } from "../index";
import { cleanStr } from "../lib/validate";
import {
  avatarUrlOf,
  fieldVisible,
  initialsFor,
  loadVisibility,
  type VisibilityLevel,
} from "./profiles";

const app = new Hono<{ Bindings: Bindings; Variables: { user: Session } }>();

app.use(requireUser);

const DIRECTORY_LIMIT = 100;

interface DirectoryRow {
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

interface SkillRow {
  user_id: string;
  slug: string;
  label: string;
}

interface PersonCard {
  id: string;
  username: string | null;
  display_name: string;
  profile_url: string;
  avatar_url: string | null;
  badge: string | null;
  building_now?: string;
  can_help_with?: string;
  looking_for?: string;
  skills?: { slug: string; label: string }[];
}

/** Staff and moderator badges, the only roles the deck names on a card. */
function badgeFor(row: DirectoryRow): string | null {
  if (row.is_admin) return "Staff";
  if (row.is_moderator) return "Moderator";
  return null;
}

/** Shape one directory row, hiding every only-me field for this viewer. */
function personCard(
  row: DirectoryRow,
  skills: { slug: string; label: string }[],
  vis: Record<string, VisibilityLevel>,
): PersonCard {
  const card: PersonCard = {
    id: row.id,
    username: row.username || null,
    display_name: row.display_name || initialsFor(row.name || ""),
    profile_url: row.username ? `/@${row.username}` : `/u/${row.id}`,
    avatar_url: fieldVisible("avatar", vis, "member")
      ? avatarUrlOf(row)
      : null,
    badge: badgeFor(row),
  };
  if (fieldVisible("building_now", vis, "member")) {
    card.building_now = row.building_now || "";
  }
  if (fieldVisible("can_help_with", vis, "member")) {
    card.can_help_with = row.can_help_with || "";
  }
  if (fieldVisible("looking_for", vis, "member")) {
    card.looking_for = row.looking_for || "";
  }
  if (fieldVisible("skills", vis, "member")) card.skills = skills;
  return card;
}

app.get("/", async (c) => {
  const { DB } = c.env;
  const viewerId = c.get("user").userId as string;
  const skill = cleanStr(c.req.query("skill"), 60);
  const q = cleanStr(c.req.query("q"), 100).toLowerCase();

  if (skill) {
    const known = await DB.prepare(
      "SELECT slug FROM skill_tags WHERE slug = ?",
    )
      .bind(skill)
      .first()
      .catch(() => null);
    if (!known) {
      return c.json({ ok: false, error: "Unknown skill." }, 400);
    }
  }

  const rows = (
    await DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.name,
              EXISTS (SELECT 1 FROM user_effective_roles er
                      WHERE er.user_id = u.id AND er.role = 'admin') AS is_admin,
              EXISTS (SELECT 1 FROM user_effective_roles er
                      WHERE er.user_id = u.id AND er.role = 'moderator') AS is_moderator,
              u.avatar_key, u.avatar_r2_key,
              mp.building_now, mp.can_help_with, mp.looking_for
       FROM users u JOIN member_profiles mp ON mp.user_id = u.id
       WHERE mp.directory_opt_in = 1 AND u.status = 'active' AND u.id != ?
         AND NOT EXISTS (SELECT 1 FROM block_pairs WHERE a = ? AND b = u.id)
       ORDER BY u.display_name COLLATE NOCASE, u.id
       LIMIT ${DIRECTORY_LIMIT}`,
    )
      .bind(viewerId, viewerId)
      .all()
  ).results as unknown as DirectoryRow[];

  const ids = rows.map((r) => r.id);
  const skillsByUser = new Map<string, { slug: string; label: string }[]>();
  if (ids.length) {
    const marks = ids.map(() => "?").join(", ");
    const skillRows = (
      await DB.prepare(
        `SELECT ms.user_id, ms.skill_slug AS slug, st.label AS label
         FROM member_skills ms JOIN skill_tags st ON st.slug = ms.skill_slug
         WHERE ms.user_id IN (${marks}) ORDER BY st.label`,
      )
        .bind(...ids)
        .all()
    ).results as unknown as SkillRow[];
    for (const s of skillRows || []) {
      const list = skillsByUser.get(s.user_id) || [];
      list.push({ slug: s.slug, label: s.label || s.slug });
      skillsByUser.set(s.user_id, list);
    }
  }

  let people: PersonCard[] = [];
  for (const row of rows) {
    const vis = await loadVisibility(DB, row.id);
    people.push(
      personCard(row, skillsByUser.get(row.id) || [], vis),
    );
  }

  if (skill) {
    people = people.filter((p) =>
      (p.skills || []).some((s) => s.slug === skill),
    );
  }
  if (q) {
    people = people.filter((p) => {
      const hay = [
        p.display_name,
        p.building_now || "",
        p.can_help_with || "",
        p.looking_for || "",
        ...(p.skills || []).map((s) => s.label),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  people.sort((a, b) =>
    a.display_name.localeCompare(b.display_name, "en-CA") ||
    a.id.localeCompare(b.id),
  );
  return c.json({ ok: true, people });
});

export default app;
