/* Notification bell (audit/social/wiring) — header badge + dropdown.
 * Expects: <button id="notifBell"> with <span id="notifBadge"> and
 * <div id="notifPanel"> in the header (see layouts/Base.astro).
 * Hidden entirely for anonymous visitors (401) or when the API is absent.
 * Clicking a row marks it read, then follows its deep link (same-origin only).
 */
(function () {
  var bell = document.getElementById("notifBell");
  if (!bell) return;
  var badge = document.getElementById("notifBadge");
  var panel = document.getElementById("notifPanel");
  var list = document.getElementById("notifList");
  var API = "";
  try {
    API = (document.querySelector("[data-api-base]") || {}).dataset?.apiBase || "";
  } catch (e) {}

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function rel(iso) {
    try {
      var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return Math.floor(s / 60) + "m";
      if (s < 86400) return Math.floor(s / 3600) + "h";
      return Math.floor(s / 86400) + "d";
    } catch (e) { return ""; }
  }

  function safeUrl(u) {
    return typeof u === "string" && u.charAt(0) === "/" ? u : "/notifications";
  }

  function renderBadge(unread) {
    if (!badge) return;
    if (unread > 0) {
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.style.display = "flex";
      bell.setAttribute("aria-label", "Notifications, " + unread + " unread");
    } else {
      badge.style.display = "none";
      bell.setAttribute("aria-label", "Notifications");
    }
  }

  function rowHtml(n) {
    var a = n.actor || {};
    var avatar = a.avatar_url
      ? '<img src="' + esc(a.avatar_url) + '" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex:none;">'
      : '<span style="width:36px;height:36px;border-radius:50%;background:#DDF5E9;color:#075E40;display:flex;align-items:center;' +
        'justify-content:center;font-weight:700;flex:none;">' + esc((a.display_name || "?").charAt(0).toUpperCase()) + "</span>";
    return (
      '<button data-nid="' + esc(n.id) + '" data-url="' + esc(safeUrl(n.url)) + '" style="display:flex;width:100%;gap:12px;' +
      'text-align:left;padding:12px 16px;border:none;background:' + (n.read_at ? "none" : "#F6F8F7") + ';cursor:pointer;' +
      'border-bottom:1px solid #eef2f0;">' + avatar +
      '<span style="flex:1;min-width:0;"><span style="display:flex;justify-content:space-between;gap:8px;">' +
      '<strong style="font-size:14px;color:#121A16;">' + esc(n.title) + "</strong>" +
      '<span style="font-size:12px;color:#5B6862;flex:none;">' + esc(rel(n.created_at)) + "</span></span>" +
      (n.preview ? '<span style="display:block;font-size:13px;color:#5B6862;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
        esc(n.preview) + "</span>" : "") + "</span>" +
      (n.read_at ? "" : '<span style="width:8px;height:8px;border-radius:50%;background:#0C9463;flex:none;margin-top:6px;"></span>') +
      "</button>"
    );
  }

  async function refresh(open) {
    try {
      var r = await fetch(API + "/api/notifications?limit=8", { credentials: "include", headers: { accept: "application/json" } });
      if (r.status === 401 || r.status === 404) { bell.style.display = "none"; return; }
      var d = await r.json();
      if (!r.ok || !d.ok) return;
      bell.style.display = "inline-flex";
      renderBadge(d.meta.unread || 0);
      if (open && list) {
        var items = d.notifications || [];
        list.innerHTML = items.length
          ? items.map(rowHtml).join("")
          : '<p style="padding:24px 16px;text-align:center;color:#5B6862;font-size:14px;">No new notifications.</p>';
        list.querySelectorAll("[data-nid]").forEach(function (b) {
          b.addEventListener("click", function () { openRow(b); });
        });
        var markAll = document.getElementById("notifMarkAll");
        if (markAll) markAll.style.display = d.meta.unread ? "inline" : "none";
      }
    } catch (e) { /* bell stays as-is on network failure */ }
  }

  async function openRow(btn) {
    var nid = btn.getAttribute("data-nid");
    var url = safeUrl(btn.getAttribute("data-url"));
    try {
      await fetch(API + "/api/notifications/" + encodeURIComponent(nid) + "/read", {
        method: "POST", credentials: "include", headers: { accept: "application/json" },
      });
    } catch (e) {}
    location.href = url;
  }

  async function markAll(e) {
    if (e) e.preventDefault();
    try {
      await fetch(API + "/api/notifications/read-all", {
        method: "POST", credentials: "include", headers: { accept: "application/json" },
      });
    } catch (e2) {}
    refresh(true);
  }

  var isOpen = false;
  function setOpen(v) {
    isOpen = v;
    if (panel) panel.style.display = v ? "block" : "none";
    bell.setAttribute("aria-expanded", v ? "true" : "false");
    if (v) refresh(true);
  }

  bell.addEventListener("click", function (e) { e.stopPropagation(); setOpen(!isOpen); });
  document.addEventListener("click", function (e) {
    if (isOpen && panel && !panel.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
  var markAllBtn = document.getElementById("notifMarkAll");
  if (markAllBtn) markAllBtn.addEventListener("click", markAll);

  refresh(false);
  setInterval(function () { if (!document.hidden) refresh(isOpen); }, 60000);
})();
