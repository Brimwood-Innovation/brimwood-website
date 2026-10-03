/* Build-time index of published CMS pages for client-side search.
 * The /search page fetches this and merges it with /api/search results. */
import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  const pages = await getCollection("pages", ({ data }) => !data.draft);
  const index = pages.map((p) => ({
    type: "page",
    title: p.data.title,
    slug: p.data.slug,
    excerpt: p.data.excerpt || "",
  }));
  return new Response(JSON.stringify({ pages: index }), {
    headers: { "content-type": "application/json" },
  });
};
