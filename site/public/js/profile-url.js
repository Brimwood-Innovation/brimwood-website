/* Shared profile-URL convention (audit/social/wiring) — client side.
 * Mirrors site/src/lib/profile.ts. Every avatar and display name rendered
 * anywhere on the site must link to the profile through Brimwood.profileUrl.
 *
 * Convention for sibling agents: mark the element that should become a link
 *   <span data-profile data-username="k_builds" data-user-id="u123">…</span>
 * then call Brimwood.linkProfiles(scope). The helper wraps the node's
 * contents in an <a> to the canonical URL (no-op if already inside a link).
 */
(function () {
  function profileUrl(user) {
    if (!user) return "/members";
    if (user.username) return "/@" + user.username;
    if (user.id) return "/u/" + user.id;
    return "/members";
  }

  function linkProfiles(scope) {
    var root = scope || document;
    var nodes = root.querySelectorAll("[data-profile]");
    for (var i = 0; i < nodes.length; i++) {
      (function (el) {
        if (el.closest("a")) return; // already linked
        var url = profileUrl({
          id: el.getAttribute("data-user-id"),
          username: el.getAttribute("data-username"),
        });
        var a = document.createElement("a");
        a.href = url;
        a.className = "profile-link";
        a.setAttribute("aria-label", "View profile");
        while (el.firstChild) a.appendChild(el.firstChild);
        el.appendChild(a);
      })(nodes[i]);
    }
  }

  window.Brimwood = window.Brimwood || {};
  window.Brimwood.profileUrl = profileUrl;
  window.Brimwood.linkProfiles = linkProfiles;
})();
