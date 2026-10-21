(function () {
  // Home page: mirror the news index list so publishing a post never
  // touches index.html. Progressive enhancement — without JS the section
  // shows just the heading and the "All notes" link.
  // (Browser-chrome theming needs no script: the theme-color meta tags on
  // each page carry media attributes for light/dark.)
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
