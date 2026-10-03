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

export const collections = { blog, testimonials };
