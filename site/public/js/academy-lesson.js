/* Academy lesson page: the reflection panel and the gated-lesson unlock.
 * Extracted from academy/[slug]/[lessonId].astro so the global CSP can
 * drop 'unsafe-inline' for scripts. Config comes from data attributes:
 * #completeWrap and #gateWrap carry data-lesson-id + data-api-base +
 * data-slug.
 *
 * Phase 2 slice 4 (prototype section 06): there is no Mark complete.
 * Submitting the reflection completes the lesson (D6): the panel posts
 * { reflection } to POST /api/progress/:lessonId, the contract the API
 * shipped in Phase 1. While a signed-in member has not reflected yet,
 * the Next lesson link stays disabled with the deck note; submitting
 * opens it. The progress line reads GET /api/progress for the course. */
(function () {
  function esc(s) {
    return String(s || "").replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function wireReflection(o) {
    var done = false;
    var signedIn = false;

    function showMsg(text, ok) {
      o.msg.style.display = "block";
      o.msg.style.color = ok ? "var(--emerald-deep)" : "#a4262c";
      o.msg.textContent = text;
    }

    async function refreshProgress() {
      if (!o.progressLine) return;
      try {
        var r = await fetch(o.apiBase + "/api/progress", {
          headers: { accept: "application/json" },
          credentials: "include",
        });
        var d = await r.json().catch(function () { return {}; });
        if (!d.ok) return;
        var e = (d.enrolments || []).find(function (x) { return x.slug === o.slug; });
        if (e) {
          o.progressText.textContent =
            e.done_lessons + " of " + e.total_lessons + " lessons complete.";
          o.progressLine.hidden = false;
        }
      } catch (e) {}
    }

    function gateNext() {
      if (!o.nextLink) return;
      if (signedIn && !done) {
        if (!o.nextLink.dataset.href) o.nextLink.dataset.href = o.nextLink.getAttribute("href") || "";
        o.nextLink.removeAttribute("href");
        o.nextLink.setAttribute("aria-disabled", "true");
        o.nextLink.classList.add("disabled-link");
        if (o.nextNote) o.nextNote.hidden = false;
      } else {
        if (o.nextLink.dataset.href && !o.nextLink.getAttribute("href")) {
          o.nextLink.setAttribute("href", o.nextLink.dataset.href);
        }
        o.nextLink.removeAttribute("aria-disabled");
        o.nextLink.classList.remove("disabled-link");
        if (o.nextNote) o.nextNote.hidden = true;
      }
    }

    (async function () {
      try {
        var pr = await fetch(o.apiBase + "/api/progress/detail", {
          headers: { accept: "application/json" },
          credentials: "include",
        });
        var pd = await pr.json().catch(function () { return {}; });
        if (pd.ok) {
          signedIn = true;
          done = (pd.done || []).includes(o.lessonId);
          if (done) showMsg("✓ Completed.", true);
        }
      } catch (e) {}
      gateNext();
      refreshProgress();
    })();

    o.form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var text = o.textarea.value.trim();
      if (text.length < 20 || text.length > 2000) {
        showMsg("A reflection of 20 to 2000 characters is required.", false);
        return;
      }
      o.btn.disabled = true;
      o.btn.textContent = "Saving…";
      try {
        var r = await fetch(o.apiBase + "/api/progress/" + encodeURIComponent(o.lessonId), {
          method: "POST",
          credentials: "include",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ reflection: text }),
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok || !d.ok) throw new Error(d.error || "save failed");
        done = true;
        signedIn = true;
        showMsg("✓ Completed.", true);
        gateNext();
        refreshProgress();
      } catch (e) {
        var m = String((e && e.message) || "");
        showMsg(
          m === "Sign in required"
            ? "Please sign in first."
            : /reflection/i.test(m)
              ? m
              : "Could not save. Try again.",
          false
        );
      }
      o.btn.disabled = false;
      o.btn.textContent = "Submit reflection";
    });
  }

  function reflectionEls(prefix) {
    return {
      form: document.getElementById(prefix + "reflectionForm"),
      textarea: document.getElementById(prefix + "reflectionBody"),
      btn: document.getElementById(prefix + "reflectionBtn"),
      msg: document.getElementById(prefix + "reflectionMsg"),
      progressLine: document.getElementById(prefix + "progressLine"),
      progressText: document.getElementById(prefix + "progressText"),
    };
  }

  // Open lesson: the reflection panel is server-rendered.
  var completeWrap = document.getElementById("completeWrap");
  if (completeWrap) {
    var els = reflectionEls("");
    wireReflection({
      apiBase: completeWrap.dataset.apiBase || "",
      lessonId: completeWrap.dataset.lessonId || "",
      slug: completeWrap.dataset.slug || "",
      form: els.form,
      textarea: els.textarea,
      btn: els.btn,
      msg: els.msg,
      progressLine: els.progressLine,
      progressText: els.progressText,
      nextLink: document.getElementById("nextLessonLink"),
      nextNote: document.getElementById("nextGateNote"),
    });
  }

  // Gated lesson: fetch the lesson body for signed-in members, then wire
  // the same reflection panel into the unlocked view.
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
          body.innerHTML =
            '<a href="/academy/' + esc(gSlug) + '" style="font-size:14px;">← ' + esc(l.course_title || "Course") + "</a>" +
            '<div class="kicker" style="margin-top:24px;">Members' + (l.duration_minutes ? " · " + l.duration_minutes + " min" : "") + "</div>" +
            '<h1 class="sec" style="font-size:clamp(28px,4vw,44px);margin-bottom:18px;">' + esc(l.title) + "</h1>" +
            (l.video_r2_key ? '<video controls preload="metadata" playsinline style="width:100%;border-radius:16px;background:var(--ink);margin:24px 0;" src="' + esc(gApiBase) + "/api/video/" + esc(l.video_r2_key) + '"></video>' : "") +
            '<div class="prose" style="padding:0;max-width:none;"><p style="white-space:pre-wrap;">' + esc(l.body_md) + "</p></div>" +
            '<div class="reflection">' +
            '<form id="gReflectionForm" novalidate>' +
            '<label for="gReflectionBody">Your reflection</label>' +
            '<textarea id="gReflectionBody" rows="5" maxlength="2000" aria-describedby="gReflectionHint gReflectionMsg"></textarea>' +
            '<p class="hint" id="gReflectionHint">20 characters or more. Private by default.</p>' +
            '<p id="gReflectionMsg" role="status" style="display:none;font-weight:600;margin-top:12px;"></p>' +
            '<button class="btn" id="gReflectionBtn" type="submit" style="margin-top:16px;">Submit reflection</button>' +
            '<p class="progress-line" id="gProgressLine" hidden>Your progress: <b id="gProgressText"></b></p>' +
            "</form></div>";
          document.title = l.title + " — Academy — Brimwood Innovation";
          var gels = reflectionEls("g");
          wireReflection({
            apiBase: gApiBase,
            lessonId: gLessonId,
            slug: gSlug,
            form: gels.form,
            textarea: gels.textarea,
            btn: gels.btn,
            msg: gels.msg,
            progressLine: gels.progressLine,
            progressText: gels.progressText,
            nextLink: null,
            nextNote: null,
          });
        }
      } catch (e) {}
    })();
  }
})();
