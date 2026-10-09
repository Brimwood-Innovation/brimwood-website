/* Brimwood Studio API (Phase D3): first-party CMS backend.
 *
 * The WORKER commits content files to GitHub via the API using a server-side
 * token (GITHUB_CONTENT_TOKEN). Users authenticate with Brimwood password
 * auth (admin role) — no GitHub OAuth anywhere in this flow.
 *
 * All endpoints are admin-gated, audit-logged, and rate-limited.
 * If GITHUB_CONTENT_TOKEN is unset, endpoints return 500 "not configured".
 */
import { Hono } from "hono";
import { getAdminUser } from "../lib/auth";
import type { Bindings } from "../index";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { clientIp } from "../lib/validate";
import { checkContent } from "../lib/editorial";

const app = new Hono<{ Bindings: Bindings }>();

const REPO = "Brimwood-Innovation/brimwood-website";
const BRANCH = "develop";
const GH_API = "https://api.github.com";
const CONTENT_ROOT = "site/src/content/";
const MAX_CONTENT_BYTES = 500 * 1024; // 500 KB per file

/* --- Admin gate (same pattern as admin.ts) --- */



async function audit(c: any, admin: { id: string; email: string }, action: string, detail: string) {
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), admin.id, action, `${admin.email}: ${detail}`)
    .run()
    .catch(() => {});
}

async function rateLimited(c: any): Promise<boolean> {
  const ip = clientIp(c.req.raw);
  return !(await checkRateLimitD1(c.env.DB, "studio:" + ip, 30, 3600));
}

/* --- Path validation --- */

/** Allowlist: only Markdown/JSON files under site/src/content/. No traversal. */
export function validContentPath(p: unknown): p is string {
  if (typeof p !== "string" || !p) return false;
  if (p.includes("..") || p.includes("\\") || p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("~")) return false;
  if (!p.startsWith(CONTENT_ROOT)) return false;
  if (!(p.endsWith(".md") || p.endsWith(".json"))) return false;
  // No empty segments, no hidden trickery beyond the root check.
  const rest = p.slice(CONTENT_ROOT.length);
  if (!rest || rest.startsWith("/") || rest.includes("//")) return false;
  return true;
}

/** Directory allowlist for listing: must be at or under site/src/content/. */
export function validContentDir(d: unknown): d is string {
  if (typeof d !== "string" || !d) return false;
  if (d.includes("..") || d.includes("\\") || d.includes("\0")) return false;
  if (d.startsWith("/")) return false;
  const norm = d.endsWith("/") ? d : d + "/";
  if (!(norm === CONTENT_ROOT || norm.startsWith(CONTENT_ROOT))) return false;
  return true;
}

/* --- GitHub helpers --- */

function ghToken(c: any): string | null {
  return (c.env.GITHUB_CONTENT_TOKEN as string | undefined) || null;
}

