/* Hub shell behaviour (Phase 3 slice 2). Loaded is:inline by HubShell.astro,
 * following the StoriesTray and ProfileView pattern: links, menus
 * (details/summary) and tabs work without this script; it only adds
 * live state. Failures are silent by design: a signed-out visitor
 * keeps the plain shell around the page sign-in prompt. */
/* Hub shell behaviour: bell dot, avatar initials, Ctrl K search,
   * sign out. Links, menus (details/summary) and tabs all work
   * without this script; it only adds live state. Failures are
   * silent by design: a signed-out visitor keeps the plain shell
   * around the page sign-in prompt. */
  (function () {
    var shell = document.querySelector(".hub-ui");
    if (!shell) return;
    var apiBase = shell.getAttribute("data-api-base") || "";

    var dot = document.getElementById("hubNotifDot");
    if (dot) {
      fetch(apiBase + "/api/notifications?limit=1", {
        credentials: "include",
        headers: { accept: "application/json" },
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.ok && d.unread > 0) dot.removeAttribute("hidden");
        })
        .catch(function () {});
    }

    var initials = document.getElementById("hubAvatarInitials");
    if (initials) {
      fetch(apiBase + "/api/auth/me", {
        credentials: "include",
        headers: { accept: "application/json" },
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var name = d && d.ok && d.user && d.user.display_name;
          if (!name) return;
          var parts = String(name).trim().split(/\s+/);
          var letters = parts.slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join("");
          if (letters) initials.textContent = letters;
        })
        .catch(function () {});
    }

    document.querySelectorAll(".hub-signout").forEach(function (btn) {
      btn.addEventListener("click", function () {
        fetch(apiBase + "/api/auth/logout", {
          method: "POST",
          credentials: "include",
          headers: { accept: "application/json" },
        }).finally(function () {
          window.location.href = "/members";
        });
      });
    });

    document.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      // The command palette (command-palette.js) owns Ctrl K when it
      // loaded; without it, the shortcut still reaches /search.
      if (window.BrimwoodCommandPalette) window.BrimwoodCommandPalette.open();
      else window.location.href = "/search";
    });
  })();
