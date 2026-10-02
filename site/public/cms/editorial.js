/* Editorial guardrails for Decap CMS (T27).
 * Client-side pre-publish checks: Canadian spelling, banned phrases,
 * member anonymity, SEO checklist.
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

  function checkSEO(entry) {
    const issues = [];
    const title = entry.getIn(["data", "title"]) || "";
    const excerpt = entry.getIn(["data", "excerpt"]) || "";
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

  // Register a pre-publish check.
  CMS.registerEventListener({
    name: "prePublish",
    handler: ({ entry }) => {
      const body = entry.getIn(["data", "body"]) || "";
      const title = entry.getIn(["data", "title"]) || "";
      const text = title + "\n" + body;
      const issues = [
        ...checkSpelling(text),
        ...checkBanned(text),
        ...checkAnonymity(text),
        ...checkSEO(entry),
      ];
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
