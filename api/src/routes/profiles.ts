/* User profiles (Phase D2).
 *
 * Brand rule (critical): members are anonymous by default. Public endpoints
 * NEVER expose email or real name. display_name is user-controlled and falls
 * back to initials (e.g. "J.") when unset. show_profile=1 is an explicit
 * opt-in to a public profile.
 *
 * Routes (mounted at /api):
 *   GET   /users/me           — authenticated; full own profile
 *   PATCH /users/me           — authenticated; display_name (2-40), bio (<=500), show_profile (0/1)
 *   POST  /users/me/avatar    — authenticated; 5MB image upload to R2, member-scoped key
 *   GET   /users/:id          — public; only when show_profile=1 AND status='active'; else 404
 *   PATCH /admin/users/:id    — admin; role, status, display_name override
 * (Admin list lives in admin.ts: GET /api/admin/users with ?q= search + pagination.)
 *
 * NOTE: /users/me is registered BEFORE /users/:id — Hono matches in
 * registration order, otherwise "me" would be treated as an id.
 */
import { Hono } from "hono";
import { readSession, getAdminUser } from "../lib/auth";
import type { Bindings } from "../index";
import { cleanStr, clientIp } from "../lib/validate";
import { checkRateLimit } from "../lib/ratelimit";

const app = new Hono<{ Bindings: Bindings }>();

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Reserved handles that can never be claimed (routes, brand, system words). */
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "api", "blog", "cms", "about", "support", "help",
  "brimwood", "studio", "members", "member", "u", "user", "users",
  "root", "system", "null", "undefined", "www", "mail", "email",
  "info", "contact", "privacy", "terms", "search", "events", "event",
  "academy", "newsletter", "dashboard", "invite", "invites", "login",
  "logout", "signin", "signup", "register", "settings", "profile",
  "profiles", "media", "static", "assets", "images", "img", "fonts",
  "oauth", "auth", "password", "security", "official", "team",
  "moderator", "mod", "staff",
]);

const USERNAME_RE = /^[a-z][a-z0-9_]{2,29}$/;
const USERNAME_CHANGE_DAYS = 30;

/** Validate a username handle. Returns error string or null. */
export function validateUsername(name: string): string | null {
  if (!USERNAME_RE.test(name)) {
    return "Username must be 3–30 characters, lowercase letters, numbers, or underscores, starting with a letter.";
  }
  if (RESERVED_USERNAMES.has(name)) {
    return "That username is reserved. Try another.";
  }
  return null;
}

/** Validate an http(s) URL string (website, social links). */
function validUrl(s: string, maxLen: number): boolean {
  if (!s || s.length > maxLen) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Validate social_links JSON: flat object of known keys → URL strings. */
function validateSocialLinks(raw: unknown): { ok: boolean; error?: string; value?: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "" };
  let obj: any;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Social links must be valid JSON." };
    }
  } else if (typeof raw === "object") {
    obj = raw;
  } else {
    return { ok: false, error: "Social links must be valid JSON." };
  }
  if (Array.isArray(obj) || typeof obj !== "object") {
    return { ok: false, error: "Social links must be an object." };
  }
  const allowed = new Set(["github", "linkedin", "x", "twitter", "instagram", "facebook", "website", "portfolio"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k).toLowerCase();
    if (!allowed.has(key)) continue; // drop unknown keys silently
    if (typeof v !== "string" || !validUrl(v.trim(), 300)) {
      return { ok: false, error: `Social link "${key}" must be a valid http(s) URL.` };
    }
    out[key] = v.trim();
  }
  if (Object.keys(out).length > 8) {
    return { ok: false, error: "Too many social links (max 8)." };
  }
  return { ok: true, value: JSON.stringify(out) };
}

/** Validate a JSON array of {title/school, org/company/degree, period} entries. */
function validateEntryList(
  raw: unknown,
  kind: "work" | "education",
  maxItems: number
): { ok: boolean; error?: string; value?: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "" };
  let arr: any;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return { ok: false, error: `${kind} history must be valid JSON.` };
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return { ok: false, error: `${kind} history must be an array.` };
  if (arr.length > maxItems) return { ok: false, error: `Too many ${kind} entries (max ${maxItems}).` };
  const out = [];
  for (const e of arr) {
    if (typeof e !== "object" || !e) return { ok: false, error: `Invalid ${kind} entry.` };
    const a = cleanStr(e.title || e.school || "", 100);
    const b = cleanStr(e.company || e.degree || "", 100);
    const period = cleanStr(e.period || "", 60);
    if (!a && !b) continue; // skip empties
    out.push(kind === "work" ? { title: a, company: b, period } : { school: a, degree: b, period });
  }
  return { ok: true, value: JSON.stringify(out) };
}

