/* Shared avatar renderer — client-side twin of site/src/components/Avatar.astro.
 * Round everywhere, consistent sizes, initials fallback in brand colours.
 * Brand Kit v1.0. Usage: brimwoodAvatar({ src, name, size }) -> HTML string.
 * size: 'sm' | 'md' | 'lg' | 'xl' or a pixel number. */
(function () {
  "use strict";
  var SIZES = { sm: 32, md: 48, lg: 96, xl: 128 };
  var BG = ["#0C9463", "#075E40", "#0A3D2B"]; // Emerald, Deep Emerald, Forest
  var FG = "#F6F8F7"; // Paper

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function initials(n) {
    var parts = String(n || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "M";
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function bgFor(name) {
    var h = 0;
    var n = String(name || "");
    for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return BG[h % BG.length];
  }

  window.brimwoodAvatar = function (opts) {
    opts = opts || {};
    var px = typeof opts.size === "number" ? opts.size : (SIZES[opts.size] || SIZES.md);
    var name = opts.name || "Member";
    var label = esc(name) + "'s avatar";
    var dim = "width:" + px + "px;height:" + px + "px;";
    if (opts.src) {
      return (
        '<img src="' + esc(opts.src) + '" alt="' + label + '" loading="lazy" style="' +
        dim + 'border-radius:50%;object-fit:cover;display:block;flex:none;" />'
      );
    }
    var fs = Math.round(px * 0.38);
    return (
      '<span role="img" aria-label="' + label + '" style="' + dim +
      "border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex:none;" +
      "background:" + bgFor(name) + ";color:" + FG + ";font-weight:700;font-size:" + fs +
      'px;letter-spacing:0.02em;">' + esc(initials(name)) + "</span>"
    );
  };
})();
