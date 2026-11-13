/* Canonical client-side HTML escaper (Phase 5 slice 5).
 * The one client-side escaper for the whole site: every public/js module
 * and every inline page script aliases window.Brimwood.escapeHtml instead
 * of keeping its own copy. The old copies drifted: most escaped only
 * <, >, and " (some only <), leaving & and ' unescaped, which is unsafe
 * the moment a value moves from text into a quoted attribute.
 * This version escapes all five characters, so it is safe for text and
 * for double- and single-quoted attribute values alike. Null and
 * undefined render as an empty string; anything else is stringified.
 * Load order: Base loads this as a classic script (no defer) before the
 * page slot, so it runs during parsing, ahead of Astro module scripts,
 * is:inline scripts, and the deferred footer scripts that alias it. */
(function () {
  "use strict";
  var MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return MAP[c];
    });
  }
  window.Brimwood = window.Brimwood || {};
  window.Brimwood.escapeHtml = escapeHtml;
})();
