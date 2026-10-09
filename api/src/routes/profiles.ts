/* User profiles (Phase D2).
 *
 * Brand rule (critical): members are anonymous by default. Public endpoints
 * NEVER expose email or real name. display_name is user-controlled and falls
 * back to initials (e.g. "J.") when unset. show_profile=1 is an explicit
 * opt-in to a public profile.
 *
 * Routes (mounted at /api):
 *   GET   /users/me           — authenticated; full own profile
 *   PATCH /users/me           — authenticated; identity fields + username (legacy editor)
 *   POST  /users/me/avatar    — authenticated; 5MB image upload to R2, member-scoped key
 *   GET   /users/:id          — relationship-filtered; delegates to the /profiles/:id engine
 *   GET   /profiles/me        — authenticated; full own profile incl. dob, gender, visibility map
 *   PATCH /profiles/me        — authenticated; rich-profile editor (all fields validated)
 *   POST  /profiles/me/avatar — authenticated; avatar upload (canonical; syncs both key columns)
 *   GET   /profiles/:id       — relationship-filtered view: owner/admin see everything,
 *                               members see public+members fields, anonymous sees public
 *                               fields only when show_profile=1 AND status='active'; else 404
 *   PATCH /admin/users/:id    — admin; role, status, display_name override
 * (Admin list lives in admin.ts: GET /api/admin/users with ?q= search + pagination.)
 *
 * NOTE: /users/me is registered BEFORE /users/:id — Hono matches in
 * registration order, otherwise "me" would be treated as an id.
 */
import { Hono } from "hono";
import { readSession, getAdminUser, destroyUserSessions } from "../lib/auth";
import type { Bindings } from "../index";
import { cleanStr, clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";

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

/* ---------------- Rich profiles: per-field visibility (0016) ----------------
 *
 * Every profile field carries its own audience level:
 *   public   — anyone, including anonymous visitors (only on show_profile=1 profiles)
 *   members  — signed-in members
 *   only-me  — the profile owner (and admins) only
 *
 * Brand rule: anonymous by default. dob and gender default to only-me; every
 * other field defaults to public, preserving the pre-0016 public-profile
 * contract for show_profile=1 users. All filtering happens server-side —
 * the API never leaks an only-me field to another viewer.
 */

export const VISIBILITY_LEVELS = ["public", "members", "only-me"] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** Fields that carry a per-field visibility setting. */
export const VISIBILITY_FIELDS = [
  "display_name",
  "bio",
  "avatar",
  "location",
  "website",
  "social_links",
  "work_history",
  "education",
  "hobbies",
  "achievements",
  "life_events",
  "gender",
  "dob",
] as const;

/** Default visibility per field. */
export const DEFAULT_VISIBILITY: Record<string, VisibilityLevel> = {
  display_name: "public",
  bio: "public",
  avatar: "public",
  location: "public",
  website: "public",
  social_links: "public",
  work_history: "public",
  education: "public",
  hobbies: "public",
  achievements: "public",
  life_events: "public",
  gender: "only-me",
  dob: "only-me",
};

export type Relationship = "owner" | "admin" | "member" | "anonymous";

const KNOWN_FIELDS = new Set<string>(VISIBILITY_FIELDS);
const KNOWN_LEVELS = new Set<string>(VISIBILITY_LEVELS);

/** Validate and sanitize a profile_visibility map from user input.
 * Unknown fields are dropped silently; unknown levels are rejected. */
export function validateVisibility(
  raw: unknown
): { ok: boolean; error?: string; value?: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "" };
  let obj: any;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Visibility must be valid JSON." };
    }
  } else if (typeof raw === "object") {
    obj = raw;
  } else {
    return { ok: false, error: "Visibility must be an object." };
  }
  if (Array.isArray(obj) || typeof obj !== "object") {
    return { ok: false, error: "Visibility must be an object." };
  }
  const out: Record<string, VisibilityLevel> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k);
    if (!KNOWN_FIELDS.has(key)) continue; // drop unknown fields silently
    if (typeof v !== "string" || !KNOWN_LEVELS.has(v)) {
      return { ok: false, error: `Invalid visibility for "${key}".` };
    }
    out[key] = v as VisibilityLevel;
  }
  return { ok: true, value: JSON.stringify(out) };
}

