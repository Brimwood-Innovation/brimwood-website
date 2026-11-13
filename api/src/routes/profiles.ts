/* User profiles (Phase D2).
 *
 * Brand rule (critical): members are anonymous by default. Public endpoints
 * NEVER expose email or real name. display_name is user-controlled and falls
 * back to initials (e.g. "J.") when unset. show_profile=1 is an explicit
 * opt-in to a public profile.
 *
 * Routes (mounted at /api):
 *   GET   /users/me           - authenticated; full own profile
 *   PATCH /users/me           - authenticated; identity fields + username (legacy editor)
 *   POST  /users/me/avatar    - authenticated; 5MB image upload to R2, member-scoped key
 *   GET   /users/:id          - relationship-filtered; delegates to the /profiles/:id engine
 *   GET   /profiles/me        - authenticated; full own profile incl. member_profiles,
 *                               skills, and the per-field visibility map
 *   PATCH /profiles/me        - authenticated; rich-profile editor (all fields validated)
 *   POST  /profiles/me/avatar - authenticated; avatar upload (canonical; syncs both key columns)
 *   GET   /profiles/:id       - relationship-filtered view: owner/admin see everything,
 *                               members see public+members fields, anonymous sees public
 *                               fields only when show_profile=1 AND status='active'; else 404
 *   GET   /skill-tags         - public; curated skill tag list for the editor
 *   PATCH /admin/users/:id    - admin; role, status, display_name override
 * (Admin list lives in admin.ts: GET /api/admin/users with ?q= search + pagination.)
 *
 * D11: date of birth, gender, and life events are no longer collected. The API
 * never selects or writes those columns; sending new values is rejected at the
 * boundary with a 400 (the 0025 triggers would ABORT the write as a 500).
 * Per-field visibility lives in profile_field_visibility (0025); new profile
 * content lives in member_profiles and member_skills.
 *
 * NOTE: /users/me is registered BEFORE /users/:id - Hono matches in
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

/* ---------------- Rich profiles: per-field visibility (0025) ----------------
 *
 * Every profile field carries its own audience level:
 *   public   - anyone, including anonymous visitors (only on show_profile=1 profiles)
 *   members  - signed-in members
 *   only-me  - the profile owner (and admins) only
 *
 * Brand rule: anonymous by default. The per-field visibility rows live in
 * profile_field_visibility (0025), the source of truth; a missing row means
 * the API default, which is public for every field - preserving the
 * pre-0016 public-profile contract for show_profile=1 users. D11 removed
 * dob, gender, and life events from the field set entirely. All filtering
 * happens server-side - the API never leaks an only-me field to another
 * viewer.
 */

export const VISIBILITY_LEVELS = ["public", "members", "only-me"] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** Fields that carry a per-field visibility setting (matches the 0025 CHECK). */
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
  "building_now",
  "can_help_with",
  "looking_for",
  "skills",
  "projects",
  "badges",
] as const;

/** Default visibility per field: public unless the member overrides it. */
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
  building_now: "public",
  can_help_with: "public",
  looking_for: "public",
  skills: "public",
  projects: "public",
  badges: "public",
};

export type Relationship = "owner" | "admin" | "member" | "anonymous";

const KNOWN_FIELDS = new Set<string>(VISIBILITY_FIELDS);
const KNOWN_LEVELS = new Set<string>(VISIBILITY_LEVELS);

/** Validate and sanitize a visibility map from user input.
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

/** Effective visibility: defaults merged under a stored override map.
 * Corrupt or unknown entries are ignored (fail closed to defaults). */
export function effectiveVisibility(stored?: unknown): Record<string, VisibilityLevel> {
  const vis: Record<string, VisibilityLevel> = { ...DEFAULT_VISIBILITY };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      if (KNOWN_FIELDS.has(k) && KNOWN_LEVELS.has(v as string)) {
        vis[k] = v as VisibilityLevel;
      }
    }
  }
  return vis;
}

/** Load a member's stored visibility rows from profile_field_visibility and
 * merge them over the defaults. A missing table row or an empty result both
 * mean defaults. */
