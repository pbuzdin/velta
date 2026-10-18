(function () {
  var key = "velta-theme";

  function stored() {
    try {
      var value = localStorage.getItem(key);
      if (value === "light" || value === "dark") return value;
    } catch (error) {
      /* private mode */
    }
    return "system";
  }

  function darkNow(choice) {
    if (choice === "dark") return true;
    if (choice === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function apply(choice) {
    var root = document.documentElement;
    if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
    else root.removeAttribute("data-theme");
    try {
      if (choice === "system") localStorage.removeItem(key);
      else localStorage.setItem(key, choice);
    } catch (error) {
      /* ignore */
    }
    var inputs = document.querySelectorAll('input[name="theme"], input[name="theme-menu"]');
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = inputs[i].value === choice;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", darkNow(choice) ? "#0f0f14" : "#f4f4f4");
  }

  apply(stored());
  document.addEventListener("change", function (event) {
    var target = event.target;
    if (target && (target.name === "theme" || target.name === "theme-menu")) apply(target.value);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (stored() === "system") apply("system");
  });

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
        for (var i = 0; i < links.length; i++) {
          var li = document.createElement("li");
          li.appendChild(document.adoptNode(links[i].cloneNode(true)));
          notes.appendChild(li);
        }
      })
      .catch(function () { /* offline: heading and link still work */ });
  }
})();