/** Effective visibility for a row: defaults merged under stored overrides.
 * Corrupt stored JSON falls back to defaults (fail closed). */
export function effectiveVisibility(row: any): Record<string, VisibilityLevel> {
  const vis: Record<string, VisibilityLevel> = { ...DEFAULT_VISIBILITY };
  if (row?.profile_visibility) {
    try {
      const stored = JSON.parse(row.profile_visibility);
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [k, v] of Object.entries(stored)) {
          if (KNOWN_FIELDS.has(k) && KNOWN_LEVELS.has(v as string)) {
            vis[k] = v as VisibilityLevel;
          }
        }
      }
    } catch {
      /* ignore corrupt JSON; defaults stand */
    }
  }
  return vis;
}

/** True when a requester with `rel` may see `field` under visibility `vis`. */
export function fieldVisible(
  field: string,
  vis: Record<string, VisibilityLevel>,
  rel: Relationship
): boolean {
  if (rel === "owner" || rel === "admin") return true;
  const level = vis[field] || DEFAULT_VISIBILITY[field] || "public";
  if (rel === "member") return level !== "only-me";
  return level === "public"; // anonymous
}

/* ---------------- Field normalizers (0016) ---------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate an ISO date (YYYY-MM-DD): real calendar date, not in the future. */
export function validPastDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return false;
  }
  return dt.getTime() <= Date.now();
}

/** Validate dob: empty (clears) or a valid past ISO date. */
export function validateDob(raw: unknown): { ok: boolean; error?: string; value?: string } {
  const s = cleanStr(raw, 10);
  if (!s) return { ok: true, value: "" };
  if (!validPastDate(s)) {
    return { ok: false, error: "Date of birth must be a valid past date (YYYY-MM-DD)." };
  }
  return { ok: true, value: s };
}

/** Validate gender: empty (clears) or free text, max 60 chars. */
export function validateGender(raw: unknown): { ok: boolean; error?: string; value?: string } {
  return { ok: true, value: cleanStr(raw, 60) };
}

/** Normalize hobbies to a JSON list: accepts an array of strings, a JSON
 * array string, or a legacy comma-separated string. */
export function normalizeHobbies(
  raw: unknown
): { ok: boolean; error?: string; value?: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "" };
  let arr: string[];
  if (Array.isArray(raw)) {
    arr = raw.map((h) => cleanStr(h, 60)).filter(Boolean);
  } else if (typeof raw === "string") {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      arr = parsed.map((h) => cleanStr(h, 60)).filter(Boolean);
    } else {
      arr = raw.split(",").map((h) => cleanStr(h, 60)).filter(Boolean);
    }
  } else {
    return { ok: false, error: "Hobbies must be a list." };
  }
  if (arr.length > 30) return { ok: false, error: "Too many hobbies (max 30)." };
  return { ok: true, value: JSON.stringify(arr) };
}

/** Read hobbies as a list: JSON array when stored that way, falling back to
 * comma-splitting legacy free-text rows. */
export function hobbyList(row: any): string[] {
  if (!row?.hobbies) return [];
  try {
    const parsed = JSON.parse(row.hobbies);
    if (Array.isArray(parsed)) return parsed.map((h) => String(h)).filter(Boolean);
  } catch {
    /* legacy free-text string */
  }
  return String(row.hobbies)
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Canonical education entry: {school, kind, years, degree?}.
 * kind is "school" (primary/secondary) or "college" (post-secondary). */
export interface EducationEntry {
  school: string;
  kind: "school" | "college";
  years: string;
  degree?: string;
}

/** Validate education entries. Accepts the canonical {school, kind, years}
 * shape and legacy {school, degree, period} rows (period maps to years and
 * the degree text is preserved). Stores the canonical shape. */
export function normalizeEducation(
  raw: unknown
): { ok: boolean; error?: string; value?: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "" };
  let arr: any;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Education must be valid JSON." };
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return { ok: false, error: "Education must be a list." };
  if (arr.length > 10) return { ok: false, error: "Too many education entries (max 10)." };
  const out: EducationEntry[] = [];
  for (const e of arr) {
    if (typeof e !== "object" || !e) return { ok: false, error: "Invalid education entry." };
    const school = cleanStr(e.school, 100);
    const kind: "school" | "college" = e.kind === "school" ? "school" : "college";
    const degree = cleanStr(e.degree || "", 100);
    const years = cleanStr(e.years || e.period || "", 60);
    if (!school && !degree) continue; // skip empties
    const entry: EducationEntry = { school, kind, years };
    if (degree) entry.degree = degree;
    out.push(entry);
  }
  return { ok: true, value: JSON.stringify(out) };
}

