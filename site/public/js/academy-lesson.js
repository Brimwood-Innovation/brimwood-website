/* Academy lesson page: "mark as complete" for open lessons, and gated-lesson
 * unlock for members. Extracted from academy/[slug]/[lessonId].astro so the
 * global CSP can drop 'unsafe-inline' for scripts. Config comes from data
 * attributes: #completeWrap carries data-lesson-id + data-api-base;
 * #gateWrap carries data-lesson-id + data-api-base + data-slug. */
(function () {
  // Open lesson: mark-as-complete button.
  var completeWrap = document.getElementById("completeWrap");
  if (completeWrap) {
    var lessonId = completeWrap.dataset.lessonId || "";
    var apiBase = completeWrap.dataset.apiBase || "";
    (async function () {
      var btn = document.getElementById("completeBtn");
      var msg = document.getElementById("completeMsg");
      try {
        var pr = await fetch(apiBase + "/api/progress/detail", {
          headers: { accept: "application/json" },
          credentials: "include",
        });
        var pd = await pr.json().catch(function () { return {}; });
        if (pd.ok && (pd.done || []).includes(lessonId)) {
          btn.style.display = "none";
          msg.style.display = "block";
          msg.style.color = "var(--emerald-deep)";
          msg.textContent = "✓ Completed";
          return;
        }
      } catch (e) {}
      btn.addEventListener("click", async function () {
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          var r = await fetch(apiBase + "/api/progress/" + encodeURIComponent(lessonId), {
            method: "POST",
            credentials: "include",
            headers: { accept: "application/json" },
          });
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok || !d.ok) throw new Error(d.error || "save failed");
          btn.style.display = "none";
          msg.style.display = "block";
          msg.style.color = "var(--emerald-deep)";
          msg.textContent = "✓ Completed — nice work.";
        } catch (e) {
          btn.disabled = false; btn.textContent = "Mark as complete";
          msg.style.display = "block";
          msg.textContent = e.message === "Sign in required" ? "Please sign in first." : "Could not save. Try again.";
        }
      });
    })();
  }

  // Gated lesson: fetch the lesson body for signed-in members.
  var gateWrap = document.getElementById("gateWrap");
  if (gateWrap) {
    var gLessonId = gateWrap.dataset.lessonId || "";
    var gApiBase = gateWrap.dataset.apiBase || "";
    var gSlug = gateWrap.dataset.slug || "";
    (async function () {
      try {
        var r = await fetch(gApiBase + "/api/courses/lessons/" + encodeURIComponent(gLessonId), {
          headers: { accept: "application/json" },
          credentials: "include",
        });
        var d = await r.json();
        if (d.ok && d.lesson) {
          var l = d.lesson;
          var gate = document.getElementById("gateWrap");
          var body = document.getElementById("lessonBody");
          gate.style.display = "none";
          body.style.display = "block";
          var esc = function (s) {
            return String(s || "").replace(/[&<>"]/g, function (c) {
              return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
            });
          };
          body.innerHTML =
            '<a href="/academy/' + esc(gSlug) + '" style="font-size:14px;">← ' + esc(l.course_title || "Course") + "</a>" +
            '<div class="kicker" style="margin-top:24px;">Members' + (l.duration_minutes ? " · " + l.duration_minutes + " min" : "") + "</div>" +
            '<h1 class="sec" style="font-size:clamp(28px,4vw,44px);margin-bottom:18px;">' + esc(l.title) + "</h1>" +
            (l.video_r2_key ? '<video controls preload="metadata" playsinline style="width:100%;border-radius:16px;background:var(--ink);margin:24px 0;" src="' + esc(gApiBase) + "/api/video/" + esc(l.video_r2_key) + '"></video>' : "") +
            '<div class="prose" style="padding:0;max-width:none;"><p style="white-space:pre-wrap;">' + esc(l.body_md) + "</p></div>" +
            '<div style="margin-top:32px;"><button class="btn" id="gatedCompleteBtn">Mark as complete</button>' +
            '<p id="gatedCompleteMsg" style="display:none;font-weight:600;"></p></div>';
          document.title = l.title + " — Academy — Brimwood Innovation";
          var btn = document.getElementById("gatedCompleteBtn");
          var msg = document.getElementById("gatedCompleteMsg");
          try {
            var pr = await fetch(gApiBase + "/api/progress/detail", { headers: { accept: "application/json" }, credentials: "include" });
            var pd = await pr.json().catch(function () { return {}; });
            if (pd.ok && (pd.done || []).includes(gLessonId)) {
              btn.style.display = "none"; msg.style.display = "block";
              msg.style.color = "var(--emerald-deep)"; msg.textContent = "✓ Completed";
            }
          } catch (e) {}
          btn.addEventListener("click", async function () {
            btn.disabled = true; btn.textContent = "Saving…";
            try {
              var pr2 = await fetch(gApiBase + "/api/progress/" + encodeURIComponent(gLessonId), {
                method: "POST", credentials: "include", headers: { accept: "application/json" },
              });
              var d2 = await pr2.json().catch(function () { return {}; });
              if (!pr2.ok || !d2.ok) throw new Error(d2.error || "save failed");
              btn.style.display = "none"; msg.style.display = "block";
              msg.style.color = "var(--emerald-deep)"; msg.textContent = "✓ Completed — nice work.";
            } catch (e) {
              btn.disabled = false; btn.textContent = "Mark as complete";
              msg.style.display = "block";
              msg.textContent = "Could not save. Try again.";
            }
          });
        }
      } catch (e) {}
    })();
  }
})();
