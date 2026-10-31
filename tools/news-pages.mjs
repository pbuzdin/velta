// One-off/maintenance: split the full list currently in news/index.html
// into archive pages (oldest first, 10 per page) and rewrite /news/ to the
// newest 10 + pager. Only for the initial split — afterwards the CMS
// (admin.js → admin/news-pages.js planAdd) appends incrementally.
// Run from the website checkout: node tools/news-pages.mjs --init
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { PER_PAGE, listItems, pageDoc, indexDoc, pagePath } from "../admin/news-pages.js";

if (!process.argv.includes("--init")) { console.error("usage: node tools/news-pages.mjs --init"); process.exit(2); }
if (existsSync(pagePath(1))) { console.error("pages already exist — the CMS appends from here"); process.exit(1); }
const indexRaw = readFileSync("news/index.html", "utf8");
const items = listItems(indexRaw);            // newest first
const chrono = [...items].reverse();          // oldest first
const pages = Math.ceil(chrono.length / PER_PAGE);
for (let k = 1; k <= pages; k++) {
  const slice = chrono.slice((k - 1) * PER_PAGE, k * PER_PAGE).reverse(); // newest first on the page
  mkdirSync(dirname(pagePath(k)), { recursive: true });
  writeFileSync(pagePath(k), pageDoc(indexRaw, k, slice));
}
writeFileSync("news/index.html", indexDoc(indexRaw, items, pages));
console.log(`${items.length} items → ${pages} page(s)`);
