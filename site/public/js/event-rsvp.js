/* Event detail page: load event + RSVP form. Extracted from
 * events/[slug].astro so the global CSP can drop 'unsafe-inline' for scripts.
 * Config comes from data attributes on #eventWrap: data-slug, data-api-base. */
(function () {
  var wrap = document.getElementById("eventWrap");
  if (!wrap) return;
  var slug = wrap.dataset.slug || "";
  var API_BASE = wrap.dataset.apiBase || "";

  var esc = function (s) { return String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var fmt = function (iso) {
    return new Date(iso).toLocaleString("en-CA", {
      weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  };

  (async function () {
    var body = document.getElementById("eventBody");
    try {
      var r = await fetch(API_BASE + "/api/events/" + encodeURIComponent(slug), {
        headers: { accept: "application/json" }
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok || !d.ok) throw new Error("not found");
      var e = d.event;
      document.title = e.title + " — Events — Brimwood Innovation";
      document.getElementById("eventLoading").style.display = "none";
      body.style.display = "block";
      var full = e.capacity && e.rsvp_count >= e.capacity;
      body.innerHTML =
        '<div class="kicker">' + esc(fmt(e.starts_at)) + (e.location ? " · " + esc(e.location) : "") + "</div>" +
        '<h1 class="sec" style="font-size:clamp(34px,5.4vw,56px);margin-bottom:18px;">' + esc(e.title) + "</h1>" +
        (e.description_md ? '<div class="prose" style="padding:0;max-width:none;"><p style="white-space:pre-wrap;">' + esc(e.description_md) + "</p></div>" : "") +
        '<p class="admin-muted" style="margin-top:16px;">' + e.rsvp_count + " going" + (e.capacity ? " · " + e.capacity + " spots" : "") + "</p>" +
        '<p style="margin-top:12px;"><a href="/events" style="font-size:14px;">← All events</a></p>';
      if (!full) {
        document.getElementById("rsvpSection").style.display = "block";
      } else {
        body.innerHTML += '<p class="sec-lede" style="margin-top:24px;font-weight:600;">This event is at capacity.</p>';
      }
    } catch (err) {
      document.getElementById("eventLoading").textContent = "Event not found.";
    }
  })();

  document.getElementById("rsvpForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var v = function (id) { return document.getElementById(id).value.trim(); };
    var btn = document.getElementById("rsvpBtn");
    var err = document.getElementById("rsvpErr");
    err.style.display = "none";
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      if (v("rSite")) { // honeypot: bot, silently accept
        document.getElementById("rsvpForm").style.display = "none";
        document.getElementById("rsvpThanks").style.display = "block";
        return;
      }
      var res = await fetch(API_BASE + "/api/events/" + encodeURIComponent(slug) + "/rsvp", {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({
          name: v("rName"),
          email: v("rEmail"),
          guests: v("rGuests"),
          website: "",
          "cf-turnstile-response": (document.querySelector('#rsvpForm [name="cf-turnstile-response"]') || {}).value || ""
        })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || "RSVP failed");
      document.getElementById("rsvpForm").style.display = "none";
      document.getElementById("rsvpThanks").style.display = "block";
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = "RSVP";
      err.textContent = ex.message;
      err.style.display = "block";
    }
  });
})();