export async function loadVisibility(
  DB: any,
  userId: string
): Promise<Record<string, VisibilityLevel>> {
  const rows: any = await DB.prepare(
    "SELECT field, visibility FROM profile_field_visibility WHERE user_id = ?"
  )
    .bind(userId)
    .all()
    .catch(() => null);
  const stored: Record<string, string> = {};
  for (const r of rows?.results || []) {
    if (r && typeof r.field === "string" && typeof r.visibility === "string") {
      stored[r.field] = r.visibility;
    }
  }
  return effectiveVisibility(stored);
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

/** Validate an ISO date (YYYY-MM-DD): real calendar date, not in the future.
 * Used for milestone (achievement) dates. */
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

/** Achievements share one shape: {title, date, description}. */
export interface Milestone {
  title: string;
  date: string;
  description: string;
}

/** Validate a JSON list of achievements (D11: life events are gone). */
export function normalizeMilestones(
  raw: unknown
): { ok: boolean; error?: string; value?: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "" };
  let arr: any;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Achievements must be valid JSON." };
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return { ok: false, error: "Achievements must be a list." };
  if (arr.length > 10) return { ok: false, error: "Too many achievements (max 10)." };
  const out: Milestone[] = [];
  for (const e of arr) {
    if (typeof e !== "object" || !e) {
      return { ok: false, error: "Invalid achievement entry." };
    }
    const title = cleanStr(e.title, 100);
    const date = cleanStr(e.date, 10);
    const description = cleanStr(e.description, 300);
    if (!title && !description) continue; // skip empties
    if (!title) return { ok: false, error: "Achievements entries need a title." };
    if (date && !validPastDate(date)) {
      return { ok: false, error: "Achievement dates must be valid past dates (YYYY-MM-DD)." };
    }
    out.push({ title, date, description });
  }
  return { ok: true, value: JSON.stringify(out) };
}

