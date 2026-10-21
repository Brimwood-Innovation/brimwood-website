/* sitemap.xml (T13, audit/site). Static routes + published blog posts +
 * published event detail pages (best-effort from the API at build time).
 * Drafts are never listed. Other agents add their own routes here
 * (/members, /dashboard, /wall) when those pages are public. */
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

  const url = (loc, lastmod) =>
    `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;

  const urls = [
    ...staticRoutes.map((r) => url(`${SITE}${r || "/"}`, today)),
    ...posts.map((p) =>
      url(`${SITE}/blog/${p.id.replace(/\.md$/, "")}/`, p.data.publishDate.toISOString().slice(0, 10))
    ),
    ...eventSlugs.map((s) => url(`${SITE}/events/${s}/`, today)),
  ].join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