async function ghFetch(c: any, url: string, init: RequestInit = {}): Promise<Response> {
  const token = ghToken(c);
  if (!token) throw new Error("not configured");
  return fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/** UTF-8-safe base64 encode (btoa alone mangles non-Latin1). */
export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** UTF-8-safe base64 decode. */
export function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* --- Routes --- */

/** GET /file?path= — read a content file from GitHub (develop branch). */
app.get("/file", async (c) => {
  const admin = await getAdminUser(c);
  if (!admin) return c.json({ ok: false, error: "Admin only." }, 403);
  if (await rateLimited(c)) return c.json({ ok: false, error: "Too many requests" }, 429);

  const path = c.req.query("path") || "";
  if (!validContentPath(path)) return c.json({ ok: false, error: "Invalid path" }, 400);
  if (!ghToken(c)) return c.json({ ok: false, error: "GitHub content token not configured" }, 500);

  let res: Response;
  try {
    res = await ghFetch(c, `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`);
  } catch (e: any) {
    if (e?.message === "not configured")
      return c.json({ ok: false, error: "GitHub content token not configured" }, 500);
    return c.json({ ok: false, error: "GitHub request failed" }, 502);
  }
  if (res.status === 404) return c.json({ ok: false, error: "Not found" }, 404);
  if (!res.ok) return c.json({ ok: false, error: "GitHub request failed" }, 502);
  const data = (await res.json()) as { content?: string; sha?: string; type?: string };
  if (data.type && data.type !== "file" || typeof data.content !== "string") {
    return c.json({ ok: false, error: "Not a file" }, 400);
  }
  await audit(c, admin!, "studio.file.read", path);
  return c.json({ ok: true, content: b64decode(data.content), sha: data.sha || null });
});

/** GET /list?dir= — list files under a content dir via the trees API. */
app.get("/list", async (c) => {
  const admin = await getAdminUser(c);
  if (!admin) return c.json({ ok: false, error: "Admin only." }, 403);
  if (await rateLimited(c)) return c.json({ ok: false, error: "Too many requests" }, 429);

  const dir = c.req.query("dir") || "";
  if (!validContentDir(dir)) return c.json({ ok: false, error: "Invalid dir" }, 400);
  if (!ghToken(c)) return c.json({ ok: false, error: "GitHub content token not configured" }, 500);

  const prefix = dir.endsWith("/") ? dir : dir + "/";
  let res: Response;
  try {
    res = await ghFetch(c, `${GH_API}/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
  } catch (e: any) {
    if (e?.message === "not configured")
      return c.json({ ok: false, error: "GitHub content token not configured" }, 500);
    return c.json({ ok: false, error: "GitHub request failed" }, 502);
  }
  if (!res.ok) return c.json({ ok: false, error: "GitHub request failed" }, 502);
  const data = (await res.json()) as { tree?: { path: string; type: string }[] };
  const files = (data.tree || [])
    .filter((t) => t.type === "blob" && t.path.startsWith(prefix))
    .filter((t) => t.path.endsWith(".md") || t.path.endsWith(".json"))
    .map((t) => ({ path: t.path, name: t.path.slice(prefix.length) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  await audit(c, admin!, "studio.dir.list", dir);
  return c.json({ ok: true, files });
});

/** POST /commit — {path, content, message} → commit to GitHub (develop). */
app.post("/commit", async (c) => {
  const admin = await getAdminUser(c);
  if (!admin) return c.json({ ok: false, error: "Admin only." }, 403);
  if (await rateLimited(c)) return c.json({ ok: false, error: "Too many requests" }, 429);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const path = body?.path;
  const content = body?.content;
  const message = typeof body?.message === "string" && body.message.trim()
    ? body.message.trim().slice(0, 200)
    : `studio: update ${typeof path === "string" ? path : "content"}`;

  if (!validContentPath(path)) return c.json({ ok: false, error: "Invalid path" }, 400);
  if (typeof content !== "string") return c.json({ ok: false, error: "Content must be a string" }, 400);
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) {
    return c.json({ ok: false, error: "Content too large (max 500 KB)" }, 400);
  }
  if (!ghToken(c)) return c.json({ ok: false, error: "GitHub content token not configured" }, 500);
  /* Editorial guardrails (server-side, same rules as Decap editorial.js):
   * Canadian spelling, banned hype/income phrases, member anonymity, SEO,
   * testimonial attribution. Studio must not bypass them. */
  const editorialIssues = checkContent(path, content);
  if (editorialIssues.length > 0) {
    return c.json({ ok: false, error: "Editorial checks failed", issues: editorialIssues }, 422);
  }

  try {
    // Fetch current SHA for updates (409-conflict-safe). 404 = new file.
    let sha: string | undefined;
    const cur = await ghFetch(
      c,
      `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`
    );
    if (cur.ok) {
      const curData = (await cur.json()) as { sha?: string };
      sha = curData.sha;
    } else if (cur.status !== 404) {
      return c.json({ ok: false, error: "GitHub request failed" }, 502);
    }

    const putBody: Record<string, unknown> = {
      message,
      content: b64encode(content),
      branch: BRANCH,
      committer: { name: "Brimwood Studio", email: "studio@brimwoodinnovation.com" },
    };
    if (sha) putBody.sha = sha;

    const put = await ghFetch(c, `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify(putBody),
    });
    if (!put.ok) {
      return c.json({ ok: false, error: "GitHub commit failed", status: put.status }, 502);
    }
    const putData = (await put.json()) as { commit?: { sha?: string } };
    await audit(c, admin!, "studio.commit", `${path} :: ${message}`);
    return c.json({ ok: true, commitSha: putData.commit?.sha || null });
  } catch (e: any) {
    if (e?.message === "not configured")
      return c.json({ ok: false, error: "GitHub content token not configured" }, 500);
    return c.json({ ok: false, error: "GitHub request failed" }, 502);
  }
});

export default app;
