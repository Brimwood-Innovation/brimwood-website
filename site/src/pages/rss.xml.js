/* RSS feed (T10). Hand-written XML: no extra dependency, C$0. */
import { getCollection } from "astro:content";

export async function GET() {
  const posts = (await getCollection("blog"))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.publishDate.valueOf() - a.data.publishDate.valueOf());

  const slugOf = (p) => p.id.replace(/\.md$/, "");

  const items = posts
    .map(
      (p) => `    <item>
      <title><![CDATA[${p.data.title}]]></title>
      <link>https://brimwoodinnovation.com/blog/${slugOf(p)}/</link>
      <guid isPermaLink="true">https://brimwoodinnovation.com/blog/${slugOf(p)}/</guid>
      <pubDate>${p.data.publishDate.toUTCString()}</pubDate>
      <description><![CDATA[${p.data.description}]]></description>
    </item>`
    )
    .join("\n");

  const lastBuild = posts.length
    ? posts[0].data.publishDate.toUTCString()
    : new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Brimwood Innovation — Blog</title>
    <link>https://brimwoodinnovation.com/blog/</link>
    <atom:link href="https://brimwoodinnovation.com/rss.xml" rel="self" type="application/rss+xml" />
    <description>Notes on micro business, AI in practice, and the owner mindset.</description>
    <language>en-ca</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
