/* Server-side editorial guardrails (admin-cms audit).
 *
 * Port of the Decap browser checks in site/public/cms/editorial.js, enforced
 * on POST /api/studio/commit so Studio saves cannot bypass them. Rules are
 * identical: Canadian spelling + banned hype/income phrases on all text,
 * member-anonymity + SEO checklist for blog/pages, initials-only attribution
 * for testimonials. Returns a list of issue strings; empty means publishable.
 */
const US_TO_CA: Record<string, string> = {
  customize: "customise",
  optimize: "optimise",
  center: "centre",
  favorite: "favourite",
  color: "colour",
  behavior: "behaviour",
  organize: "organise",
  recognize: "recognise",
};

const BANNED: RegExp[] = [
  /\b10x\b/i,
  /\bguaranteed income\b/i,
  /\bget rich\b/i,
  /\bpassive income\b/i,
  /\bmake \$[\d,]+ (a|per) (month|week|day)\b/i,
  /\bquit your job\b/i,
  /\bcompetitor\b/i,
];

/* Heuristic: capitalised First Last pairs in body text. */
const NAME_PATTERN = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;
/* Brand phrases that legitimately match the name pattern. */
const NAME_ALLOWLIST = ["Brimwood", "Build", "Elite"];

export function checkSpelling(text: string): string[] {
  const issues: string[] = [];
  for (const [us, ca] of Object.entries(US_TO_CA)) {
    if (new RegExp(`\\b${us}\\b`, "gi").test(text)) {
      issues.push(`Use Canadian spelling: "${ca}" not "${us}".`);
    }
  }
  return issues;
}

export function checkBanned(text: string): string[] {
  const issues: string[] = [];
  for (const re of BANNED) {
    if (re.test(text)) {
      issues.push(`Banned phrase detected: ${re.source}. Remove hype or income promises.`);
    }
  }
  return issues;
}

export function checkAnonymity(text: string): string[] {
  const names = text.match(NAME_PATTERN) || [];
  const flagged = names.filter((n) => !NAME_ALLOWLIST.some((w) => n.includes(w)));
  if (flagged.length > 0) {
    const shown = [...new Set(flagged)].slice(0, 3).join(", ");
    return [
      `Possible real names detected: ${shown}. Members are anonymous by default - confirm written permission.`,
    ];
  }
  return [];
}

/** Testimonial attribution must never be a full name: initials + role only. */
export function checkAttribution(attribution: string): string[] {
  const value = (attribution || "").trim();
  if (!value) return [];
  const names = value.match(NAME_PATTERN) || [];
  if (names.length > 0) {
    return [
      `Attribution looks like a full name: "${names[0]}". Use initials + role only (e.g. "M., builder since 2026") - members are anonymous by default.`,
    ];
  }
  return [];
}

export interface SeoFields {
  title: string;
  excerpt: string;
  body: string;
}

export function checkSEO(f: SeoFields): string[] {
  const issues: string[] = [];
  if (f.title.length > 60) issues.push("Title over 60 characters - will truncate in search results.");
  if (f.title.length < 10) issues.push("Title too short for SEO.");
  if (!f.excerpt) issues.push("Missing excerpt - required for SEO and social cards.");
  if (f.excerpt.length > 160) issues.push("Excerpt over 160 characters.");
  if (f.body.length < 300) issues.push("Body under 300 characters - thin content hurts SEO.");
  if (!/\?/.test(f.body) && f.body.length > 500) {
    issues.push("Consider adding a question the post answers (AEO/featured snippets).");
  }
  return issues;
}

/* Minimal frontmatter parse: flat `key: value` lines only, enough for the
 * SEO fields. Unknown/nested structure is left in `rest` untouched. */
export interface ParsedContent {
  fields: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedContent {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[kv[1]] = val;
  }
  return { fields, body: m[2] };
}

type Collection = "blog" | "pages" | "testimonials" | "other";

function collectionForPath(path: string): Collection {
  if (path.startsWith("site/src/content/blog/")) return "blog";
  if (path.startsWith("site/src/content/pages/")) return "pages";
  if (path.startsWith("site/src/content/testimonials/")) return "testimonials";
  return "other";
}

/** Run every applicable editorial check for a content file. Empty = clean. */
export function checkContent(path: string, content: string): string[] {
  const collection = collectionForPath(path);
  const issues: string[] = [...checkSpelling(content), ...checkBanned(content)];

  if (collection === "blog" || collection === "pages") {
    const { fields, body } = parseFrontmatter(content);
    issues.push(...checkAnonymity(content));
    issues.push(
      ...checkSEO({
        title: fields.title || "",
        // Content model uses `description` for blog; Decap legacy used `excerpt`.
        excerpt: fields.description || fields.excerpt || "",
        body,
      })
    );
  }
  if (collection === "testimonials") {
    const { fields } = parseFrontmatter(content);
    issues.push(...checkAttribution(fields.attribution || ""));
  }
  return issues;
}
