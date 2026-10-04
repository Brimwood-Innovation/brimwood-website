/* Admin comments-moderation tab. Extracted from CommentsTab.astro so the
 * global CSP can drop 'unsafe-inline' for scripts. Config comes from data
 * attributes on #comments-tab-root: data-api-base. */
(function () {
  var root = document.getElementById("comments-tab-root");
  if (!root) return;
  var apiBase = root.dataset.apiBase || "";

  var cApi = function (p, opts) {
    opts = opts || {};
    var init = {
      credentials: "include",
      headers: Object.assign({ accept: "application/json" }, opts.headers || {}),
    };
    Object.keys(opts).forEach(function (k) { init[k] = opts[k]; });
    return fetch(apiBase + p, init);
  };
  var cEsc = function (s) { return String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var cDate = function (iso) {
    try { return new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }); }
    catch (e) { return iso || ""; }
  };

  var commentStatus = "pending";

  async function loadCommentsTab(status) {
    if (status) commentStatus = status;
    var filtersEl = document.getElementById("commentFilters");
    var queueEl = document.getElementById("commentQueue");
    if (!filtersEl || !queueEl) return;
    queueEl.innerHTML = "<p class='admin-muted'>Loading…</p>";
    try {
      var r = await cApi("/api/admin/comments?status=" + encodeURIComponent(commentStatus));
      var d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "load failed");
      var counts = Object.fromEntries((d.counts || []).map(function (c) { return [c.status, c.n]; }));
      filtersEl.innerHTML = ["pending", "approved", "spam"]
        .map(function (s) {
          return "<button class=\"btn btn-ghost small\" data-cs=\"" + s + "\" style=\"" +
            (s === commentStatus ? "border-color:var(--emerald);color:var(--emerald-deep);" : "") +
            "\">" + s + " (" + (counts[s] || 0) + ")</button>";
        })
        .join("");
      filtersEl.querySelectorAll("[data-cs]").forEach(function (b) {
        b.addEventListener("click", function () { loadCommentsTab(b.dataset.cs); });
      });
      queueEl.innerHTML = (d.comments || []).length === 0
        ? "<p class='admin-muted'>Nothing here.</p>"
        : d.comments.map(function (cm) {
            return "\n          <div class=\"admin-card\">" +
              "\n            <div class=\"admin-row\">" +
              "\n              <div>" +
              "\n                <strong>" + cEsc(cm.name) + "</strong>" +
              "\n                <span class=\"admin-muted\">" + cEsc(cm.email) + "</span><br>" +
              "\n                <span class=\"admin-muted\">" + cEsc(cm.post_slug) + " · " + cEsc(cDate(cm.created_at)) + "</span>" +
              "\n                <p style=\"margin:8px 0 0;white-space:pre-wrap;\">" + cEsc(cm.body) + "</p>" +
              "\n              </div>" +
              "\n              <div style=\"display:flex;gap:8px;flex-shrink:0;\">" +
              (commentStatus !== "approved" ? "\n                <button class=\"btn small\" data-cact=\"approved\" data-cid=\"" + cm.id + "\">Approve</button>" : "") +
              (commentStatus !== "spam" ? "\n                <button class=\"btn btn-ghost small\" data-cact=\"spam\" data-cid=\"" + cm.id + "\">Spam</button>" : "") +
              "\n              </div>" +
              "\n            </div>" +
              "\n          </div>";
          }).join("");
      queueEl.querySelectorAll("[data-cact]").forEach(function (b) {
        b.addEventListener("click", async function () {
          b.disabled = true;
          try {
            var rr = await cApi("/api/admin/comments/" + encodeURIComponent(b.dataset.cid), {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: b.dataset.cact }),
            });
            var dd = await rr.json().catch(function () { return {}; });
            if (!rr.ok || !dd.ok) throw new Error(dd.error || "update failed");
            loadCommentsTab();
          } catch (e) {
            b.disabled = false;
            alert(e.message);
          }
        });
      });
    } catch (e) {
      queueEl.innerHTML = "<p>Failed to load: " + cEsc(e.message) + "</p>";
    }
  }

  window.loadCommentsTab = loadCommentsTab;
  document.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("comments-tab-root")) loadCommentsTab();
  });
})();