/** Read the achievements column as a list of {title, date, description}. */
export function milestoneList(row: any): Milestone[] {
  if (!row?.achievements) return [];
  try {
    const arr = JSON.parse(row.achievements);
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

/** Columns selected for a full profile row (0010; 0016 achievements; D11
 * removed dob, gender, life_events, and profile_visibility is superseded by
 * the profile_field_visibility table). */
const PROFILE_COLUMNS = `id, email, name, role, status, display_name, bio,
  avatar_key, avatar_r2_key, show_profile, username, username_changed_at,
  location, website, social_links, work_history, education, hobbies,
  achievements, created_at`;

async function fetchProfileRow(DB: any, idOrUsername: string): Promise<any> {
  const id = cleanStr(idOrUsername, 64);
  return DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ? OR username = ?`
  )
    .bind(id, id.toLowerCase())
    .first();
}

/* ---------------- member_profiles and member_skills (0025) ----------------
 * New profile content lives in side tables, not users: building_now,
 * can_help_with, looking_for, pinned_post_id, directory_opt_in, and
 * activity_broadcast in member_profiles; curated skill tags in member_skills.
 * Skills reference the curated skill_tags list so the directory filter stays
 * clean; the trg_member_skills_max_12 trigger caps a member at 12. */

/** Curated skill tag: {slug, label}. */
export interface SkillTag {
  slug: string;
  label: string;
}

const SKILL_SLUG_RE = /^[a-z0-9-]{2,40}$/;
export const MAX_SKILLS = 12;

/** Normalize a raw skills value to a deduped slug list. Accepts an array of
 * strings, a JSON array string, or a comma-separated string. */
export function normalizeSkills(
  raw: unknown
): { ok: boolean; error?: string; value?: string[] } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: [] };
  let arr: string[];
  if (Array.isArray(raw)) {
    arr = raw.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
  } else if (typeof raw === "string") {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      arr = parsed.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
    } else {
      arr = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
  } else {
    return { ok: false, error: "Skills must be a list." };
  }
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const s of arr) {
    if (!SKILL_SLUG_RE.test(s)) {
      return { ok: false, error: `Invalid skill "${s}".` };
    }
    if (!seen.has(s)) {
      seen.add(s);
      slugs.push(s);
    }
  }
  if (slugs.length > MAX_SKILLS) {
    return { ok: false, error: `Too many skills (max ${MAX_SKILLS}).` };
  }
  return { ok: true, value: slugs };
}

/** Fetch the member_profiles row for a user (null when never set). */
async function fetchMemberProfileRow(DB: any, userId: string): Promise<any> {
  return DB.prepare(
    `SELECT user_id, building_now, can_help_with, looking_for, pinned_post_id,
            directory_opt_in, activity_broadcast, updated_at
     FROM member_profiles WHERE user_id = ?`
  )
    .bind(userId)
    .first()
    .catch(() => null);
}

/** Fetch a member's skills with labels: [{slug, label}]. */
export async function fetchMemberSkills(DB: any, userId: string): Promise<SkillTag[]> {
  const rows: any = await DB.prepare(
    `SELECT ms.skill_slug AS slug, st.label AS label
     FROM member_skills ms JOIN skill_tags st ON st.slug = ms.skill_slug
     WHERE ms.user_id = ? ORDER BY st.label`
  )
    .bind(userId)
    .all()
    .catch(() => null);
  return (rows?.results || [])
    .filter((r: any) => r && r.slug)
    .map((r: any) => ({ slug: r.slug, label: r.label || r.slug }));
}

/** Attach member_profiles fields and skills onto a users row for shaping.
 * Missing side rows leave the extras null/empty. */
async function attachProfileExtras(DB: any, row: any): Promise<void> {
  const mp = await fetchMemberProfileRow(DB, row.id);
  row.building_now = mp?.building_now ?? null;
  row.can_help_with = mp?.can_help_with ?? null;
  row.looking_for = mp?.looking_for ?? null;
  row.pinned_post_id = mp?.pinned_post_id ?? null;
  row.directory_opt_in = mp ? Number(mp.directory_opt_in) : 0;
  row.activity_broadcast = mp ? Number(mp.activity_broadcast) : 0;
  row.skills = await fetchMemberSkills(DB, row.id);
}

/** Build the API-facing profile for `rel` under visibility `vis`.
 * Owner/admin get everything (including email and the visibility map);
 * everyone else gets only the fields their relationship allows. Email and
 * real name NEVER leave the server for non-owner/non-admin viewers.
 * directory_opt_in and activity_broadcast are settings: owner/admin only. */
export function richProfileShape(
  row: any,
  rel: Relationship,
  vis?: Record<string, VisibilityLevel>
): any {
  const v = vis || { ...DEFAULT_VISIBILITY };
  const can = (field: string) => fieldVisible(field, v, rel);
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
  if (can("achievements")) user.achievements = milestoneList(row);
  if (can("building_now")) user.building_now = row.building_now || "";
  if (can("can_help_with")) user.can_help_with = row.can_help_with || "";
  if (can("looking_for")) user.looking_for = row.looking_for || "";
  if (can("skills")) user.skills = Array.isArray(row.skills) ? row.skills : [];
  if (can("projects") && row.pinned_post_id) user.pinned_post_id = row.pinned_post_id;
  if (rel === "owner" || rel === "admin") {
    user.email = row.email;
    user.name = row.name;
    user.role = row.role;
    user.status = row.status;
    user.show_profile = row.show_profile;
    user.username_changeable_at = usernameChangeableAt(row.username_changed_at);
    user.visibility = v;
    user.pinned_post_id = row.pinned_post_id || null;
    user.directory_opt_in = row.directory_opt_in ? 1 : 0;
    user.activity_broadcast = row.activity_broadcast ? 1 : 0;
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
 * (missing, private, and suspended targets all 404 for strangers).
 * Per-field visibility comes from profile_field_visibility; member_profiles
 * extras and skills ride along on the row. */
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
  const vis = await loadVisibility(c.env.DB, row.id);
  await attachProfileExtras(c.env.DB, row);
  return c.json({ ok: true, user: richProfileShape(row, rel, vis) });
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

/** GET /users/me - full own profile (private fields included; authenticated only).
 * Shape is the owner view of the rich profile engine. */
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
  const vis = await loadVisibility(c.env.DB, user!.id);
  await attachProfileExtras(c.env.DB, row);
  return c.json({ ok: true, user: richProfileShape(row, "owner", vis) });
});

/** ISO date when the user may next change their username (null = now). */
function usernameChangeableAt(changedAt: string | null): string | null {
  if (!changedAt) return null;
  const next = new Date(changedAt).getTime() + USERNAME_CHANGE_DAYS * 86400000;
  return next <= Date.now() ? null : new Date(next).toISOString();
}

/** PATCH /users/me - update display_name, bio, show_profile. */
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

/** POST /users/me/avatar - member avatar upload (5MB, images only).
 * Shared handler with POST /profiles/me/avatar. */
app.post("/users/me/avatar", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;
  return handleAvatarUpload(c, user!);
});

/* ---------------- Rich profiles (per-field visibility) ----------------
 * NOTE: /profiles/me is registered BEFORE /profiles/:id - Hono matches in
 * registration order, otherwise "me" would be treated as an id.
 */

/** GET /profiles/me - full own profile incl. member_profiles, skills, and the
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
  const vis = await loadVisibility(c.env.DB, user!.id);
  await attachProfileExtras(c.env.DB, row);
  return c.json({ ok: true, user: richProfileShape(row, "owner", vis) });
});

/** PATCH /profiles/me - rich-profile editor. Validates every field; username
 * changes stay on PATCH /users/me (30-day anti-squatting rule).
 *
 * D11: dob, gender, and life_events are rejected at the boundary. Sending a
 * value returns a 400 with a plain-words message instead of letting the 0025
 * trigger ABORT the save as a 500. Empty values are ignored (no write at all).
 *
 * Writes land in three places: users (identity/content columns), member_profiles
 * (builder fields), member_skills (curated tags), and profile_field_visibility
 * (the per-field map). One DB.batch keeps them atomic. */
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

  const fail = (error: string) => c.json({ ok: false, error }, 400);
  const D11_MSG = "Date of birth, gender, and life events are no longer collected.";

  // D11 boundary: never let a new value reach the 0025 trigger (which would
  // ABORT the save as a 500). Empty values are simply ignored.
  for (const k of ["dob", "gender"] as const) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return fail(D11_MSG);
  }
  {
    const v = body.life_events;
    const has =
      v !== undefined &&
      v !== null &&
      !(typeof v === "string" && v.trim() === "") &&
      !(Array.isArray(v) && v.length === 0);
    if (has) return fail(D11_MSG);
  }

  const updates: string[] = [];
  const binds: any[] = [];

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
  if (body.achievements !== undefined) {
    const v = normalizeMilestones(body.achievements);
    if (!v.ok) return fail(v.error!);
    updates.push("achievements = ?");
    binds.push(v.value);
  }

  // member_profiles fields (0025 side table).
  const mpCols: string[] = [];
  const mpBinds: any[] = [];
  const mpField = (key: string, col: string, max: number) => {
    if (body[key] !== undefined) {
      mpCols.push(col);
      mpBinds.push(cleanStr(body[key], max));
    }
  };
  mpField("building_now", "building_now", 140);
  mpField("can_help_with", "can_help_with", 280);
  mpField("looking_for", "looking_for", 280);
  for (const k of ["directory_opt_in", "activity_broadcast"] as const) {
    if (body[k] !== undefined) {
      mpCols.push(k);
      mpBinds.push(body[k] === 1 || body[k] === true ? 1 : 0);
    }
  }
  if (body.pinned_post_id !== undefined) {
    const pid = cleanStr(body.pinned_post_id, 64);
    if (pid) {
      // A pinned post must be the member's own live post.
      const post: any = await c.env.DB.prepare(
        `SELECT id FROM feed_posts
         WHERE id = ? AND author_id = ? AND status <> 'removed' AND deleted_at IS NULL`
      )
        .bind(pid, user!.id)
        .first();
      if (!post) return fail("Pinned post not found.");
      mpCols.push("pinned_post_id");
      mpBinds.push(pid);
    } else {
      mpCols.push("pinned_post_id");
      mpBinds.push(null);
    }
  }

  // member_skills: curated tags only (checked against skill_tags).
  let skillSlugs: string[] | null = null;
  if (body.skills !== undefined) {
    const v = normalizeSkills(body.skills);
    if (!v.ok) return fail(v.error!);
    skillSlugs = v.value!;
    if (skillSlugs.length) {
      const placeholders = skillSlugs.map(() => "?").join(", ");
      const known: any = await c.env.DB.prepare(
        `SELECT slug FROM skill_tags WHERE slug IN (${placeholders})`
      )
        .bind(...skillSlugs)
        .all();
      const knownSet = new Set((known?.results || []).map((r: any) => r.slug));
      const missing = skillSlugs.filter((s) => !knownSet.has(s));
      if (missing.length) return fail(`Unknown skill: ${missing[0]}.`);
    }
  }

  // Per-field visibility (profile_field_visibility is the source of truth).
  let visMap: Record<string, VisibilityLevel> | null = null;
  if (body.visibility !== undefined) {
    const v = validateVisibility(body.visibility);
    if (!v.ok) return fail(v.error!);
    visMap = v.value ? JSON.parse(v.value) : {};
  }

  // Fetch email for the audit log (never exposed to the client here).
  const me: any = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(user!.id)
    .first();

  const stmts: any[] = [];
  if (updates.length) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE users SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(...binds, user!.id)
    );
  }
  if (mpCols.length) {
    const cols = ["user_id", ...mpCols].join(", ");
    const marks = ["?", ...mpCols.map(() => "?")].join(", ");
    const setClauses = mpCols.map((col) => `${col} = excluded.${col}`).join(", ");
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO member_profiles (${cols}) VALUES (${marks})
         ON CONFLICT(user_id) DO UPDATE SET ${setClauses},
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).bind(user!.id, ...mpBinds)
    );
  }
  if (skillSlugs !== null) {
    stmts.push(c.env.DB.prepare("DELETE FROM member_skills WHERE user_id = ?").bind(user!.id));
    for (const slug of skillSlugs) {
      stmts.push(
        c.env.DB.prepare("INSERT INTO member_skills (user_id, skill_slug) VALUES (?, ?)").bind(
          user!.id,
          slug
        )
      );
    }
  }
  if (visMap !== null) {
    stmts.push(
      c.env.DB.prepare("DELETE FROM profile_field_visibility WHERE user_id = ?").bind(user!.id)
    );
    for (const [field, level] of Object.entries(visMap)) {
      stmts.push(
        c.env.DB.prepare(
          "INSERT INTO profile_field_visibility (user_id, field, visibility) VALUES (?, ?, ?)"
        ).bind(user!.id, field, level)
      );
    }
  }
  if (!stmts.length) {
    return fail("Nothing to update.");
  }

  await c.env.DB.batch(stmts);
  await audit(
    c,
    user!.id,
    me?.email || "unknown",
    "profile.rich.update",
    `fields: ${updates.length + mpCols.length}; skills: ${skillSlugs === null ? "unchanged" : skillSlugs.length}; visibility: ${visMap === null ? "unchanged" : Object.keys(visMap).length}; ip ${ip}`
  );

  return c.json({ ok: true });
});

/** POST /profiles/me/avatar - avatar upload; same rules as /users/me/avatar,
 * returns the canonical key and URL. */
app.post("/profiles/me/avatar", async (c) => {
  const user = await sessionUser(c);
  const no = needAuth(c, user);
  if (no) return no;
  return handleAvatarUpload(c, user!);
});

/** GET /profiles/:id - relationship-filtered profile view. Accepts a user id
 * OR a username handle. Server-side field filtering by the requester's
 * relationship and the profile's per-field visibility - only-me fields never
 * reach another viewer. Private and nonexistent ids both 404 (no enumeration). */
app.get("/profiles/:id", async (c) => {
  return profileView(c, c.req.param("id"));
});

/* ---------------- Public profile ---------------- */

/** GET /skill-tags - public; the curated skill tag list the editor offers.
 * Tags are curated (seeded) so the directory filter stays clean. */
app.get("/skill-tags", async (c) => {
  const rows: any = await c.env.DB.prepare(
    "SELECT slug, label FROM skill_tags ORDER BY label"
  )
    .all()
    .catch(() => null);
  const tags: SkillTag[] = (rows?.results || [])
    .filter((r: any) => r && r.slug)
    .map((r: any) => ({ slug: r.slug, label: r.label || r.slug }));
  return c.json({ ok: true, tags });
});

/** GET /users/public - minimal index of opted-in public profiles, for
 * build-time prerendering of /u/:id and /@username pages (OG tags).
 * Only show_profile=1 AND status='active'. No PII beyond id/username. */
app.get("/users/public", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, username FROM users WHERE show_profile = 1 AND status = 'active'`
  ).all();
  return c.json({ ok: true, users: (rows.results || []).filter((u: any) => u.id) });
});

/** GET /users/:id - public profile view. Delegates to the same
 * relationship-filtered engine as GET /profiles/:id so per-field visibility
 * is enforced on every surface: anonymous viewers see only public fields of
 * show_profile=1, active profiles. Never returns email, real name, or
 * only-me fields. Private and nonexistent ids both 404 (no enumeration). */
app.get("/users/:id", async (c) => {
  return profileView(c, c.req.param("id"));
});

/* ---------------- Admin ---------------- */

/** PATCH /admin/users/:id - role, status, display_name, show_profile override. Audit-logged. */
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
