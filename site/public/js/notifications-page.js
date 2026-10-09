/* Notifications inbox page (audit/social/wiring). Config-free: same-origin API. */
(function () {
  var loading = document.getElementById("notif-loading");
  var login = document.getElementById("notif-login");
  var home = document.getElementById("notif-home");
  if (!home) return;
  var list = document.getElementById("notifPageList");
  var moreBtn = document.getElementById("notifMore");
  var markAllBtn = document.getElementById("pageMarkAll");
  var API = "";
  try {
    API = (document.querySelector("[data-api-base]") || {}).dataset?.apiBase || "";
  } catch (e) {}

  var offset = 0;
  var LIMIT = 20;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function rel(iso) {
    try {
      var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return Math.floor(s / 60) + "m ago";
      if (s < 86400) return Math.floor(s / 3600) + "h ago";
      var d = Math.floor(s / 86400);
      return d === 1 ? "yesterday" : d + " days ago";
    } catch (e) { return ""; }
  }

  function safeUrl(u) {
    return typeof u === "string" && u.charAt(0) === "/" ? u : "/notifications";
  }

  function rowHtml(n) {
    var a = n.actor || {};
    var avatar = a.avatar_url
      ? '<img src="' + esc(a.avatar_url) + '" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex:none;">'
      : '<span style="width:44px;height:44px;border-radius:50%;background:#DDF5E9;color:#075E40;display:flex;align-items:center;' +
        'justify-content:center;font-weight:700;font-size:18px;flex:none;">' + esc((a.display_name || "?").charAt(0).toUpperCase()) + "</span>";
    var profile = a.username ? "/@" + a.username : a.id ? "/u/" + a.id : null;
    var line;
    if (a && a.id && profile) {
      var rest = String(n.title || "").replace(/^[^\s]+\s+/, "");
      line = '<a href="' + esc(profile) + '" style="color:#0C9463;font-weight:600;">' +
        esc(a.display_name || "Someone") + "</a> " + '<span style="color:#5B6862;">' + esc(rest) + "</span>";
    } else {
      line = "<strong>" + esc(n.title || "New activity") + "</strong>";
    }
    return (
      '<div class="admin-card" style="margin-bottom:12px;' + (n.read_at ? "" : "border-left:3px solid #0C9463;") + '">' +
      '<div style="display:flex;gap:12px;align-items:flex-start;">' + avatar +
      '<div style="flex:1;min-width:0;"><p style="margin:0 0 4px;font-size:15px;">' + line +
      ' <span class="admin-muted" style="font-size:12px;">· ' + esc(rel(n.created_at)) + "</span></p>" +
      (n.preview ? '<p style="margin:0 0 8px;font-size:14px;color:#121A16;">' + esc(n.preview) + "</p>" : "") +
      '<p style="margin:0;"><button data-nid="' + esc(n.id) + '" data-url="' + esc(safeUrl(n.url)) + '" class="btn btn-ghost small">View</button></p>' +
      "</div></div></div>"
    );
  }

  async function load(more) {
    try {
      var r = await fetch(API + "/api/notifications?limit=" + LIMIT + "&offset=" + offset, {
        credentials: "include", headers: { accept: "application/json" },
      });
      if (r.status === 401) {
        loading.style.display = "none"; login.style.display = "block"; return;
      }
      var d = await r.json();
      if (!r.ok || !d.ok) throw new Error("bad");
      loading.style.display = "none"; home.style.display = "block";
      var items = d.notifications || [];
      if (!more) list.innerHTML = "";
      if (!items.length && !more) {
        list.innerHTML = '<p class="sec-lede" style="text-align:center;padding:32px 0;">Nothing yet — mentions, replies, and reminders will land here.</p>';
      }
      list.insertAdjacentHTML("beforeend", items.map(rowHtml).join(""));
      list.querySelectorAll("[data-nid]").forEach(function (b) {
        if (b._wired) return; b._wired = true;
        b.addEventListener("click", async function () {
          try {
            await fetch(API + "/api/notifications/" + encodeURIComponent(b.getAttribute("data-nid")) + "/read", {
              method: "POST", credentials: "include", headers: { accept: "application/json" },
            });
          } catch (e) {}
          location.href = safeUrl(b.getAttribute("data-url"));
        });
      });
      offset += items.length;
      moreBtn.style.display = items.length === LIMIT ? "inline-block" : "none";
      markAllBtn.style.display = d.meta.unread ? "inline-block" : "none";
    } catch (e) {
      loading.innerHTML = '<p class="sec-lede">Could not load notifications.</p>';
    }
  }

  moreBtn.addEventListener("click", function () { load(true); });
  markAllBtn.addEventListener("click", async function () {
    try {
      await fetch(API + "/api/notifications/read-all", {
        method: "POST", credentials: "include", headers: { accept: "application/json" },
      });
    } catch (e) {}
    offset = 0; load(false);
  });

  load(false);
})();