/** Member session (any authenticated user), or null. */
async function sessionUser(c: any): Promise<{ id: string; role: string } | null> {
  const s = await readSession(c);
  return s && s.userId ? { id: s.userId, role: s.role } : null;
}

/** Admin session, or null. */


function needAdmin(c: any, admin: any) {
  if (!admin) return c.json({ ok: false, error: "Admin only" }, 403);
  return null;
}

function needAuth(c: any, user: any) {
  if (!user) return c.json({ ok: false, error: "Sign in required." }, 401);
  return null;
}

async function audit(c: any, actorId: string, actorEmail: string, action: string, detail: string) {
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), actorId, action, `${actorEmail}: ${detail}`)
    .run()
    .catch(() => {});
}

/** Derive anonymous display fallback from a real name: "Jane Doe" -> "J.". */
export function initialsFor(name: string): string {
  const ch = (name || "").trim().charAt(0);
  return ch ? ch.toUpperCase() + "." : "Member";
}

/** Public-safe profile shape. Never includes email, real name, or DOB. */
function publicProfile(row: any) {
  let social: any = {};
  try {
    social = row.social_links ? JSON.parse(row.social_links) : {};
  } catch {
    social = {};
  }
  let work: any[] = [];
  try {
    work = row.work_history ? JSON.parse(row.work_history) : [];
  } catch {
    work = [];
  }
  let edu: any[] = [];
  try {
    edu = row.education ? JSON.parse(row.education) : [];
  } catch {
    edu = [];
  }
  return {
    id: row.id,
    username: row.username || null,
    display_name: row.display_name || initialsFor(row.name || ""),
    bio: row.bio || "",
    avatar_url: row.avatar_key ? `/api/media/${encodeURIComponent(row.avatar_key)}` : null,
    location: row.location || "",
    website: row.website || "",
    social_links: social,
    work_history: Array.isArray(work) ? work : [],
    education: Array.isArray(edu) ? edu : [],
    hobbies: row.hobbies || "",
    member_since: (row.created_at || "").slice(0, 10),
  };
}

/* ---------------- Own profile ---------------- */

