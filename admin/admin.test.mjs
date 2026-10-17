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

function assemble({ nav, footer, body, title, description, active }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <title>${title}</title>
  <link rel="stylesheet" href="css/marx.min.css">
  <link rel="stylesheet" href="css/site.css">
</head>
<body>
  <main class="container">
${indent(applyActive(nav, active).trimEnd())}
    <article>
${START}
${body.replace(/^\n+|\n+$/g, "")}
${END}
    </article>
${indent(footer.trimEnd())}
  </main>
</body>
</html>
`;
}

// --- tests ---
const nav = read("../_partials/nav.html");
const footer = read("../_partials/footer.html");
const about = read("../about.html");
const body = about.match(MARKERS)[1];

const blocks = {
  downloads: "<ul>\n  <li><a href=\"#\">Android</a></li>\n</ul>\n",
  cta: "<p class=\"cta\">$&pecial &quot;quote&quot; test</p>",
};

const cases = [];
const check = (name, ok) => cases.push([name, ok]);

// Assembly from the real partials (about.html as the active page).
const out = assemble({
  nav,
  footer,
  body,
  title: titleOf(about),
  description: descriptionOf(about),
  active: activeOf(about),
});
check("active link on about", out.includes('<a href="about.html" aria-current="page">About</a>'));
check("no data-nav left", !out.includes("data-nav"));
check("title preserved", out.includes("<title>About — Velta</title>"));
check("desc preserved", out.includes("About Velta — one web frontend"));
check("body between markers", out.includes(`${START}\n<h2>About</h2>`));
check("one aria-current only", (out.match(/aria-current/g) || []).length === 1);
check("footer present", out.includes("© 2026 Velta"));

// Home as the active page.
const homeOut = assemble({ nav, footer, body: "<p>x</p>", title: "T", description: "D", active: "home" });
check("home active", homeOut.includes('<a href="./" aria-current="page">Home</a>'));

// Splice round trip; $& in content must survive (function replacement).
const spliced = spliceBody(out, "a $& b <i>c</i>");
check("dollar-safe splice", spliced.includes("a $& b <i>c</i>") && (spliced.match(/aria-current/g) || []).length === 1);

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
