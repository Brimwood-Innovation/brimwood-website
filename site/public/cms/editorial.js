/* Editorial guardrails for Decap CMS (T27, expanded Phase A, testimonials Phase B).
 * Client-side pre-publish checks: Canadian spelling, banned phrases,
 * member anonymity, SEO checklist.
 *
 * Checks apply to every collection:
 * - Spelling + banned phrases: ALL text in every entry (blog, courses,
 *   pages, settings, navigation, homepage, testimonials).
 * - Anonymity + SEO checklist: blog and pages (the long-form collections
 *   with title / excerpt / body).
 * - Attribution anonymity: testimonials (the attribution field must never
 *   be a full name — initials + role only).
 *
 * Loaded by /cms page after Decap initializes.
 */
(function () {
  if (typeof CMS === "undefined") return;

  // Canadian spelling: common US → CA mappings to flag.
  const US_TO_CA = {
    "customize": "customise",
    "optimize": "optimise",
    "center": "centre",
    "favorite": "favourite",
    "color": "colour",
    "behavior": "behaviour",
    "organize": "organise",
    "recognize": "recognise",
  };

  // Banned: hype, income promises, competitor criticism.
  const BANNED = [
    /\b10x\b/i,
    /\bguaranteed income\b/i,
    /\bget rich\b/i,
    /\bpassive income\b/i,
    /\bmake \$[\d,]+ (a|per) (month|week|day)\b/i,
    /\bquit your job\b/i,
    /\bcompetitor\b/i,
  ];

  // Member anonymity: flag potential real names in member stories.
  // (Heuristic: capitalised First Last pairs in body text.)
  const NAME_PATTERN = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;

  function checkSpelling(text) {
    const issues = [];
    for (const [us, ca] of Object.entries(US_TO_CA)) {
      const re = new RegExp(`\\b${us}\\b`, "gi");
      if (re.test(text)) issues.push(`Use Canadian spelling: "${ca}" not "${us}".`);
    }
    return issues;
  }

  function checkBanned(text) {
    const issues = [];
    for (const re of BANNED) {
      if (re.test(text)) issues.push(`Banned phrase detected: ${re.source}. Remove hype or income promises.`);
    }
    return issues;
  }

  function checkAnonymity(text) {
    // Only flag if the post is tagged as a member story.
    const names = text.match(NAME_PATTERN) || [];
    const common = ["Brimwood Innovation", "Build Yourself", "Elite By"];
    const flagged = names.filter((n) => !common.some((c) => n.includes(c.split(" ")[0])));
    if (flagged.length > 0) {
      return [`Possible real names detected: ${[...new Set(flagged)].slice(0, 3).join(", ")}. Members are anonymous by default — confirm written permission.`];
    }
    return [];
  }

  // Testimonials: the attribution field must never be a full name.
  // Members are anonymous by default — initials + role only.
  function checkAttribution(attribution) {
    const value = (attribution || "").trim();
    if (!value) return [];
    const names = value.match(NAME_PATTERN) || [];
    if (names.length > 0) {
      return [`Attribution looks like a full name: "${names[0]}". Use initials + role only (e.g. "M., builder since 2026") — members are anonymous by default.`];
    }
    return [];
  }

  function checkSEO(entry) {
    const issues = [];
    const title = entry.getIn(["data", "title"]) || "";
    // Content model uses `description` for blog; accept legacy `excerpt` too.
    const excerpt = entry.getIn(["data", "description"]) || entry.getIn(["data", "excerpt"]) || "";
    const body = entry.getIn(["data", "body"]) || "";
    if (title.length > 60) issues.push("Title over 60 characters — will truncate in search results.");
    if (title.length < 10) issues.push("Title too short for SEO.");
    if (!excerpt) issues.push("Missing excerpt — required for SEO and social cards.");
    if (excerpt.length > 160) issues.push("Excerpt over 160 characters.");
    if (body.length < 300) issues.push("Body under 300 characters — thin content hurts SEO.");
    // AEO: check for a clear question/answer structure.
    if (!/\?/.test(body) && body.length > 500) {
      issues.push("Consider adding a question the post answers (AEO/featured snippets).");
    }
    return issues;
  }

  // Collections whose entries get the full SEO + anonymity checklist
  // (long-form content with title / excerpt / body).
  const SEO_COLLECTIONS = ["blog", "pages"];

  // Recursively collect every string value from the entry's data, so the
  // spelling and banned-phrase checks cover pages, settings, navigation,
  // and homepage fields — not just blog title/body.
  function collectText(entry) {
    const data = entry.getIn(["data"]);
    const plain = data && typeof data.toJS === "function" ? data.toJS() : {};
    const parts = [];
    (function walk(v) {
      if (typeof v === "string") {
        if (v.trim()) parts.push(v);
      } else if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === "object") {
        Object.values(v).forEach(walk);
      }
    })(plain);
    return parts.join("\n");
  }

  // Register a pre-publish check.
  CMS.registerEventListener({
    name: "prePublish",
    handler: ({ entry }) => {
      const collection = entry.get("collection") || "";
      const text = collectText(entry);
      const issues = [
        ...checkSpelling(text),
        ...checkBanned(text),
      ];
      if (SEO_COLLECTIONS.indexOf(collection) !== -1) {
        issues.push(...checkAnonymity(text), ...checkSEO(entry));
      }
      if (collection === "testimonials") {
        const attribution = entry.getIn(["data", "attribution"]) || "";
        issues.push(...checkAttribution(attribution));
      }
      if (issues.length > 0) {
        // Block publish and show issues.
        return Promise.reject(
          new Error("Editorial checks failed:\n\n" + issues.map((i) => "• " + i).join("\n"))
        );
      }
      return Promise.resolve();
    },
  });

  console.log("[brimwood] Editorial guardrails loaded.");
})();
