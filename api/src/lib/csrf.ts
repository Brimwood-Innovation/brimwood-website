/* CSRF protection (F5 follow-up: F4). One middleware for every mutating route.
 *
 * Two independent checks:
 * 1. Origin: browsers send Origin on mutating requests. If present, it must
 *    be one of ours. Non-browser clients (GitHub Actions, curl) send no
 *    Origin and are not vulnerable to CSRF, so a missing Origin is allowed.
 * 2. Content-Type: Hono's c.req.json() parses the body without checking the
 *    content type, so a cross-site text/plain form would be accepted. Mutating
 *    requests with a body must declare application/json, except multipart
 *    uploads (admin media library), which remain protected by the Origin
 *    check above.
 *
 * NOTE (audit/security-ci): the old SameSite=None cookie branches were removed
 * in F3 — the site calls the API same-origin, so session cookies are now
 * `__Host-` + `SameSite=Lax` only (see api/src/lib/auth.ts). This middleware
 * remains the CSRF defence for every mutating route.
 */

const EXACT_ORIGINS = [
  "https://brimwoodinnovation.com",
  "https://www.brimwoodinnovation.com",
  "https://brimwood-website-preview.pages.dev",
];

/* Branch previews: https://<branch>.brimwood-website-preview.pages.dev */
const SUFFIX_ORIGINS = [".brimwood-website-preview.pages.dev"];

export function isAllowedOrigin(origin: string): boolean {
  if (EXACT_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    return SUFFIX_ORIGINS.some((s) => url.hostname.endsWith(s));
  } catch {
    return false;
  }
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export async function csrfGuard(c: any, next: any) {
  if (!MUTATING.has(c.req.method)) {
    await next();
    return;
  }

  const origin = c.req.header("origin");
  if (origin && !isAllowedOrigin(origin)) {
    return c.json({ ok: false, error: "Forbidden origin." }, 403);
  }

  // DELETE typically has no body; POST/PATCH/PUT with a body must be JSON
  // (or multipart for the admin media upload).
  if (c.req.method !== "DELETE") {
    const ct = (c.req.header("content-type") || "").toLowerCase();
    const len = parseInt(c.req.header("content-length") || "0", 10) || 0;
    if (len > 0 || ct) {
      const isJson = ct.includes("application/json");
      const isMultipart = ct.includes("multipart/form-data");
      // RFC 8058 one-click unsubscribe: mailbox providers POST
      // `List-Unsubscribe=One-Click` as application/x-www-form-urlencoded
      // with no Origin header. Narrow exemption for exactly this path —
      // the Origin check above still applies when an Origin is present,
      // and the endpoint only acts on an unguessable per-recipient token.
      const isOneClickUnsub =
        c.req.method === "POST" &&
        c.req.path === "/api/newsletter/unsubscribe" &&
        ct.includes("application/x-www-form-urlencoded");
      if (!isJson && !isMultipart && !isOneClickUnsub) {
        return c.json(
          { ok: false, error: "Content-Type must be application/json." },
          403
        );
      }
    }
  }

  await next();
}
