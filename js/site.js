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
