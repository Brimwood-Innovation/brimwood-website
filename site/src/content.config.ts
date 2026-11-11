import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/* Blog collection (T10). Pillars double as categories per report §7.3.
 * draft: true = seed copy awaiting founder approval; rendered with a badge. */
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishDate: z.coerce.date(),
    /* Optional. The article view shows a Last updated date (v5 deck);
     * it falls back to the publish date when a post has not been revised. */
    updatedDate: z.coerce.date().optional(),
    pillar: z.enum(["micro-business", "ai-in-practice", "owner-mindset", "members-hub"]),
    tags: z.array(z.string()).default([]),
    author: z.string().default("Brimwood Team"),
    draft: z.boolean().default(false),
  }),
});

/* Testimonials collection (Phase B). Members anonymous by default:
 * attribution uses initials + role only, never full names. */
const testimonials = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/testimonials" }),
  schema: z.object({
    quote: z.string(),
    attribution: z.string(),
    role: z.string().default(""),
    featured: z.boolean().default(false),
    date: z.coerce.date(),
  }),
});

/* CMS pages collection (Phase A Decap "Pages", wired in site integration).
 * draft: true = hidden until the founder approves. slug = top-level URL path. */
const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/pages" }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    excerpt: z.string().default(""),
    draft: z.boolean().default(true),
  }),
});

/* Services collection (redesign spec section 6, task T7). One file per
 * public service line, 17 lines. The markdown body is the overview field.
 * Wording mirrors Service Catalogue 23.09.01 v1.2 (2026-11-10, FINAL);
 * the catalogue is the source of truth and site files are its mirror.
 * Nothing renders these entries yet; routes land in task T9. */
const services = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/services" }),
  schema: z.object({
    name: z.string(),
    pillar: z.enum(["build", "automate", "grow", "create", "guide"]),
    tier: z.object({
      code: z.string(),
      label: z.string(),
    }),
    order: z.number().int().positive(),
    lead: z.boolean().default(false),
    deliverables: z.array(z.string()).min(1),
    steps: z
      .array(
        z.object({
          title: z.string(),
          text: z.string(),
        }),
      )
      .length(5),
    entryOffer: z.string(),
    related: z.array(z.string()).min(2).max(3),
    faqs: z
      .array(
        z.object({
          question: z.string(),
          answer: z.string(),
        }),
      )
      .min(3),
    seoTitle: z.string(),
    seoDescription: z.string(),
  }),
});

export const collections = { blog, testimonials, pages, services };