/** Read education as canonical entries, upgrading legacy {school, degree,
 * period} rows on the fly. */
export function educationList(row: any): EducationEntry[] {
  if (!row?.education) return [];
  try {
    const arr = JSON.parse(row.education);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e: any) => e && typeof e === "object")
      .map((e: any) => {
        const entry: EducationEntry = {
          school: String(e.school || ""),
          kind: e.kind === "school" ? "school" : "college",
          years: String(e.years || e.period || ""),
        };
        if (e.degree) entry.degree = String(e.degree);
        return entry;
      })
      .filter((e: EducationEntry) => e.school || e.degree);
  } catch {
    return [];
  }
}

/** Achievements and life events share one shape: {title, date, description}. */
export interface Milestone {
  title: string;
  date: string;
  description: string;
}

/** Validate a JSON list of milestones (achievements, life events). */
export function normalizeMilestones(
  raw: unknown,
  kind: "achievements" | "life_events"
): { ok: boolean; error?: string; value?: string } {
  const label = kind === "achievements" ? "Achievements" : "Life events";
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "" };
  let arr: any;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return { ok: false, error: `${label} must be valid JSON.` };
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return { ok: false, error: `${label} must be a list.` };
  if (arr.length > 10) return { ok: false, error: `Too many ${label.toLowerCase()} (max 10).` };
  const out: Milestone[] = [];
  for (const e of arr) {
    if (typeof e !== "object" || !e) {
      return { ok: false, error: `Invalid ${label.toLowerCase().slice(0, -1)} entry.` };
    }
    const title = cleanStr(e.title, 100);
    const date = cleanStr(e.date, 10);
    const description = cleanStr(e.description, 300);
    if (!title && !description) continue; // skip empties
    if (!title) return { ok: false, error: `${label} entries need a title.` };
    if (date && !validPastDate(date)) {
      return { ok: false, error: `${label} dates must be valid past dates (YYYY-MM-DD).` };
    }
    out.push({ title, date, description });
  }
  return { ok: true, value: JSON.stringify(out) };
}

/** Read a milestone column as a list of {title, date, description}. */
export function milestoneList(row: any, col: "achievements" | "life_events"): Milestone[] {
  if (!row?.[col]) return [];
  try {
    const arr = JSON.parse(row[col]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e: any) => e && typeof e === "object" && (e.title || e.description))
      .map((e: any) => ({
        title: String(e.title || ""),
        date: String(e.date || ""),
        description: String(e.description || ""),
      }));
  } catch {
    return [];
  }
}

/* ---------------- Profile shape ---------------- */