/** GET /users/me — full own profile (private fields included; authenticated only). */
app.get("/users/me", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;
  const row: any = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, display_name, bio, avatar_key,
            show_profile, username, username_changed_at, location, website,
            social_links, work_history, education, hobbies, created_at
     FROM users WHERE id = ?`
  )
    .bind(user!.id)
    .first();
  if (!row) return c.json({ ok: false, error: "Not found." }, 404);
  return c.json({
    ok: true,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      display_name: row.display_name,
      display_name_public: row.display_name || initialsFor(row.name || ""),
      bio: row.bio || "",
      avatar_url: row.avatar_key ? `/api/media/${encodeURIComponent(row.avatar_key)}` : null,
      show_profile: row.show_profile,
      username: row.username || null,
      username_changeable_at: usernameChangeableAt(row.username_changed_at),
      location: row.location || "",
      website: row.website || "",
      social_links: row.social_links || "",
      work_history: row.work_history || "",
      education: row.education || "",
      hobbies: row.hobbies || "",
      member_since: (row.created_at || "").slice(0, 10),
    },
  });
});

/** ISO date when the user may next change their username (null = now). */
function usernameChangeableAt(changedAt: string | null): string | null {
  if (!changedAt) return null;
  const next = new Date(changedAt).getTime() + USERNAME_CHANGE_DAYS * 86400000;
  return next <= Date.now() ? null : new Date(next).toISOString();
}

/** PATCH /users/me — update display_name, bio, show_profile. */
app.patch("/users/me", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;

  const ip = clientIp(c.req.raw);
  if (!(await checkRateLimit(c.env.RATE_LIMIT_KV, `profile:${user!.id}`, 30, 3600))) {
    return c.json({ ok: false, error: "Too many updates. Try again later." }, 429);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }

  const updates: string[] = [];
  const binds: any[] = [];

  if (body.display_name !== undefined) {
    const dn = cleanStr(body.display_name, 40);
    if (dn.length < 2) {
      return c.json({ ok: false, error: "Display name must be 2–40 characters." }, 400);
    }
    updates.push("display_name = ?");
    binds.push(dn);
  }
  if (body.bio !== undefined) {
    const bio = cleanStr(body.bio, 500);
    updates.push("bio = ?");
    binds.push(bio);
  }
  if (body.show_profile !== undefined) {
    const sp = body.show_profile === 1 || body.show_profile === true ? 1 : 0;
    updates.push("show_profile = ?");
    binds.push(sp);
  }
  if (body.username !== undefined) {
    const uname = cleanStr(body.username, 30).toLowerCase();
    const err = validateUsername(uname);
    if (err) return c.json({ ok: false, error: err }, 400);
    // Anti-squatting: one change per 30 days (first claim always allowed).
    const cur: any = await c.env.DB.prepare(
      "SELECT username, username_changed_at FROM users WHERE id = ?"
    )
      .bind(user!.id)
      .first();
    if (cur?.username && cur.username !== uname) {
      const next = usernameChangeableAt(cur.username_changed_at);
      if (next) {
        return c.json(
          { ok: false, error: `You can change your username again after ${next.slice(0, 10)}.` },
          429
        );
      }
    }
    if (cur?.username !== uname) {
      const taken: any = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?")
        .bind(uname)
        .first();
      if (taken && taken.id !== user!.id) {
        return c.json({ ok: false, error: "That username is taken." }, 409);
      }
      updates.push("username = ?");
      binds.push(uname);
      updates.push("username_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    }
  }
  if (body.location !== undefined) {
    updates.push("location = ?");
    binds.push(cleanStr(body.location, 100));
  }
  if (body.website !== undefined) {
    const ws = cleanStr(body.website, 300);
    if (ws && !validUrl(ws, 300)) {
      return c.json({ ok: false, error: "Website must be a valid http(s) URL." }, 400);
    }
    updates.push("website = ?");
    binds.push(ws);
  }
  if (body.social_links !== undefined) {
    const v = validateSocialLinks(body.social_links);
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
    updates.push("social_links = ?");
    binds.push(v.value);
  }
  if (body.work_history !== undefined) {
    const v = validateEntryList(body.work_history, "work", 10);
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
    updates.push("work_history = ?");
    binds.push(v.value);
  }
  if (body.education !== undefined) {
    const v = validateEntryList(body.education, "education", 10);
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
    updates.push("education = ?");
    binds.push(v.value);
  }
  if (body.hobbies !== undefined) {
    updates.push("hobbies = ?");
    binds.push(cleanStr(body.hobbies, 500));
  }
  if (!updates.length) {
    return c.json({ ok: false, error: "Nothing to update." }, 400);
  }

  // Fetch email for audit log (never exposed to client here).
  const me: any = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(user!.id)
    .first();
  await c.env.DB.prepare(
    `UPDATE users SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
    .bind(...binds, user!.id)
    .run();
  await audit(c, user!.id, me?.email || "unknown", "profile.update", `fields: ${updates.length}; ip ${ip}`);

  return c.json({ ok: true });
});

/** POST /users/me/avatar — member avatar upload (5MB, images only). */
app.post("/users/me/avatar", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;

  if (!(await checkRateLimit(c.env.RATE_LIMIT_KV, `avatar:${user!.id}`, 10, 3600))) {
    return c.json({ ok: false, error: "Too many uploads. Try again later." }, 429);
  }

  let file: File | null = null;
  try {
    const body = await c.req.parseBody();
    const f = body["file"];
    if (f instanceof File) file = f;
  } catch {
    return c.json({ ok: false, error: "Invalid upload." }, 400);
  }
  if (!file || file.size === 0) {
    return c.json({ ok: false, error: "Choose an image to upload." }, 400);
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return c.json({ ok: false, error: "Image is too large. Maximum 5 MB." }, 400);
  }
  const ext = AVATAR_TYPES[file.type];
  if (!ext) {
    return c.json({ ok: false, error: "Images only: PNG, JPEG, WebP, or GIF." }, 400);
  }

  // Member-scoped key so users can never overwrite each other's avatars.
  const key = `avatars/${user!.id}/${crypto.randomUUID()}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  // Remove the previous avatar object, if any.
  const prev: any = await c.env.DB.prepare("SELECT avatar_key, email FROM users WHERE id = ?")
    .bind(user!.id)
    .first();
  await c.env.DB.prepare("UPDATE users SET avatar_key = ? WHERE id = ?").bind(key, user!.id).run();
  if (prev?.avatar_key && prev.avatar_key !== key) {
    await c.env.MEDIA.delete(prev.avatar_key).catch(() => {});
  }
  await audit(c, user!.id, prev?.email || "unknown", "profile.avatar", `key ${key}`);

  return c.json({ ok: true, avatar_url: `/api/media/${encodeURIComponent(key)}` });
});

/* ---------------- Public profile ---------------- */

/** GET /users/public — minimal index of opted-in public profiles, for
 * build-time prerendering of /u/:id and /@username pages (OG tags).
 * Only show_profile=1 AND status='active'. No PII beyond id/username. */
app.get("/users/public", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, username FROM users WHERE show_profile = 1 AND status = 'active'`
  ).all();
  return c.json({ ok: true, users: (rows.results || []).filter((u: any) => u.id) });
});

