/* @mention rendering (audit/social/wiring) — client side.
 * Mirrors the server rule in api/src/routes/notifications.ts (parseMentions):
 * 3–30 chars, lowercase letters/numbers/underscores, starts with a letter.
 * Brimwood.renderMentions(text) escapes HTML, then turns @handles into links
 * to the canonical profile URL. Handles that do not resolve simply land on
 * /@handle, where the profile page shows a clean "not found" state.
 */
(function () {
  var MENTION_RE = /(^|[^a-zA-Z0-9_@])@([a-z][a-z0-9_]{2,29})/g;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function parseMentions(text) {
    var out = [];
    var seen = {};
    var src = String(text == null ? "" : text);
    MENTION_RE.lastIndex = 0;
    var m;
    while ((m = MENTION_RE.exec(src)) !== null) {
      if (!seen[m[2]]) {
        seen[m[2]] = true;
        out.push(m[2]);
      }
    }
    return out;
  }

  function renderMentions(text) {
    var src = String(text == null ? "" : text);
    var out = "";
    var last = 0;
    MENTION_RE.lastIndex = 0;
    var m;
    while ((m = MENTION_RE.exec(src)) !== null) {
      out += esc(src.slice(last, m.index)) + esc(m[1]);
      out += '<a class="mention" href="/@' + m[2] + '">@' + m[2] + "</a>";
      last = m.index + m[0].length;
    }
    out += esc(src.slice(last));
    return out;
  }

  window.Brimwood = window.Brimwood || {};
  window.Brimwood.parseMentions = parseMentions;
  window.Brimwood.renderMentions = renderMentions;
})();
