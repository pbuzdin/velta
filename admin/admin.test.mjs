// admin.test.mjs — runnable checks for the assembler logic in admin.js.
//
// The helpers here are a deliberate mirror of the pure functions in
// admin.js (nav/footer assembly, include expansion/collapse, marker
// splicing): importing admin.js directly would need a browser, since it
// registers a custom element at import time. If you change a helper in
// admin.js, change its mirror here and add a case.
//
// Run: node admin/admin.test.mjs   (exit 0 = all pass)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const START = "<!-- CMS:START -->";
const END = "<!-- CMS:END -->";
const MARKERS = /<!--\s*CMS:START\s*-->([\s\S]*?)<!--\s*CMS:END\s*-->/;

const INCLUDE = /<!--\s*include:([a-z0-9-]+)\s*-->([\s\S]*?<!--\s*\/include:\1\s*-->)?/g;
const expandIncludes = (body, blocks) =>
  body.replace(INCLUDE, (m, name) =>
    Object.prototype.hasOwnProperty.call(blocks, name)
      ? `<!-- include:${name} -->\n${blocks[name].trim()}\n<!-- /include:${name} -->`
      : m,
  );
const collapseIncludes = (body) =>
  body.replace(/(<!--\s*include:[a-z0-9-]+\s*-->)[\s\S]*?<!--\s*\/include:[a-z0-9-]+\s*-->/g, "$1");

const titleOf = (raw) =>
  ((raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "Velta").trim();
const descriptionOf = (raw) =>
  ((raw.match(/name="description" content="([^"]*)"/) || [])[1] || "").trim();
const activeOf = (raw) => {
  const href = (raw.match(/<a href="([^"]+)" aria-current="page"/) || [])[1];
  return href ? href.replace(".html", "").replace("./", "home").replace(/[^a-z0-9-]/g, "") : "";
};
const mainClassOf = (raw) =>
  (raw.match(/<main id="content"(?: class="([^"]*)")?>/) || [])[1] || "";

function applyActive(nav, active) {
  if (active && nav.includes(` data-nav="${active}"`)) {
    nav = nav.replace(` data-nav="${active}"`, ' aria-current="page"');
  }
  return nav.replace(/ data-nav="[a-z0-9-]+"/g, "");
}

const indent = (block) =>
  block
    .split("\n")
    .map((line) => (line.trim() ? "    " + line : line))
    .join("\n");

const spliceBody = (raw, body) =>
  raw.replace(MARKERS, () => `${START}\n${body.replace(/^\n+|\n+$/g, "")}\n${END}`);

function assemble({ nav, footer, body, title, description, active, mainClass }) {
  const cls = mainClass ? ` class="${mainClass}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <title>${title}</title>
  <meta name="theme-color" content="#0f0f14">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/velta.css">
  <script>try{var t=localStorage.getItem("velta-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}</script>
</head>
<body>
  <a href="#content">Skip to content</a>
${applyActive(nav, active).trimEnd()}
  <main id="content"${cls}>
${START}
${body.replace(/^\n+|\n+$/g, "")}
${END}
  </main>
${footer.trimEnd()}
  <script src="/js/site.js"></script>
</body>
</html>
`;
}

// --- tests ---
const nav = read("../_partials/nav.html");
const footer = read("../_partials/footer.html");
const about = read("../about.html");
const newsIndex = read("../news/index.html");
const aboutBody = about.match(MARKERS)[1];

const blocks = {
  downloads: "<ul>\n  <li><a href=\"#\">Android</a></li>\n</ul>\n",
  cta: "<p class=\"cta\">$&pecial &quot;quote&quot; test</p>",
};

const cases = [];
const check = (name, ok) => cases.push([name, ok]);

// Assembly of about.html (no active nav key, .page main).
const out = assemble({
  nav,
  footer,
  body: aboutBody,
  title: titleOf(about),
  description: descriptionOf(about),
  active: activeOf(about),
  mainClass: mainClassOf(about),
});
check("no aria-current on about", !out.includes("aria-current"));
check("no data-nav left", !out.includes("data-nav"));
check("title preserved", out.includes("<title>About — Velta</title>"));
check("desc preserved", out.includes("About Velta — one web frontend"));
check("mainClass preserved", out.includes('<main id="content" class="page">'));
check("body between markers", out.includes(`${START}\n<p class="kicker">Project</p>\n<h1>About</h1>`));
check("footer present", out.includes("Independent client. Delta Chat and Chatmail are upstream projects."));
check("theme script present", out.includes("velta-theme"));
check("site.js present", out.includes('<script src="/js/site.js"></script>'));

// News page: active key lands on the News link.
const newsOut = assemble({
  nav,
  footer,
  body: "<p>x</p>",
  title: "News — Velta",
  description: "D",
  active: "news",
  mainClass: "news",
});
check("news active on News link", newsOut.includes('<a href="/news" aria-current="page">News</a>'));
check("news: one aria-current only", (newsOut.match(/aria-current/g) || []).length === 1);
check("news mainClass", newsOut.includes('<main id="content" class="news">'));

// Extraction from real pages.
check("activeOf news index", activeOf(newsIndex) === "news");
check("mainClassOf news index", mainClassOf(newsIndex) === "news");
check("mainClassOf about", mainClassOf(about) === "page");

// Splice round trip; $& in content must survive (function replacement).
const spliced = spliceBody(out, "a $& b <i>c</i>");
check("dollar-safe splice", spliced.includes("a $& b <i>c</i>") && !spliced.includes("aria-current"));

// Include system.
const bare = expandIncludes("<p>x</p>\n<!-- include:downloads -->\n<p>y</p>", blocks);
check("bare expands to pair+content", bare.includes("<!-- include:downloads -->\n<ul>") && bare.includes("<!-- /include:downloads -->"));
check("bare keeps surrounding text", bare.startsWith("<p>x</p>") && bare.trimEnd().endsWith("<p>y</p>"));

const cached = "<!-- include:downloads -->\n<em>OLD STALE COPY</em>\n<!-- /include:downloads -->";
const refreshed = expandIncludes(cached, blocks);
check("cached pair refreshes", refreshed.includes("<ul>") && !refreshed.includes("OLD STALE COPY"));
check("refreshed has exactly one pair", (refreshed.match(/include:downloads/g) || []).length === 2);

check("unknown left as-is", expandIncludes("<!-- include:nope -->", blocks) === "<!-- include:nope -->");

const collapsed = collapseIncludes(refreshed);
check("collapse to bare directive", collapsed.trim() === "<!-- include:downloads -->");
check("round trip stable", expandIncludes(collapsed, blocks) === refreshed);

const dollar = expandIncludes("<!-- include:cta -->", blocks);
check("dollar-safe expansion", dollar.includes("$&pecial &quot;quote&quot; test"));

const two = expandIncludes("<!-- include:downloads -->\n<!-- include:cta -->", blocks);
check("two includes expand", two.includes("<ul>") && two.includes("cta"));
check("two collapse", collapseIncludes(two).trim() === "<!-- include:downloads -->\n<!-- include:cta -->");

const mixed = expandIncludes("<!-- include:cta -->\nstuff\n<!-- /include:downloads -->", blocks);
check("backreference pairing", mixed.includes("cta") && mixed.includes("/include:downloads"));

let fail = 0;
for (const [name, ok] of cases) {
  console.log((ok ? "PASS" : "FAIL") + "  " + name);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
