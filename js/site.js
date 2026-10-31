(function () {
  // "Latest release: vX.Y.Z" — the markup carries the version as static
  // text (release.yml rewrites it on the website branch); /version.txt is
  // the same release's version.txt, copied here by release.yml, so a page
  // served from cache still picks up the newest number. Same-origin: the
  // GitHub download URL sends no CORS headers.
  var el = document.querySelector("[data-latest-version]");
  if (!el || !window.fetch) return;
  fetch("/version.txt", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.text() : ""; })
    .then(function (t) {
      t = t.trim().replace(/^v/, "");
      if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(t)) el.textContent = "v" + t;
    })
    .catch(function () { /* keep the static text */ });
})();

(function () {
  // Any empty .news-list on the page (the home #notes mirror, the 404
  // recovery block) gets the latest 3 notes from the news index.
  // Progressive enhancement — without JS the lists stay empty and the
  // plain links still work.
  // (Browser-chrome theming needs no script: the theme-color meta tags on
  // each page carry media attributes for light/dark.)
  var lists = [].slice.call(document.querySelectorAll(".news-list")).filter(
    function (ul) { return !ul.children.length; }
  );
  if (!lists.length) return;
  fetch("/news/")
    .then(function (response) { return response.ok ? response.text() : ""; })
    .then(function (html) {
      if (!html) return;
      var doc = new DOMParser().parseFromString(html, "text/html");
      var links = doc.querySelectorAll("main.news ul.news-list a");
      if (!links.length) return;
      lists.forEach(function (notes) {
        notes.innerHTML = "";
        for (var i = 0; i < links.length && i < 3; i++) {
          var li = document.createElement("li");
          li.appendChild(document.adoptNode(links[i].cloneNode(true)));
          notes.appendChild(li);
        }
      });
    })
    .catch(function () { /* offline: heading and link still work */ });
})();

// <velta-news-pager data-page="k"> wraps the static archive-page nav
// (/news/page-k/). Archive pages are frozen: their HTML only knows older
// pages. This adds the NEWER page numbers and a "Newer →" link from the
// page count /news/ carries (data-pages="N" on its pager). No JS or a
// failed fetch: the static older links still work.
if (window.customElements && !customElements.get("velta-news-pager")) {
  customElements.define("velta-news-pager", class extends HTMLElement {
    connectedCallback() {
      var self = this, k = Number(this.getAttribute("data-page"));
      if (!k || this._done || !window.fetch) return;
      this._done = true;
      fetch("/news/", { cache: "no-cache" })
        .then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (html) {
          var m = /data-pages="(\d+)"/.exec(html || "");
          var n = m ? Number(m[1]) : 0;
          var ol = self.querySelector("ol.news-pages");
          if (!ol || n <= k) return;
          var first = ol.firstChild;
          for (var p = n; p > k; p--) {
            var li = document.createElement("li");
            var a = document.createElement("a");
            a.href = "/news/page-" + p + "/";
            a.setAttribute("aria-label", "Page " + p);
            a.textContent = String(p);
            li.appendChild(a);
            ol.insertBefore(li, first);
          }
          var newer = document.createElement("a");
          newer.className = "news-newer";
          newer.href = "/news/page-" + (k + 1) + "/";
          newer.textContent = "Newer →";
          var latest = self.querySelector(".news-latest");
          if (latest) latest.parentNode.insertBefore(newer, latest);
        })
        .catch(function () { /* static older links still work */ });
    }
  });
}

// <velta-share>: one icon button in a news POST's meta row
// ("29 October 2026 · 4 min read"). Created by JS only — without JS there
// is no dead button. navigator.share → "Share" (native sheet); otherwise
// "Copy link" with a polite "Copied" status. Not on news lists.
(function () {
  if (!window.customElements || customElements.get("velta-share")) return;
  var SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  var ICON_SHARE = SVG + '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  var ICON_LINK = SVG + '<path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1"/><path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"/></svg>';
  var url = function () {
    var c = document.querySelector('link[rel="canonical"]');
    return c ? c.href : location.origin + location.pathname;
  };
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  customElements.define("velta-share", class extends HTMLElement {
    connectedCallback() {
      if (this.firstChild) return;
      var share = typeof navigator.share === "function";
      var label = share ? "Share" : "Copy link";
      this.innerHTML = '<button type="button" class="share-btn">' + (share ? ICON_SHARE : ICON_LINK) +
        '<span class="share-label">' + label + '</span></button><span class="share-status" role="status" aria-live="polite"></span>';
      var btn = this.firstChild, text = btn.lastChild, status = this.lastChild, timer;
      // "Copied" swaps the visible label briefly; the live region announces it.
      var say = function (t) {
        text.textContent = t;
        status.textContent = t;
        clearTimeout(timer);
        timer = setTimeout(function () { text.textContent = label; status.textContent = ""; }, 2000);
      };
      btn.addEventListener("click", function () {
        var u = url();
        if (share) {
          navigator.share({ title: document.title, url: u }).catch(function () { /* cancelled */ });
          return;
        }
        var done = function () { say("Copied"); };
        var fail = function () { if (legacyCopy(u)) done(); else { window.prompt("Copy this link:", u); } };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(done, fail);
        else fail();
      });
    }
  });
  // A post page: /news/<slug>.html with a "N min read" meta row.
  if (!/^\/news\/[^/]+\.html$/.test(location.pathname)) return;
  var rows = document.querySelectorAll("main p");
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i];
    if (p.firstElementChild && p.firstElementChild.tagName === "TIME" && /min read\s*$/.test(p.textContent)) {
      p.classList.add("post-meta");
      p.appendChild(document.createElement("velta-share"));
      break;
    }
  }
})();
