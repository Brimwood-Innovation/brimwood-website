/* Share-to-DM (audit/social/wiring) — the Instagram paper-plane pattern,
 * Brimwood-adapted: share any post to a member conversation with the quoted
 * post attached.
 *
 *   Brimwood.shareToDM({ title, url, targetType, targetId })
 *     1. Loads the member's conversations (GET /api/chat/conversations).
 *     2. Opens a recipient picker (native <dialog>, brand styling).
 *     3. Posts the share as a message and navigates to the conversation.
 *
 *   Brimwood.messageMember(userId)
 *     Opens (or creates — the endpoint is idempotent) a 1:1 DM and navigates
 *     to it. Used by the Message button on profile pages.
 *
 * Defensive by contract: if the chat routes are not deployed yet (404), both
 * helpers fall back to copying the link and showing a calm notice instead of
 * failing. /hub/messages honours ?conversation=<id> and ?with=<user_id>.
 */
(function () {
  var API = "";
  try {
    API = (document.querySelector("[data-api-base]") || {}).dataset?.apiBase || "";
  } catch (e) {}

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg) {
    var t = document.getElementById("bw-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "bw-toast";
      t.setAttribute("role", "status");
      t.style.cssText =
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#121A16;color:#F6F8F7;" +
        "padding:12px 20px;border-radius:12px;font-size:14px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.25);" +
        "max-width:min(92vw,480px);text-align:center;";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.display = "none"; }, 3200);
  }

  function copyLink(url, fallbackMsg) {
    var done = function () { toast("Link copied — chat is coming soon."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { toast(fallbackMsg || url); });
    } else {
      toast(fallbackMsg || url);
    }
  }

  async function api(path, opts) {
    var r = await fetch(API + path, Object.assign({ credentials: "include", headers: { accept: "application/json" } }, opts || {}));
    if (r.status === 404) { var e = new Error("chat-unavailable"); e.chatUnavailable = true; throw e; }
    return r;
  }

  function shareBody(share) {
    return "Shared: " + share.title + "\n" + share.url;
  }

  function openPicker(conversations, onPick) {
    var dlg = document.getElementById("bw-share-dialog");
    if (dlg) dlg.remove();
    dlg = document.createElement("dialog");
    dlg.id = "bw-share-dialog";
    dlg.style.cssText = "border:none;border-radius:16px;padding:0;max-width:min(92vw,420px);width:420px;";
    var rows = conversations.map(function (c) {
      return (
        '<button data-conv="' + esc(c.id) + '" style="display:flex;width:100%;text-align:left;gap:12px;align-items:center;' +
        'padding:12px 16px;border:none;background:none;cursor:pointer;border-bottom:1px solid #eef2f0;">' +
        '<span style="width:36px;height:36px;border-radius:50%;background:#DDF5E9;color:#075E40;display:flex;' +
        'align-items:center;justify-content:center;font-weight:700;">' + esc((c.title || "?").charAt(0).toUpperCase()) + "</span>" +
        '<span><span style="display:block;font-weight:600;color:#121A16;">' + esc(c.title || "Conversation") + "</span>" +
        (c.unread ? '<span style="font-size:12px;color:#0C9463;">' + c.unread + " unread</span>" : "") + "</span></button>"
      );
    }).join("");
    dlg.innerHTML =
      '<div style="padding:20px 20px 8px;"><h3 style="margin:0 0 4px;color:#121A16;">Share to DM</h3>' +
      '<p style="margin:0 0 12px;font-size:13px;color:#5B6862;">Pick a conversation — the post goes with a quote.</p></div>' +
      '<div style="max-height:320px;overflow:auto;">' + (rows || '<p style="padding:0 20px 16px;color:#5B6862;">No conversations yet.</p>') + "</div>" +
      '<div style="padding:12px 20px 20px;display:flex;gap:8px;justify-content:flex-end;">' +
      '<button id="bw-share-cancel" class="btn btn-ghost small">Cancel</button></div>';
    document.body.appendChild(dlg);
    dlg.querySelector("#bw-share-cancel").addEventListener("click", function () { dlg.close(); });
    dlg.querySelectorAll("[data-conv]").forEach(function (b) {
      b.addEventListener("click", function () { dlg.close(); onPick(b.getAttribute("data-conv")); });
    });
    dlg.showModal();
  }

  async function shareToDM(share) {
    var url = share.url || location.href;
    var title = share.title || document.title;
    try {
      var r = await api("/api/chat/conversations");
      if (r.status === 401) { location.href = "/members"; return; }
      var d = await r.json();
      if (!d.ok) throw new Error("bad-response");
      var convs = d.conversations || [];
      if (!convs.length) { copyLink(url); return; }
      openPicker(convs, async function (convId) {
        try {
          var pr = await api("/api/chat/conversations/" + encodeURIComponent(convId) + "/messages", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ body: shareBody({ title: title, url: url }) }),
          });
          var pd = await pr.json();
          if (pr.ok && pd.ok) {
            location.href = "/hub/messages?conversation=" + encodeURIComponent(convId);
          } else {
            throw new Error("send-failed");
          }
        } catch (e) {
          if (e.chatUnavailable) copyLink(url);
          else toast("Could not send — try again.");
        }
      });
    } catch (e) {
      if (e.chatUnavailable) copyLink(url);
      else toast("Could not load conversations — try again.");
    }
  }

  async function messageMember(userId) {
    try {
      var r = await api("/api/chat/conversations", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ kind: "dm", user_id: userId }),
      });
      if (r.status === 401) { location.href = "/members"; return; }
      var d = await r.json();
      if (r.ok && d.ok && d.conversation && d.conversation.id) {
        location.href = "/hub/messages?conversation=" + encodeURIComponent(d.conversation.id);
      } else {
        location.href = "/hub/messages?with=" + encodeURIComponent(userId);
      }
    } catch (e) {
      // Chat not deployed yet — the messages page contract still applies.
      location.href = "/hub/messages?with=" + encodeURIComponent(userId);
    }
  }

  window.Brimwood = window.Brimwood || {};
  window.Brimwood.shareToDM = shareToDM;
  window.Brimwood.messageMember = messageMember;
  window.Brimwood.toast = toast;
})();
