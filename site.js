// site.js — shared chrome (header, nav, footer) + content loader for the
// static pages. Every page is a real .html document; it declares which body
// partial to load via <body data-page="about">, and this script fills the
// #site-header, #content and #site-footer placeholders. No build step.
(() => {
  const page = document.body.dataset.page || "home";

  const nav = [
    ["./", "Home", "home"],
    ["developing.html", "Developing", "developing"],
    ["comparison.html", "Compare", "comparison"],
    ["about.html", "About", "about"],
    ["https://github.com/pbuzdin/velta/releases", "Download", null],
    ["admin/", "Edit", null],
  ];

  const header = document.getElementById("site-header");
  if (header) {
    header.innerHTML = `
      <h1><a href="./" style="text-decoration:none;color:inherit">Velta</a></h1>
      <p>${nav
        .map(([href, label, key]) =>
          key === page
            ? `<a href="${href}" aria-current="page">${label}</a>`
            : `<a href="${href}">${label}</a>`,
        )
        .join(" · ")}</p>
      <hr />`;
  }

  const footer = document.getElementById("site-footer");
  if (footer) {
    footer.innerHTML = `<hr /><p>© ${new Date().getFullYear()} Velta</p>`;
  }

  const content = document.getElementById("content");
  if (content) {
    fetch(`content/${page}.html`)
      .then((r) => (r.ok ? r.text() : "<h2>Not found</h2>"))
      .then((html) => {
        content.innerHTML = html;
      })
      .catch(() => {
        content.innerHTML = "<h2>Offline</h2>";
      });
  }
})();
