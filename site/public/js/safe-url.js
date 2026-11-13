/* Canonical client-side URL scheme allowlist (Phase 5 slice 7).
 * The one place that decides whether a value may be rendered into an href
 * or src. Escaping (site/public/js/escape.js) stops a value breaking out of
 * its quoted attribute, but it never stops a javascript: or data:text/html
 * value that stays inside the attribute and executes on click or load, so
 * every href/src built from an API answer passes through here first.
 * Rules, shared by all three helpers:
 * - Tabs, newlines, and carriage returns are stripped anywhere in the
 *   value, and leading/trailing C0 controls and spaces are trimmed, before
 *   any check: the WHATWG URL parser does the same, so a tab or newline
 *   smuggled inside a scheme ("java\tscript:") must not slip past the
 *   allowlist while the browser still reads it as that scheme.
 * - A scheme, when present, must match ^[A-Za-z][A-Za-z0-9+.-]*: and be
 *   allowlisted; anything else with a scheme is rejected, never passed
 *   through. Protocol-relative "//host" values are rejected everywhere:
 *   they inherit the page scheme and point at an attacker host.
 * - A rejected value returns the caller's fallback (null by default), and
 *   the caller renders nothing, plain text, or a safe fallback page,
 *   never the rejected value.
 * Helpers:
 * - safeLinkUrl: navigation links. Allows http(s) with "//", mailto:,
 *   site-relative paths, and anchors. This matches the Phase 5 slice 3
 *   Studio markdown rule it replaces.
 * - safeSameOriginUrl: deep links that must stay on this site (the
 *   notification bell and page, the certificate link). Site-relative
 *   paths only; this replaces their local same-origin-only safeUrl.
 * - safeMediaUrl: img and video sources. Allows http(s) with "//",
 *   site-relative paths, data:image/ payloads (scripts never run in an
 *   image context), and blob: object URLs (origin-scoped: a blob URL
 *   from another origin cannot resolve here). data:text/html and every
 *   other data: type are rejected.
 * Load order: Base loads this as a classic script (no defer) directly
 * after escape.js, so it runs during parsing before the slot's page
 * scripts, exactly like the canonical escaper. */
(function () {
  "use strict";
  function clean(u) {
    return String(u)
      .replace(/[\t\n\r]/g, "")
      .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  }
  function schemeOf(s) {
    var m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
    return m ? m[1].toLowerCase() : null;
  }
  function isRelative(s) {
    return s.charAt(0) === "/" && s.charAt(1) !== "/";
  }
  function isAnchor(s) {
    return s.charAt(0) === "#";
  }
  function fallbackOf(fallback) {
    return fallback === undefined ? null : fallback;
  }
  function safeLinkUrl(u, fallback) {
    var fb = fallbackOf(fallback);
    if (typeof u !== "string" || !u) return fb;
    var s = clean(u);
    if (!s || isAnchor(s) || isRelative(s)) return s || fb;
    var scheme = schemeOf(s);
    if (scheme === "http" || scheme === "https") {
      return /^https?:\/\//i.test(s) ? s : fb;
    }
    if (scheme === "mailto") return s;
    return fb;
  }
  function safeSameOriginUrl(u, fallback) {
    var fb = fallbackOf(fallback);
    if (typeof u !== "string" || !u) return fb;
    var s = clean(u);
    return isRelative(s) ? s : fb;
  }
  function safeMediaUrl(u, fallback) {
    var fb = fallbackOf(fallback);
    if (typeof u !== "string" || !u) return fb;
    var s = clean(u);
    if (!s || isRelative(s)) return s || fb;
    var scheme = schemeOf(s);
    if (scheme === "http" || scheme === "https") {
      return /^https?:\/\//i.test(s) ? s : fb;
    }
    if (scheme === "data") {
      return /^data:image\/[a-z0-9.+-]+/i.test(s) && s.indexOf(",") > 0 ? s : fb;
    }
    if (scheme === "blob") return s;
    return fb;
  }
  window.Brimwood = window.Brimwood || {};
  window.Brimwood.safeLinkUrl = safeLinkUrl;
  window.Brimwood.safeSameOriginUrl = safeSameOriginUrl;
  window.Brimwood.safeMediaUrl = safeMediaUrl;
})();
