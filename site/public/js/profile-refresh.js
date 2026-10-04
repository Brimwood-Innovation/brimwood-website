/* Public profile refresh: re-fetch the profile client-side in case it changed
 * since the build. Shared by u/[id].astro and @[username].astro. Config comes
 * from data attributes on #profileSection: data-profile-key, data-api-base. */
(function () {
  var section = document.getElementById("profileSection");
  if (!section) return;
  var key = section.dataset.profileKey || "";
  var API_BASE = section.dataset.apiBase || "";
  fetch(API_BASE + "/api/users/" + encodeURIComponent(key), {
    headers: { accept: "application/json" },
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.ok || !d.user) return;
      var u = d.user;
      var nameEl = document.getElementById("uName");
      if (nameEl && u.display_name) nameEl.textContent = u.display_name;
      var bioEl = document.getElementById("uBio");
      if (bioEl && u.bio) bioEl.textContent = u.bio;
      var img = document.getElementById("uAvatar");
      if (img && u.avatar_url && img.getAttribute("src") !== u.avatar_url) {
        img.setAttribute("src", u.avatar_url);
      }
    })
    .catch(function () {});
})();
