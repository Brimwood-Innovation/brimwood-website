/* Deck command palette (Phase 5 follow-up, deck section 07).
 * Ctrl K (or Cmd K) and the hub search pill open an in-page palette
 * over the hub shell: people, feed posts, events, lessons, and blog
 * posts in one list, from the shipped /api/search and /api/people
 * endpoints. No new endpoint, no new dependency.
 *
 * Progressive enhancement: the search pill stays a plain link to
 * /search, so without this script it still reaches the full search
 * page. The palette itself needs JavaScript and fails silent when
 * its markup is absent.
 *
 * Safety: results are built with DOM APIs and textContent only, so
 * a title or excerpt can never inject markup. A result link is only
 * rendered when its URL is a same-site path (starts with "/").
 * Keyboard: ArrowDown from the input focuses the first result,
 * ArrowUp and ArrowDown move between results, ArrowUp on the first
 * result returns to the input, Enter follows the focused link, Esc
 * closes and returns focus to the search pill.
 */
(function () {
  var palette = document.getElementById("hubPalette");
  var input = document.getElementById("hubPaletteInput");
  var status = document.getElementById("hubPaletteStatus");
  var resultsBox = document.getElementById("hubPaletteResults");
  var pill = document.querySelector(".hub-search");
  if (!palette || !input || !status || !resultsBox) return;

  var shell = document.querySelector(".hub-ui");
  var apiBase = shell ? shell.getAttribute("data-api-base") || "" : "";
  var timer = null;
  var seq = 0;
  var lastFocus = null;

  function isSafePath(url) {
    return typeof url === "string" && url.charAt(0) === "/" && url.charAt(1) !== "/";
  }

  function group(title) {
    var wrap = document.createElement("div");
    wrap.className = "hub-palette-group";
    var head = document.createElement("div");
    head.className = "hub-palette-group-title";
    head.textContent = title;
    wrap.appendChild(head);
    var list = document.createElement("ul");
    list.className = "hub-palette-list";
    wrap.appendChild(list);
    return { wrap: wrap, list: list };
  }

  function row(title, sub, url) {
    var item = document.createElement("li");
    var link = document.createElement("a");
    link.className = "hub-palette-row";
    link.href = url;
    var name = document.createElement("span");
    name.className = "hub-palette-row-title";
    name.textContent = title;
    link.appendChild(name);
    if (sub) {
      var detail = document.createElement("span");
      detail.className = "hub-palette-row-sub";
      detail.textContent = sub;
      link.appendChild(detail);
    }
    item.appendChild(link);
    return item;
  }

  function focusResult(dir) {
    var links = resultsBox.querySelectorAll(".hub-palette-row");
    if (!links.length) return;
    var current = document.activeElement;
    var idx = -1;
    for (var i = 0; i < links.length; i++) {
      if (links[i] === current) { idx = i; break; }
    }
    if (dir > 0) {
      if (idx < links.length - 1) links[idx + 1].focus();
      else if (idx === -1) links[0].focus();
    } else {
      if (idx > 0) links[idx - 1].focus();
      else input.focus();
    }
  }

  function render(q, searchData, peopleData) {
    resultsBox.innerHTML = "";
    var groups = [];
    var total = 0;

    var people = (peopleData && peopleData.ok && Array.isArray(peopleData.people))
      ? peopleData.people : [];
    if (people.length) {
      var g = group("People");
      people.forEach(function (p) {
        if (!p.display_name || !isSafePath(p.profile_url)) return;
        var sub = [p.building_now, (p.skills || []).map(function (s) { return s.label; }).join(", ")]
          .filter(Boolean).join(" · ");
        g.list.appendChild(row(p.display_name, sub, p.profile_url));
      });
      if (g.list.childNodes.length) { groups.push(g.wrap); total += g.list.childNodes.length; }
    }

    var results = (searchData && searchData.ok && Array.isArray(searchData.results))
      ? searchData.results : [];
    var byType = { feed_post: [], event: [], lesson: [], post: [] };
    results.forEach(function (r) {
      if (byType[r.type] && r.title && isSafePath(r.url)) byType[r.type].push(r);
    });
    var labels = { feed_post: "Feed posts", event: "Events", lesson: "Lessons", post: "Blog posts" };
    ["feed_post", "event", "lesson", "post"].forEach(function (type) {
      if (!byType[type].length) return;
      var grp = group(labels[type]);
      byType[type].forEach(function (r) {
        grp.list.appendChild(row(r.title, r.excerpt || "", r.url));
      });
      groups.push(grp.wrap);
      total += byType[type].length;
    });

    groups.forEach(function (el) { resultsBox.appendChild(el); });
    if (total === 0) {
      status.textContent = "No results for \u201c" + q + "\u201d. Try different words.";
    } else {
      status.textContent = total + (total === 1 ? " result" : " results") + " for \u201c" + q + "\u201d.";
    }
  }

  function run(q) {
    var mySeq = ++seq;
    status.textContent = "Searching\u2026";
    resultsBox.innerHTML = "";
    Promise.all([
      fetch(apiBase + "/api/search?q=" + encodeURIComponent(q), {
        credentials: "include",
        headers: { accept: "application/json" },
      }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      // People are signed-in members only. A 401 hides the group
      // instead of breaking the palette.
      fetch(apiBase + "/api/people?q=" + encodeURIComponent(q), {
        credentials: "include",
        headers: { accept: "application/json" },
      }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    ]).then(function (pair) {
      if (mySeq !== seq) return;
      if (!pair[0] && !pair[1]) {
        status.textContent = "Search is unavailable right now. Please try again shortly.";
        return;
      }
      render(q, pair[0], pair[1]);
    });
  }

  function open() {
    lastFocus = document.activeElement;
    palette.removeAttribute("hidden");
    input.focus();
  }

  function close() {
    palette.setAttribute("hidden", "");
    if (timer) { clearTimeout(timer); timer = null; }
    seq++;
    input.value = "";
    resultsBox.innerHTML = "";
    status.textContent = "Type at least two characters to search.";
    if (pill) pill.focus();
    else if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  window.BrimwoodCommandPalette = { open: open, close: close };

  if (pill) {
    pill.addEventListener("click", function (e) {
      e.preventDefault();
      open();
    });
  }

  palette.querySelectorAll("[data-palette-close]").forEach(function (el) {
    el.addEventListener("click", close);
  });

  input.addEventListener("input", function () {
    if (timer) clearTimeout(timer);
    var q = input.value.trim();
    if (q.length < 2) {
      resultsBox.innerHTML = "";
      status.textContent = "Type at least two characters to search.";
      return;
    }
    timer = setTimeout(function () { run(q); }, 200);
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); focusResult(1); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  resultsBox.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); focusResult(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusResult(-1); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !palette.hasAttribute("hidden")) {
      e.preventDefault();
      close();
    }
  });
})();
