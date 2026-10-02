/* RSS feed (T10). Hand-written XML: no extra dependency, C$0. */
import { getCollection } from "astro:content";

export async function GET() {
  const posts = (await getCollection("blog"))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.publishDate.valueOf() - a.data.publishDate.valueOf());

  const items = posts
    .map(
      (p) => `    <item>
      <title><![CDATA[${p.data.title}]]></title>
      <link>https://brimwoodinnovation.com/blog/${p.slug}/</link>
      <guid>https://brimwoodinnovation.com/blog/${p.slug}/</guid>
      <pubDate>${p.data.publishDate.toUTCString()}</pubDate>
      <description><![CDATA[${p.data.description}]]></description>
    </item>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Brimwood Innovation — Blog</title>
    <link>https://brimwoodinnovation.com/blog/</link>
    <description>Notes on micro business, AI in practice, and the owner mindset.</description>
    <language>en-ca</language>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
