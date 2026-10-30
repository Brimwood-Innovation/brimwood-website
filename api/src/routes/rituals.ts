/* Member rituals read API (Phase 5 cycle 42, the recorded Phase 3
 * follow-up: the hub home card had no read API, so it showed a fixed
 * rhythm instead of the live rituals).
 *
 * Mounted at "/api/rituals". Every route is behind requireUser
 * (members only); a signed-out visitor gets 401.
 *
 * Visibility, matching the feed and group leak rules:
 *   - Only active rituals are listed. Inactive rituals are staff
 *     drafts and never reach members through this endpoint.
 *   - A ritual with no group is members-wide: every member sees it.
 *   - A ritual tied to a group is visible only to active members of
 *     that group, plus staff. A ritual tied to a proposed, rejected,
 *     or archived group is hidden from everyone here: the group list
 *     and proposal endpoints are the only places those groups appear.
 *   - No member ids are exposed: cards carry the title, weekday,
 *     local time, zone, and the group name and slug only. The
 *     body_template is not returned: it is the staff copy the cron
 *     mints into a feed post at run time, and members see it when
 *     the run publishes.
 * Rituals are ordered Monday first, then by local time, then title.
 */
import { Hono } from "hono";
import { requireUser, type Session } from "../lib/auth";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings; Variables: { user: Session } }>();

app.use(requireUser);

const RITUAL_LIMIT = 100;

interface RitualRow {
  id: string;
  title: string;
  weekday: number;
  local_time: string;
  tz: string;
  group_slug: string | null;
  group_name: string | null;
}

/** Public ritual card: schedule facts only, never a member id. */
function ritualCard(r: RitualRow) {
  return {
    id: r.id,
    title: r.title,
    weekday: r.weekday,
    local_time: r.local_time,
    tz: r.tz,
    group:
      r.group_slug && r.group_name
        ? { slug: r.group_slug, name: r.group_name }
        : null,
  };
}

/* --- Member: list the rituals the caller may see --- */
app.get("/", async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const isStaff = user.role === "admin" ? 1 : 0;
  const rows = await DB.prepare(
    `SELECT r.id, r.title, r.weekday, r.local_time, r.tz,
            g.slug AS group_slug, g.name AS group_name
     FROM rituals r
     LEFT JOIN groups g ON g.id = r.group_id
     WHERE r.active = 1
       AND (r.group_id IS NULL OR g.status = 'active')
       AND (r.group_id IS NULL
            OR EXISTS (SELECT 1 FROM group_members gm
                       WHERE gm.group_id = r.group_id
                         AND gm.user_id = ? AND gm.state = 'active')
            OR ? = 1)
     ORDER BY ((r.weekday + 6) % 7), r.local_time, r.title
     LIMIT ?`
  )
    .bind(user.userId, isStaff, RITUAL_LIMIT)
    .all();
  const rituals = (((rows.results as unknown) as RitualRow[]) || []).map(
    ritualCard
  );
  return c.json({ ok: true, rituals });
});

export default app;