function parseJsonObj(s: unknown): Record<string, string> {
  if (!s) return {};
  try {
    const o = typeof s === "string" ? JSON.parse(s) : s;
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function parseJsonList(s: unknown): any[] {
  if (!s) return [];
  try {
    const a = typeof s === "string" ? JSON.parse(s) : s;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** Avatar R2 key: prefer the canonical avatar_r2_key (0016),
 * fall back to avatar_key (0010). */
export function avatarKeyOf(row: any): string | null {
  return row?.avatar_r2_key || row?.avatar_key || null;
}

/** Public avatar URL for a profile row (null when no avatar). */
export function avatarUrlOf(row: any): string | null {
  const key = avatarKeyOf(row);
  return key ? `/api/media/${encodeURIComponent(key)}` : null;
}

/** Columns selected for a full profile row (0010 + 0016). */
const PROFILE_COLUMNS = `id, email, name, role, status, display_name, bio,
  avatar_key, avatar_r2_key, show_profile, username, username_changed_at,
  location, website, social_links, work_history, education, hobbies,
  dob, gender, achievements, life_events, profile_visibility, created_at`;

async function fetchProfileRow(DB: any, idOrUsername: string): Promise<any> {
  const id = cleanStr(idOrUsername, 64);
  return DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ? OR username = ?`
  )
    .bind(id, id.toLowerCase())
    .first();
}

/** Build the API-facing profile for `rel`. Owner/admin get everything
 * (including email and the visibility map); everyone else gets only the
 * fields their relationship allows. Email and real name NEVER leave the
 * server for non-owner/non-admin viewers. */
export function richProfileShape(row: any, rel: Relationship): any {
  const vis = effectiveVisibility(row);
  const can = (field: string) => fieldVisible(field, vis, rel);
  const user: any = {
    id: row.id,
    username: row.username || null,
    display_name: row.display_name || initialsFor(row.name || ""),
    member_since: (row.created_at || "").slice(0, 10),
  };
  if (can("bio")) user.bio = row.bio || "";
  if (can("avatar")) user.avatar_url = avatarUrlOf(row);
  if (can("location")) user.location = row.location || "";
  if (can("website")) user.website = row.website || "";
  if (can("social_links")) user.social_links = parseJsonObj(row.social_links);
  if (can("work_history")) user.work_history = parseJsonList(row.work_history);
  if (can("education")) user.education = educationList(row);
  if (can("hobbies")) user.hobbies = hobbyList(row);
  if (can("achievements")) user.achievements = milestoneList(row, "achievements");
  if (can("life_events")) user.life_events = milestoneList(row, "life_events");
  if (can("gender")) user.gender = row.gender || "";
  if (can("dob")) user.dob = row.dob || "";
  if (rel === "owner" || rel === "admin") {
    user.email = row.email;
    user.name = row.name;
    user.role = row.role;
    user.status = row.status;
    user.show_profile = row.show_profile;
    user.username_changeable_at = usernameChangeableAt(row.username_changed_at);
    user.visibility = vis;
    // Raw (un-fallback) values the editor needs to round-trip.
    user.display_name_raw = row.display_name || "";
    user.bio_raw = row.bio || "";
  }
  return user;
}

/** The requester's relationship to the target profile. Role comes from the
 * live users row via readSession, so a demoted admin loses admin access. */
async function relationshipTo(c: any, targetId: string): Promise<Relationship> {
  const s = await readSession(c);
  if (s?.userId) {
    if (s.userId === targetId) return "owner";
    if (s.role === "admin") return "admin";
    return "member";
  }
  return "anonymous";
}

/** Shared profile-view handler: relationship-filtered, anti-enumeration
 * (missing, private, and suspended targets all 404 for strangers). */
async function profileView(c: any, idOrUsername: string) {
  const row = await fetchProfileRow(c.env.DB, idOrUsername);
  if (!row) return c.json({ ok: false, error: "Not found." }, 404);
  const rel = await relationshipTo(c, row.id);
  if (rel !== "owner" && rel !== "admin") {
    if (row.status !== "active") return c.json({ ok: false, error: "Not found." }, 404);
    if (rel === "anonymous" && row.show_profile !== 1) {
      return c.json({ ok: false, error: "Not found." }, 404);
    }
  }
  return c.json({ ok: true, user: richProfileShape(row, rel) });
}

/** Shared avatar-upload handler (POST /users/me/avatar and
 * POST /profiles/me/avatar). Writes BOTH avatar_key (0010) and
 * avatar_r2_key (0016) so old and new readers agree. */
async function handleAvatarUpload(c: any, user: { id: string }) {
  if (!(await checkRateLimitD1(c.env.DB, `avatar:${user.id}`, 10, 3600))) {
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
  const key = `avatars/${user.id}/${crypto.randomUUID()}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  // Remove the previous avatar object, if any (either key column).
  const prev: any = await c.env.DB.prepare(
    "SELECT avatar_key, avatar_r2_key, email FROM users WHERE id = ?"
  )
    .bind(user.id)
    .first();
  await c.env.DB.prepare("UPDATE users SET avatar_key = ?, avatar_r2_key = ? WHERE id = ?")
    .bind(key, key, user.id)
    .run();
  const oldKey = prev?.avatar_r2_key || prev?.avatar_key;
  if (oldKey && oldKey !== key) {
    await c.env.MEDIA.delete(oldKey).catch(() => {});
  }
  await audit(c, user.id, prev?.email || "unknown", "profile.avatar", `key ${key}`);

  return c.json({
    ok: true,
    avatar_url: `/api/media/${encodeURIComponent(key)}`,
    avatar_key: key,
  });
}

/* ---------------- Own profile ---------------- */

/** GET /users/me — full own profile (private fields included; authenticated only). */
app.get("/users/me", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;
  const row: any = await c.env.DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`
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
      avatar_url: avatarUrlOf(row),
      show_profile: row.show_profile,
      username: row.username || null,
      username_changeable_at: usernameChangeableAt(row.username_changed_at),
      location: row.location || "",
      website: row.website || "",
      social_links: row.social_links || "",
      work_history: row.work_history || "",
      education: row.education || "",
      education_list: educationList(row),
      hobbies: row.hobbies || "",
      hobbies_list: hobbyList(row),
      dob: row.dob || "",
      gender: row.gender || "",
      achievements: milestoneList(row, "achievements"),
      life_events: milestoneList(row, "life_events"),
      visibility: effectiveVisibility(row),
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
  if (!(await checkRateLimitD1(c.env.DB, `profile:${user!.id}`, 30, 3600))) {
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

/** POST /users/me/avatar — member avatar upload (5MB, images only).
 * Shared handler with POST /profiles/me/avatar. */
app.post("/users/me/avatar", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;
  return handleAvatarUpload(c, user!);
});

/* ---------------- Rich profiles (per-field visibility) ----------------
 * NOTE: /profiles/me is registered BEFORE /profiles/:id — Hono matches in
 * registration order, otherwise "me" would be treated as an id.
 */

/** GET /profiles/me — full own profile incl. dob, gender, and the
 * per-field visibility map. */
app.get("/profiles/me", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;
  const row: any = await c.env.DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`
  )
    .bind(user!.id)
    .first();
  if (!row) return c.json({ ok: false, error: "Not found." }, 404);
  return c.json({ ok: true, user: richProfileShape(row, "owner") });
});

/** PATCH /profiles/me — rich-profile editor. Validates every field; username
 * changes stay on PATCH /users/me (30-day anti-squatting rule). */
app.patch("/profiles/me", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;

  const ip = clientIp(c.req.raw);
  if (!(await checkRateLimitD1(c.env.DB, `rich-profile:${user!.id}`, 30, 3600))) {
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
  const fail = (error: string) => c.json({ ok: false, error }, 400);

  if (body.display_name !== undefined) {
    const dn = cleanStr(body.display_name, 40);
    if (dn.length < 2) return fail("Display name must be 2–40 characters.");
    updates.push("display_name = ?");
    binds.push(dn);
  }
  if (body.bio !== undefined) {
    updates.push("bio = ?");
    binds.push(cleanStr(body.bio, 500));
  }
  if (body.show_profile !== undefined) {
    updates.push("show_profile = ?");
    binds.push(body.show_profile === 1 || body.show_profile === true ? 1 : 0);
  }
  if (body.location !== undefined) {
    updates.push("location = ?");
    binds.push(cleanStr(body.location, 100));
  }
  if (body.website !== undefined) {
    const ws = cleanStr(body.website, 300);
    if (ws && !validUrl(ws, 300)) return fail("Website must be a valid http(s) URL.");
    updates.push("website = ?");
    binds.push(ws);
  }
  if (body.social_links !== undefined) {
    const v = validateSocialLinks(body.social_links);
    if (!v.ok) return fail(v.error!);
    updates.push("social_links = ?");
    binds.push(v.value);
  }
  if (body.work_history !== undefined) {
    const v = validateEntryList(body.work_history, "work", 10);
    if (!v.ok) return fail(v.error!);
    updates.push("work_history = ?");
    binds.push(v.value);
  }
  if (body.education !== undefined) {
    const v = normalizeEducation(body.education);
    if (!v.ok) return fail(v.error!);
    updates.push("education = ?");
    binds.push(v.value);
  }
  if (body.hobbies !== undefined) {
    const v = normalizeHobbies(body.hobbies);
    if (!v.ok) return fail(v.error!);
    updates.push("hobbies = ?");
    binds.push(v.value);
  }
  if (body.dob !== undefined) {
    const v = validateDob(body.dob);
    if (!v.ok) return fail(v.error!);
    updates.push("dob = ?");
    binds.push(v.value || null);
  }
  if (body.gender !== undefined) {
    const v = validateGender(body.gender);
    updates.push("gender = ?");
    binds.push(v.value || null);
  }
  if (body.achievements !== undefined) {
    const v = normalizeMilestones(body.achievements, "achievements");
    if (!v.ok) return fail(v.error!);
    updates.push("achievements = ?");
    binds.push(v.value);
  }
  if (body.life_events !== undefined) {
    const v = normalizeMilestones(body.life_events, "life_events");
    if (!v.ok) return fail(v.error!);
    updates.push("life_events = ?");
    binds.push(v.value);
  }
  if (body.profile_visibility !== undefined) {
    const v = validateVisibility(body.profile_visibility);
    if (!v.ok) return fail(v.error!);
    updates.push("profile_visibility = ?");
    binds.push(v.value);
  }
  if (!updates.length) {
    return fail("Nothing to update.");
  }

  // Fetch email for the audit log (never exposed to the client here).
  const me: any = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(user!.id)
    .first();
  await c.env.DB.prepare(
    `UPDATE users SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
    .bind(...binds, user!.id)
    .run();
  await audit(c, user!.id, me?.email || "unknown", "profile.rich.update", `fields: ${updates.length}; ip ${ip}`);

  return c.json({ ok: true });
});

/** POST /profiles/me/avatar — avatar upload; same rules as /users/me/avatar,
 * returns the canonical key and URL. */
app.post("/profiles/me/avatar", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;
  return handleAvatarUpload(c, user!);
});

/** GET /profiles/:id — relationship-filtered profile view. Accepts a user id
 * OR a username handle. Server-side field filtering by the requester's
 * relationship and the profile's per-field visibility — only-me fields never
 * reach another viewer. Private and nonexistent ids both 404 (no enumeration). */
app.get("/profiles/:id", async (c) => {
  return profileView(c, c.req.param("id"));
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

/** GET /users/:id — public profile view. Delegates to the same
 * relationship-filtered engine as GET /profiles/:id so per-field visibility
 * is enforced on every surface: anonymous viewers see only public fields of
 * show_profile=1, active profiles. Never returns email, real name, or
 * only-me fields. Private and nonexistent ids both 404 (no enumeration). */
app.get("/users/:id", async (c) => {
  return profileView(c, c.req.param("id"));
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

  const target: any = await c.env.DB.prepare(
    "SELECT id, role, status FROM users WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!target) return c.json({ ok: false, error: "Not found." }, 404);

  await c.env.DB.prepare(
    `UPDATE users SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
    .bind(...binds, id)
    .run();

  // Privilege change takes effect immediately: a demoted admin or suspended
  // user must not keep using sessions minted while they were privileged.
  const demoted = body.role !== undefined && target.role === "admin" && body.role !== "admin";
  const suspended = body.status !== undefined && target.status !== "suspended" && body.status === "suspended";
  if (demoted || suspended) {
    await destroyUserSessions(c.env, id);
  }

  await audit(c, admin!.id, admin!.email, "admin.user.update", `user ${id}: ${updates.join(", ")}`);

  return c.json({ ok: true });
});

export default app;
