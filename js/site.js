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
      var links = doc.querySelectorAll("main.news ul a");
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
