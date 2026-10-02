/* sitemap.xml (T13). Static routes + blog posts from the content collection. */
import { getCollection } from "astro:content";

const SITE = "https://brimwoodinnovation.com";

export async function GET() {
  const staticRoutes = ["", "/about", "/blog", "/newsletter", "/privacy", "/terms"];
  const posts = await getCollection("blog");

  const urls = [
    ...staticRoutes.map((r) => `  <url><loc>${SITE}${r || "/"}</loc></url>`),
    ...posts.map((p) => `  <url><loc>${SITE}/blog/${p.id.replace(/\.md$/, "")}/</loc></url>`),
  ].join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
