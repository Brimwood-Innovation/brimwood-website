/* Academy course page: enrol button + progress checkmarks. Extracted from
 * academy/[slug].astro so the global CSP can drop 'unsafe-inline' for
 * scripts. Config comes from data attributes on #enrolWrap:
 * data-slug, data-api-base. */
(function () {
  var wrap = document.getElementById("enrolWrap");
  if (!wrap) return;
  var slug = wrap.dataset.slug || "";
  var apiBase = wrap.dataset.apiBase || "";

  // Enrol + progress checkmarks.
  (async function () {
    try {
      var pr = await fetch(apiBase + "/api/progress", {
        headers: { accept: "application/json" },
        credentials: "include",
      });
      var d = await pr.json().catch(function () { return {}; });
      if (!d.ok) return;
      if ((d.enrolments || []).some(function (e) { return e.slug === slug; })) {
        document.getElementById("enrolBtn").style.display = "none";
        var msg = document.getElementById("enrolMsg");
        msg.style.display = "block";
        msg.textContent = "You're enrolled in this course.";
      }
      var dr = await fetch(apiBase + "/api/progress/detail", {
        headers: { accept: "application/json" },
        credentials: "include",
      });
      var dd = await dr.json().catch(function () { return {}; });
      var doneIds = new Set(dd.ok ? dd.done || [] : []);
      document.querySelectorAll(".lesson-link").forEach(function (a) {
        if (doneIds.has(a.dataset.lessonId)) {
          a.querySelector(".done-mark").style.display = "inline";
          a.style.borderColor = "var(--emerald)";
        }
      });
    } catch (e) {}
  })();

  document.getElementById("enrolBtn").addEventListener("click", async function () {
    var btn = document.getElementById("enrolBtn");
    var msg = document.getElementById("enrolMsg");
    btn.disabled = true; btn.textContent = "Enrolling…";
    try {
      var r = await fetch(apiBase + "/api/enrol/" + encodeURIComponent(slug), {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json" },
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok || !d.ok) throw new Error(d.error || "enrol failed");
      btn.style.display = "none";
      msg.style.display = "block";
      msg.textContent = "You're enrolled. Start with the first lesson below.";
    } catch (e) {
      btn.disabled = false; btn.textContent = "Enrol in this course";
      msg.style.display = "block";
      msg.textContent = e.message === "Sign in required" ? "Please sign in first." : "Could not enrol. Try again.";
    }
  });
})();
