/* Blog comment list + form. Extracted from blog/[...slug].astro so the global
 * CSP can drop 'unsafe-inline' for scripts. Config comes from data
 * attributes on the #comments section: data-slug, data-api-base. */
(function () {
  var section = document.getElementById("comments");
  if (!section) return;
  var slug = section.dataset.slug || "";
  var apiBase = section.dataset.apiBase || "";

  var listEl = document.getElementById("commentList");
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var fmtDate = function (iso) {
    try { return new Date(iso).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" }); }
    catch (e) { return ""; }
  };

  (async function () {
    try {
      var r = await fetch(apiBase + "/api/comments/" + encodeURIComponent(slug), {
        headers: { accept: "application/json" },
      });
      var d = await r.json();
      var comments = (d.ok && d.comments) || [];
      // @mentions render as profile links (audit/social/wiring); each comment
      // carries an anchor so notification deep links can target it.
      var renderMentions =
        (window.Brimwood && window.Brimwood.renderMentions) ||
        function (t) { return esc(t); };
      listEl.innerHTML = comments.length === 0
        ? "<p class='sec-lede'>No comments yet — be the first.</p>"
        : comments.map(function (cm) {
            var anchor = cm.id ? " id=\"comment-" + esc(cm.id) + "\"" : "";
            return "\n            <div class=\"admin-card\"" + anchor + " style=\"margin-bottom:12px;\">" +
              "\n              <p style=\"margin:0 0 8px;\"><strong>" + esc(cm.name) + "</strong>" +
              "\n                <span class=\"admin-muted\"> · " + esc(fmtDate(cm.created_at)) + "</span></p>" +
              "\n              <p style=\"margin:0;white-space:pre-wrap;\">" + renderMentions(cm.body) + "</p>" +
              "\n            </div>";
          }).join("");
    } catch (e) {
      listEl.innerHTML = "<p class='sec-lede'>Could not load comments.</p>";
    }
  })();

  document.getElementById("commentForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var v = function (id) { return document.getElementById(id).value.trim(); };
    var btn = document.getElementById("commentBtn");
    var err = document.getElementById("commentErr");
    err.style.display = "none";
    btn.disabled = true;
    btn.textContent = "Posting…";
    try {
      var res = await fetch(apiBase + "/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          post_slug: slug,
          name: v("cName"),
          email: v("cEmail"),
          body: v("cBody"),
          "cf-turnstile-response": (document.querySelector('#commentForm [name="cf-turnstile-response"]') || {}).value || "",
        }),
      });
      var d = await res.json().catch(function () { return {}; });
      if (!res.ok || !d.ok) throw new Error(d.error || "Could not post your comment.");
      document.getElementById("commentForm").style.display = "none";
      document.getElementById("commentThanks").style.display = "block";
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = "Post comment";
      err.textContent = ex.message;
      err.style.display = "block";
    }
  });
})();
