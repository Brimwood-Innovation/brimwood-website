/* Profile actions (audit/social/wiring): Message button + canonical URL.
 * Runs on /@username and /u/<id> pages (after ProfileView).
 *
 * 1. Canonical alignment: on /u/<id>, when the profile has a username, replace
 *    the URL with the canonical /@username (search engines see one profile).
 * 2. Message button: signed-in members viewing someone else's profile get a
 *    "Message" button under the name → Brimwood.messageMember (share-to-dm.js),
 *    which opens/creates the 1:1 DM. Anonymous visitors see nothing new —
 *    anonymous-by-default holds.
 */
(function () {
  var section = document.getElementById("profileSection");
  if (!section) return;
  var key = section.getAttribute("data-profile-key") || "";
  var apiBase = section.getAttribute("data-api-base") || "";
  var nameEl = document.getElementById("uName");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function getJSON(url) {
    var r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    var d = await r.json().catch(function () { return null; });
    return d && d.ok ? d : null;
  }

  (async function () {
    var pd = await getJSON(apiBase + "/api/users/" + encodeURIComponent(key));
    if (!pd || !pd.user) return;
    var user = pd.user;

    // 1. Canonical: /u/<id> → /@username when a username exists.
    if (
      user.username &&
      location.pathname.indexOf("/u/") === 0 &&
      location.pathname !== "/@" + user.username
    ) {
      location.replace("/@" + user.username);
      return;
    }

    // 2. Message button for signed-in members viewing someone else.
    var me = await getJSON(apiBase + "/api/auth/me");
    var meId = me && me.user && (me.user.id || me.user.user_id);
    if (!meId || meId === user.id) return;
    if (!window.Brimwood || !window.Brimwood.messageMember) return;

    var wrap = document.createElement("p");
    wrap.style.cssText = "margin:16px 0 0;display:flex;gap:8px;justify-content:center;";
    var btn = document.createElement("button");
    btn.className = "btn small";
    btn.type = "button";
    btn.textContent = "Message";
    btn.setAttribute("aria-label", "Message " + (user.display_name || "this member"));
    btn.addEventListener("click", function () {
      window.Brimwood.messageMember(user.id);
    });
    wrap.appendChild(btn);

    // A share-profile affordance next to it (copies the canonical link).
    var share = document.createElement("button");
    share.className = "btn btn-ghost small";
    share.type = "button";
    share.textContent = "Copy profile link";
    share.addEventListener("click", function () {
      var url = location.origin + "/@" + user.username;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () { window.Brimwood.toast("Profile link copied."); },
          function () { window.Brimwood.toast(url); }
        );
      } else {
        window.Brimwood.toast(url);
      }
    });
    if (user.username) wrap.appendChild(share);

    if (nameEl && nameEl.parentNode) {
      nameEl.parentNode.insertBefore(wrap, nameEl.nextSibling);
    } else {
      section.appendChild(wrap);
    }
  })();
})();