/** GET /users/:id — public profile; 404 unless show_profile=1 AND active.
 * Accepts a user id OR a username handle (usernames can't collide with UUIDs).
 * Never returns email, real name, or DOB. Private and nonexistent ids both 404
 * (no enumeration signal). */
app.get("/users/:id", async (c) => {
  const id = cleanStr(c.req.param("id"), 64).toLowerCase();
  if (!id) return c.json({ ok: false, error: "Not found." }, 404);
  const row: any = await c.env.DB.prepare(
    `SELECT id, name, username, display_name, bio, avatar_key, location,
            website, social_links, work_history, education, hobbies, created_at
     FROM users WHERE (id = ? OR username = ?) AND show_profile = 1 AND status = 'active'`
  )
    .bind(c.req.param("id"), id)
    .first();
  if (!row) return c.json({ ok: false, error: "Not found." }, 404);
  return c.json({ ok: true, user: publicProfile(row) });
});

/* ---------------- Admin ---------------- */

/** PATCH /admin/users/:id — role, status, display_name, show_profile override. Audit-logged. */
app.patch("/admin/users/:id", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;

  const id = cleanStr(c.req.param("id"), 64);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }

  const updates: string[] = [];
  const binds: any[] = [];
  if (body.role !== undefined) {
    if (!["admin", "member"].includes(body.role)) {
      return c.json({ ok: false, error: "Invalid role." }, 400);
    }
    updates.push("role = ?");
    binds.push(body.role);
  }
  if (body.status !== undefined) {
    if (!["active", "suspended"].includes(body.status)) {
      return c.json({ ok: false, error: "Invalid status." }, 400);
    }
    updates.push("status = ?");
    binds.push(body.status);
  }
  if (body.display_name !== undefined) {
    // Admin override: allow clearing (empty string -> NULL) or 2-40 chars.
    const dn = cleanStr(body.display_name, 40);
    if (dn && dn.length < 2) {
      return c.json({ ok: false, error: "Display name must be 2–40 characters." }, 400);
    }
    updates.push("display_name = ?");
    binds.push(dn || null);
  }
  if (body.show_profile !== undefined) {
    updates.push("show_profile = ?");
    binds.push(body.show_profile === 1 || body.show_profile === true ? 1 : 0);
  }
  if (body.username !== undefined) {
    // Admin override: validated, uniqueness-checked, no 30-day limit.
    const uname = cleanStr(body.username, 30).toLowerCase();
    if (uname) {
      const err = validateUsername(uname);
      if (err) return c.json({ ok: false, error: err }, 400);
      const taken: any = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?")
        .bind(uname)
        .first();
      if (taken && taken.id !== id) {
        return c.json({ ok: false, error: "That username is taken." }, 409);
      }
      updates.push("username = ?");
      binds.push(uname);
    } else {
      updates.push("username = NULL");
    }
  }
  if (!updates.length) {
    return c.json({ ok: false, error: "Nothing to update." }, 400);
  }

  const target: any = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
  if (!target) return c.json({ ok: false, error: "Not found." }, 404);

  await c.env.DB.prepare(
    `UPDATE users SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
    .bind(...binds, id)
    .run();
  await audit(c, admin!.id, admin!.email, "admin.user.update", `user ${id}: ${updates.join(", ")}`);

  return c.json({ ok: true });
});

export default app;
