/**
 * Render-time scheme allowlist for member-supplied external links
 * (Phase 5 slice 7), the server-rendered twin of the client canonical
 * helpers in site/public/js/safe-url.js.
 *
 * The API already restricts website and social links to http(s) at write
 * time, but render must not trust stored rows: a legacy row, or a future
 * write path that skips validation, could carry a javascript: value, and
 * Astro escapes attribute expressions without stripping schemes, so such
 * a value would execute on click (target _blank with rel noopener does
 * not stop a javascript: href). Returns the cleaned value when it parses
 * as http(s), else null; the caller renders plain text instead of a link.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const clean = value
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (!clean) return null;
  try {
    const u = new URL(clean);
    return u.protocol === "http:" || u.protocol === "https:" ? clean : null;
  } catch {
    return null;
  }
}
