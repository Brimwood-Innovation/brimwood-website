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

export const collections = { blog };
