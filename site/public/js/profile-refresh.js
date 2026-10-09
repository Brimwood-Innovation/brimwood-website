/* Public profile refresh: re-fetch the profile client-side in case it changed
 * since the build. Shared by u/[id].astro and @[username].astro. Config comes
 * from data attributes on #profileSection: data-profile-key, data-api-base.
 *
 * Privacy rule: if the API no longer returns the profile (the member turned off
 * "Make my profile public", or was suspended), the statically prerendered page
 * must NOT keep showing the stale profile — replace it with a private notice.
 * Consent revoked means exposure stops. */
(function () {
  var section = document.getElementById("profileSection");
  if (!section) return;
  var key = section.dataset.profileKey || "";
  var API_BASE = section.dataset.apiBase || "";

  function showPrivate() {
    section.innerHTML =
      '<div class="kicker">Member</div>' +
      '<h1 class="sec" style="font-size:clamp(30px,5vw,48px);">This profile is private.</h1>' +
      '<p class="sec-lede" style="margin-inline:auto;">This member keeps a low profile. ' +
      "Nothing to see here.</p>";
  }

  fetch(API_BASE + "/api/users/" + encodeURIComponent(key), {
    headers: { accept: "application/json" },
  })
    .then(function (r) {
      if (!r.ok) {
        showPrivate();
        return null;
      }
      return r.json();
    })
    .then(function (d) {
      if (!d) return;
      if (!d.ok || !d.user) {
        showPrivate();
        return;
      }
      var u = d.user;
      var nameEl = document.getElementById("uName");
      if (nameEl) nameEl.textContent = u.display_name || "Member";
      var bioEl = document.getElementById("uBio");
      if (bioEl) {
        if (u.bio) {
          bioEl.textContent = u.bio;
          bioEl.style.display = "";
        } else {
          bioEl.textContent = "";
          bioEl.style.display = "none";
        }
      }
      var img = document.getElementById("uAvatar");
      if (img) {
        if (u.avatar_url) {
          if (img.getAttribute("src") !== u.avatar_url) img.setAttribute("src", u.avatar_url);
          img.style.display = "";
        } else {
          img.removeAttribute("src");
          img.style.display = "none";
        }
      }
    })
    .catch(function () {
      /* Network failure: leave the prerendered page alone. Only an explicit
       * 404/non-ok from the API proves consent was revoked. */
    });
})();
