/* sitemap.xml (T13, audit/site). Static routes + published blog posts +
 * published event detail pages + public certificate pages (both fetched
 * best-effort from the API at build time). Drafts are never listed, and
 * only valid, public certificates are listed: the certificates endpoint
 * filters server-side, so a private, link, or no-longer-valid
 * certificate never appears here. Other agents add their own routes
 * here (/members, /dashboard, /wall) when those pages are public. */
import { getCollection } from "astro:content";

const SITE = "https://brimwoodinnovation.com";

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  const staticRoutes = ["", "/about", "/blog", "/newsletter", "/academy", "/privacy", "/terms", "/events", "/invite", "/search"];
  const posts = await getCollection("blog", ({ data }) => !data.draft);

  // Event detail URLs: fetched at build time; the sitemap must never fail
  // the build if the API is unreachable.
  let eventSlugs = [];
  try {
    const apiBase = import.meta.env.PUBLIC_API_BASE || "";
    const r = await fetch(apiBase + "/api/events", { headers: { accept: "application/json" } });
    const d = await r.json();
    if (d.ok && Array.isArray(d.events)) {
      eventSlugs = d.events.map((e) => e.slug).filter(Boolean);
    }
  } catch {}

  // Public certificate URLs (/c/CODE): fetched at build time, in the
  // same best-effort pattern as events, so a newly public certificate
  // enters the sitemap on the next site build, never in real time.
  // The URL matches the canonical the check page sets for a public
  // certificate (no trailing slash). lastmod is the issue date.
  let certEntries = [];
  try {
    const apiBase = import.meta.env.PUBLIC_API_BASE || "";
    const r = await fetch(apiBase + "/api/certificates/public", { headers: { accept: "application/json" } });
    const d = await r.json();
    if (d.ok && Array.isArray(d.certificates)) {
      certEntries = d.certificates
        .filter((e) => e && e.code)
        .map((e) => ({
          code: e.code,
          lastmod: typeof e.issued_at === "string" ? e.issued_at.slice(0, 10) : null,
        }));
    }
  } catch {}

  const url = (loc, lastmod) =>
    `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;

  const urls = [
    ...staticRoutes.map((r) => url(`${SITE}${r || "/"}`, today)),
    ...posts.map((p) =>
      url(`${SITE}/blog/${p.id.replace(/\.md$/, "")}/`, p.data.publishDate.toISOString().slice(0, 10))
    ),
    ...eventSlugs.map((s) => url(`${SITE}/events/${s}/`, today)),
    ...certEntries.map((e) => url(`${SITE}/c/${e.code}`, e.lastmod || today)),
  ].join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
