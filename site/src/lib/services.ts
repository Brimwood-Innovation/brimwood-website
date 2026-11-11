/* Services helpers (redesign T9, spec sections 4.1, 4.3, 4.4, 8).
 * Shared by the services index, pillar, and detail templates so the
 * pillar order, tier order, URLs, and JSON-LD are defined once and
 * can never drift between pages. Pillar statements are facts only:
 * what the pillar covers, written for answer engines (spec 8). */

export type PillarSlug = "build" | "automate" | "grow" | "create" | "guide";

export interface PillarInfo {
  slug: PillarSlug;
  name: string;
  statement: string;
  lede: string;
}

export const PILLARS: PillarInfo[] = [
  {
    slug: "build",
    name: "Build",
    statement:
      "Build is Brimwood Innovation's website and software pillar: websites and lead engines, web development, and custom software and tools for businesses in Toronto and the GTA.",
    lede: "Websites, lead engines, and the custom software your business runs on.",
  },
  {
    slug: "automate",
    name: "Automate",
    statement:
      "Automate is Brimwood Innovation's automation pillar: custom automation built with AI and workflow tooling, and conversational AI agents that answer, book, and capture enquiries.",
    lede: "The repetitive work in your business, connected and run reliably.",
  },
  {
    slug: "grow",
    name: "Grow",
    statement:
      "Grow is Brimwood Innovation's visibility and leads pillar: search and AI visibility, paid ads management and creative, warm-lead capture, and local community growth.",
    lede: "Be found, capture the interest, and follow it up properly.",
  },
  {
    slug: "create",
    name: "Create",
    statement:
      "Create is Brimwood Innovation's content and media pillar: social media support, brand film, broadcast commercials, animation and explainers, graphic design, and content day shoots.",
    lede: "Content, film, and design that carry the brand, month after month.",
  },
  {
    slug: "guide",
    name: "Guide",
    statement:
      "Guide is Brimwood Innovation's planning pillar: founder consultancy and planning, and design, build, and strategy engagements that tie design and build work to a growth plan.",
    lede: "Decide what to build, in what order, and what to skip.",
  },
];

export const pillarInfo = (slug: string): PillarInfo =>
  PILLARS.find((p) => p.slug === slug) ?? PILLARS[0];

export const pillarOrder = (slug: string): number =>
  PILLARS.findIndex((p) => p.slug === slug);

/* Entry ids in the services collection are the file names; the slug
 * is the id without the .md suffix (same pattern as the blog). */
export const serviceSlug = (id: string): string => id.replace(/\.md$/, "");

export const servicePath = (pillar: string, slug: string): string =>
  `/services/${pillar}/${slug}/`;

/* Services inside a pillar, grouped by tier in taxonomy order.
 * Tiers sort by their code (B1 before B2); services inside a tier
 * sort by their order field. */
export function groupByTier<T extends { data: { tier: { code: string; label: string }; order: number } }>(
  entries: T[],
): { code: string; label: string; entries: T[] }[] {
  const tiers = new Map<string, { code: string; label: string; entries: T[] }>();
  for (const entry of entries) {
    const { code, label } = entry.data.tier;
    if (!tiers.has(code)) tiers.set(code, { code, label, entries: [] });
    tiers.get(code)!.entries.push(entry);
  }
  return [...tiers.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((tier) => ({
      ...tier,
      entries: tier.entries.sort((a, b) => a.data.order - b.data.order),
    }));
}

export const SITE = "https://brimwoodinnovation.com";

export const organizationRef = {
  "@type": "Organization",
  name: "Brimwood Innovation",
  url: SITE,
  address: {
    "@type": "PostalAddress",
    streetAddress: "1365 Gerrard St E, Unit 2",
    addressLocality: "Toronto",
    addressRegion: "ON",
    addressCountry: "CA",
  },
};

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE}${item.path}`,
    })),
  };
}

export function itemListJsonLd<T extends { data: { name: string; pillar: string }; id: string }>(
  entries: T[],
) {
  return {
    "@type": "ItemList",
    itemListElement: entries.map((entry, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: entry.data.name,
      url: `${SITE}${servicePath(entry.data.pillar, serviceSlug(entry.id))}`,
    })),
  };
}
