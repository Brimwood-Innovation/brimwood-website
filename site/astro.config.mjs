import { defineConfig } from "astro/config";

// Static-first. No adapter: `astro build` emits dist/ which Cloudflare
// Pages serves directly. If a route ever needs edge SSR, add
// @astrojs/cloudflare then — not before.
export default defineConfig({
  site: "https://brimwoodinnovation.com",
});
