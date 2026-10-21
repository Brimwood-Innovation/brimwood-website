/* Member invites (SCHEMA S2): a signed-in member invites one person, by
 * email. The personal invite link pattern from the audit resolves to this:
 * the member enters the invitee's email, which creates a single-use invite
 * bound to that address. Members hold at most 3 open invites; the quota is
 * enforced by the trg_invite_codes_member_quota trigger (0024), and staff
 * roles are exempt there. Only the HMAC of the code is stored; the plain
 * code is returned once, here. */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getUserId } from "../lib/auth";
import { cleanStr, isEmail, clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { generateInviteCode, inviteCodeHmac } from "../lib/invites";

const app = new Hono<{ Bindings: Bindings }>();

app.post("/", async (c) => {
  const { DB } = c.env;
  const userId = await getUserId(c);
  if (!userId) return c.json({ ok: false, error: "Not signed in." }, 401);
  if (!(await checkRateLimitD1(DB, "invite-create:" + clientIp(c.req.raw), 10, 3600))) {
    return c.json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const email = cleanStr((body as Record<string, unknown>).email, 200).toLowerCase();
  if (!isEmail(email)) {
    return c.json({ ok: false, error: "Please include the email of the person you are inviting." }, 400);
  }
  const self = await DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>();
  if ((self?.email ?? "").toLowerCase() === email) {
    return c.json({ ok: false, error: "You cannot invite yourself." }, 400);
  }
  const code = generateInviteCode();
  const stored = await inviteCodeHmac(c.env, code);
  const id = crypto.randomUUID();
  try {
    await DB.prepare(
      `INSERT INTO invite_codes (id, code, created_by, max_uses, expires_at, email, intro_request_id)
       VALUES (?, ?, ?, ?, NULL, ?, NULL)`
    )
      .bind(id, stored, userId, 1, email)
      .run();
  } catch (e) {
    const msg = String(e);
    if (msg.includes("members can send at most 3 invites")) {
      return c.json({ ok: false, error: "You already have 3 open invites. Revoke one before inviting someone new." }, 400);
    }
    if (msg.includes("idx_invite_codes_open_email")) {
      return c.json({ ok: false, error: "An open invite already exists for that email." }, 400);
    }
    throw e;
  }
  return c.json({ ok: true, code });
});

export default app;
