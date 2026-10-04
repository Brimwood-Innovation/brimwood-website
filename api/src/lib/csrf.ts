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
 * NOTE: the SameSite=None cookie branch in auth.ts / password.ts is kept
 * until F3 (same-origin API). Removing it now would break cookie auth on
 * preview deployments, which call the worker cross-origin. This middleware
 * is the actual CSRF defence; the cookie change follows in F3.
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
      if (!isJson && !isMultipart) {
        return c.json(
          { ok: false, error: "Content-Type must be application/json." },
          403
        );
      }
    }
  }

  await next();
}
