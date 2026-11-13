/* Server-side editorial guardrails: parity with Decap editorial.js. */
import { describe, it, expect } from "vitest";
import {
  checkSpelling,
  checkBanned,
  checkAnonymity,
  checkAttribution,
  checkSEO,
  parseFrontmatter,
  checkContent,
} from "./editorial";

const BLOG = "site/src/content/blog/hello.md";

function blogPost(over: Record<string, string> = {}, body = "Why build in public? " + "x".repeat(400)): string {
  const fm = {
    title: "A solid post about building",
    description: "A short summary for the cards.",
    ...over,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: "${v}"`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

describe("checkSpelling", () => {
  it("flags US spellings", () => {
    const issues = checkSpelling("We optimize and organize our favorite color center.");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toContain("optimise");
  });
  it("passes Canadian spellings", () => {
    expect(checkSpelling("We optimise and organise our favourite colour centre.")).toEqual([]);
  });
});

describe("checkBanned", () => {
  it("flags hype and income promises", () => {
    const issues = checkBanned("Get rich with 10x passive income. Make $5,000 per month! Quit your job.");
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
  it("passes clean copy", () => {
    expect(checkBanned("Build a business. Build yourself.")).toEqual([]);
  });
});

describe("checkAnonymity", () => {
  it("flags possible real names", () => {
    const issues = checkAnonymity("John Smith built his first app with us.");
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("John Smith");
  });
  it("ignores brand phrases", () => {
    expect(checkAnonymity("Brimwood Innovation. Build a business. Elite by effort.")).toEqual([]);
  });
});

describe("checkAttribution", () => {
  it("blocks full names", () => {
    expect(checkAttribution("John Smith").length).toBe(1);
  });
  it("allows initials + role", () => {
    expect(checkAttribution("J., builder since 2026")).toEqual([]);
    expect(checkAttribution("")).toEqual([]);
  });
});

describe("checkSEO", () => {
  it("flags thin content and missing excerpt", () => {
    const issues = checkSEO({ title: "Short", excerpt: "", body: "tiny" });
    expect(issues.join(" ")).toContain("Title too short");
    expect(issues.join(" ")).toContain("Missing excerpt");
    expect(issues.join(" ")).toContain("thin content");
  });
  it("passes a solid post", () => {
    const issues = checkSEO({
      title: "A solid post about building",
      excerpt: "A short summary for the cards.",
      body: "Why build in public? " + "x".repeat(400),
    });
    expect(issues).toEqual([]);
  });
});

describe("parseFrontmatter", () => {
  it("extracts flat fields and body", () => {
    const p = parseFrontmatter('---\ntitle: "Hello"\ndraft: false\n---\n\nBody here.');
    expect(p.fields.title).toBe("Hello");
    expect(p.body.trim()).toBe("Body here.");
  });
  it("returns whole text as body without frontmatter", () => {
    const p = parseFrontmatter('{"a":1}');
    expect(p.fields).toEqual({});
    expect(p.body).toBe('{"a":1}');
  });
});

describe("checkContent", () => {
  it("passes a clean blog post", () => {
    expect(checkContent(BLOG, blogPost())).toEqual([]);
  });
  it("blocks hype in a blog post", () => {
    const issues = checkContent(BLOG, blogPost({}, "Get rich with 10x passive income. " + "x".repeat(400)));
    expect(issues.some((i) => i.includes("Banned phrase"))).toBe(true);
  });
  it("blocks US spelling in a blog post", () => {
    const issues = checkContent(BLOG, blogPost({}, "We optimize everything we do. " + "x".repeat(400)));
    expect(issues.some((i) => i.includes("Canadian spelling"))).toBe(true);
  });
  it("blocks real names in a blog post", () => {
    const issues = checkContent(BLOG, blogPost({}, "John Smith built this. " + "x".repeat(400)));
    expect(issues.some((i) => i.includes("real names"))).toBe(true);
  });
  it("blocks full-name testimonial attribution", () => {
    const content = '---\nquote: "Great place."\nattribution: "John Smith"\n---\n';
    const issues = checkContent("site/src/content/testimonials/a.md", content);
    expect(issues.some((i) => i.includes("full name"))).toBe(true);
  });
  it("allows initials testimonial attribution", () => {
    const content = '---\nquote: "Great place."\nattribution: "J., builder since 2026"\n---\n';
    expect(checkContent("site/src/content/testimonials/a.md", content)).toEqual([]);
  });
  it("checks spelling and banned phrases on JSON settings files", () => {
    const issues = checkContent(
      "site/src/content/settings.json",
      JSON.stringify({ hero_headline: "Get rich with 10x passive income" })
    );
    expect(issues.some((i) => i.includes("Banned phrase"))).toBe(true);
  });
  it("does not run SEO checks on settings files", () => {
    expect(checkContent("site/src/content/settings.json", JSON.stringify({ a: "b" }))).toEqual([]);
  });
});
