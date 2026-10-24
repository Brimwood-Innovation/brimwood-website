/* Event detail page: load event + RSVP form. Extracted from
 * events/[slug].astro so the global CSP can drop 'unsafe-inline' for scripts.
 * Config comes from data attributes on #eventWrap: data-slug, data-api-base.
 * Phase 2 slice 3: the render follows prototype section 06 (breadcrumb,
 * deck date line, seats taken with progress, RSVP and Add to calendar
 * actions, guest pass note, Full state). The calendar file is built
 * from the fetched event; no account needed. */
(function () {
  var wrap = document.getElementById("eventWrap");
  if (!wrap) return;
  var slug = wrap.dataset.slug || "";
  var API_BASE = wrap.dataset.apiBase || "";

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  /* Deck format (prototype section 06): "Wed, Oct 14, 6:30 p.m.".
   * Times show in America/Toronto, the stored zone (R5). */
  var fmt = function (iso) {
    return new Date(iso).toLocaleString("en-CA", {
      timeZone: "America/Toronto",
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  };

  /* Calendar file, built from the fetched event. No account needed. */
  var icsEscape = function (s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  };
  var icsDate = function (iso) {
    return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  };
  var downloadIcs = function (e) {
    var start = new Date(e.starts_at);
    var end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 2 * 60 * 60 * 1000);
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Brimwood Innovation//Events//EN",
      "BEGIN:VEVENT",
      "UID:" + e.slug + "@brimwoodinnovation.com",
      "DTSTAMP:" + icsDate(new Date().toISOString()),
      "DTSTART:" + icsDate(start.toISOString()),
      "DTEND:" + icsDate(end.toISOString()),
      "SUMMARY:" + icsEscape(e.title),
      "LOCATION:" + icsEscape(e.location || ""),
      "DESCRIPTION:" + icsEscape(e.description_md || ""),
      "URL:https://brimwoodinnovation.com/events/" + e.slug,
      "END:VEVENT",
      "END:VCALENDAR"
    ];
    var blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = e.slug + ".ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
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
      // Keep the head meta in sync for crawlers and link previews.
      var metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc && e.description_md) {
        metaDesc.setAttribute("content", String(e.description_md).slice(0, 160));
      }
      document.getElementById("eventLoading").style.display = "none";
      body.style.display = "block";
      var full = e.capacity && e.rsvp_count >= e.capacity;
      var seats = "";
      if (e.capacity) {
        var left = Math.max(0, e.capacity - e.rsvp_count);
        var pct = Math.min(100, Math.round((e.rsvp_count / e.capacity) * 100));
        seats =
          '<p aria-live="polite"><b>' + e.rsvp_count + " of " + e.capacity + " seats taken.</b> " + left + " left." +
          (full ? ' <span class="full-badge">Full</span>' : "") + "</p>" +
          '<div class="event-progress" aria-hidden="true"><i style="width:' + pct + '%"></i></div>';
      } else {
        seats = '<p aria-live="polite"><b>' + e.rsvp_count + " going.</b></p>";
      }
      body.innerHTML =
        '<nav class="crumbs" aria-label="Breadcrumb"><a href="/events">Events</a>' +
        ' <span aria-hidden="true">/</span> <span aria-current="page">' + esc(e.title) + "</span></nav>" +
        '<h1 class="sec" style="font-size:clamp(34px,5.4vw,56px);margin-bottom:14px;">' + esc(e.title) + "</h1>" +
        '<p class="event-sub">' + esc(fmt(e.starts_at)) + (e.location ? " · " + esc(e.location) : "") + "</p>" +
        (e.description_md ? '<div class="prose" style="padding:0;max-width:none;"><p style="white-space:pre-wrap;">' + esc(e.description_md) + "</p></div>" : "") +
        '<div class="event-seats">' + seats + "</div>" +
        '<div class="event-actions">' +
        (full ? "" : '<a class="btn" href="#rsvp">RSVP</a>') +
        '<button type="button" class="btn btn-ghost" id="icsBtn">Add to calendar</button></div>' +
        '<p class="admin-muted" style="margin-top:16px;">Visitors come with a guest pass from a member host. Access details are on the house info page.</p>' +
        '<p style="margin-top:12px;"><a href="/events" style="font-size:14px;">← All events</a></p>';
      if (!full) {
        document.getElementById("rsvpSection").style.display = "block";
      } else {
        body.innerHTML += '<p class="sec-lede" style="margin-top:24px;font-weight:600;">This event is full.</p>';
      }
      document.getElementById("icsBtn").addEventListener("click", function () { downloadIcs(e); });
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
