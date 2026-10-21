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
      var av = document.getElementById("uAvatar");
      if (av) {
        if (u.avatar_url) {
          if (av.tagName === "IMG") {
            if (av.getAttribute("src") !== u.avatar_url) av.setAttribute("src", u.avatar_url);
            av.style.display = "";
          } else {
            /* Initials fallback (a span): swap in the real image, keeping
             * the round shape. */
            var ni = document.createElement("img");
            ni.id = "uAvatar";
            ni.src = u.avatar_url;
            ni.alt = (u.display_name || "Member") + "'s avatar";
            ni.style.cssText = av.style.cssText;
            av.replaceWith(ni);
          }
        } else if (av.tagName === "IMG") {
          av.removeAttribute("src");
          av.style.display = "none";
        }
      }
    })
    .catch(function () {
      /* Network failure: leave the prerendered page alone. Only an explicit
       * 404/non-ok from the API proves consent was revoked. */
    });
})();
