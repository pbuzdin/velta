(function () {
  // Mobile browser chrome color follows the OS theme; the page itself is
  // themed purely by prefers-color-scheme (see css/velta.css).
  var meta = document.querySelector('meta[name="theme-color"]');
  var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  function syncMeta() {
    if (meta) meta.setAttribute("content", darkQuery.matches ? "#0f0f14" : "#f4f4f4");
  }
  syncMeta();
  darkQuery.addEventListener("change", syncMeta);

  // Home page: mirror the news index list so publishing a post never
  // touches index.html. Progressive enhancement — without JS the section
  // shows just the heading and the "All notes" link.
  var notes = document.querySelector("#notes ul");
  if (notes && !notes.children.length) {
    fetch("/news/")
      .then(function (response) { return response.ok ? response.text() : ""; })
      .then(function (html) {
        if (!html) return;
        var doc = new DOMParser().parseFromString(html, "text/html");
        var links = doc.querySelectorAll("main.news ul a");
        if (!links.length) return;
        notes.innerHTML = "";
        for (var i = 0; i < links.length && i < 3; i++) {
          var li = document.createElement("li");
          li.appendChild(document.adoptNode(links[i].cloneNode(true)));
          notes.appendChild(li);
        }
      })
      .catch(function () { /* offline: heading and link still work */ });
  }
})();
