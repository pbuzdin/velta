// news-pages.js — stable, incremental news pagination (pure string helpers,
// no DOM: imported by admin.js in the browser and by tools/news-pages.mjs
// and admin/admin.test.mjs in node).
//
// Pages are numbered from the OLDEST item: /news/page-1/ holds the 10
// oldest, page 2 the next 10, … Adding an item touches only the newest page
// (or creates the next one when the newest is full) — older pages never
// change, so their URLs and contents are stable. Pages link only to OLDER
// pages (rel="prev") and to /news/; they never link forward, which is what
// lets them stay frozen. <velta-news-pager> (js/site.js) adds the newer
// page links at view time from /news/'s data-pages. /news/ shows the newest 10 and lists every page.

export const PER_PAGE = 10;
export const SITE = "https://velta.cc";
const MARKERS = /<!--\s*CMS:START\s*-->([\s\S]*?)<!--\s*CMS:END\s*-->/;
const HEAD_LINK = /\n?[ \t]*<link rel="(?:canonical|prev|next)"[^>]*>/g;

export const pageUrl = (k) => `/news/page-${k}/`;
export const pagePath = (k) => `news/page-${k}/index.html`;

// The <li>…</li> items of the page's news list, in document order.
export function listItems(raw) {
  const m = raw.match(MARKERS);
  const body = m ? m[1] : raw;
  const ul = body.match(/<ul class="news-list">([\s\S]*?)<\/ul>/);
  if (!ul) return [];
  return [...ul[1].matchAll(/<li>[\s\S]*?<\/li>/g)].map((x) => x[0]);
}

// Number of archive pages /news/ currently lists (its pager carries it).
export function pageCountOf(indexRaw) {
  const m = indexRaw.match(/data-pages="(\d+)"/);
  return m ? Number(m[1]) : 0;
}

// Page links N..1 (newest page first); aria-current on the current one.
function pageLinks(count, current) {
  const out = [];
  for (let k = count; k >= 1; k--) {
    out.push(k === current
      ? `<li><a href="${pageUrl(k)}" aria-current="page" aria-label="Page ${k}">${k}</a></li>`
      : `<li><a href="${pageUrl(k)}" aria-label="Page ${k}">${k}</a></li>`);
  }
  return `<ol class="news-pages">${out.join("")}</ol>`;
}

const list = (items) => `<ul class="news-list">\n${items.map((li) => `  ${li}`).join("\n")}\n</ul>`;

export function indexBody(items, pageCount) {
  const nav = pageCount
    ? `\n<nav class="news-pager" aria-label="Older news" data-pages="${pageCount}">
  <h2>Older news</h2>
  <p>Archive pages, numbered from the first post.</p>
  ${pageLinks(pageCount, 0)}
</nav>`
    : "";
  return `<h1>News</h1>
<p>Release notes and one guide to how a message moves. No mailing list.</p>
${list(items.slice(0, PER_PAGE))}${nav}`;
}

export function pageBody(k, items) {
  const older = k > 1
    ? `<a class="news-older" rel="prev" href="${pageUrl(k - 1)}">← Older</a>`
    : "";
  return `<p><a href="/news/">News</a></p>
<h1>News, page ${k}</h1>
<p>An archive page. <a href="/news/">Latest news</a></p>
${list(items)}
<velta-news-pager data-page="${k}"><nav class="news-pager" aria-label="News pages">
  ${older}
  ${pageLinks(k, k)}
  <a class="news-latest" href="/news/">Latest news →</a>
</nav></velta-news-pager>`;
}

// Swap title/description/canonical/prev in a full document (the /news/
// index serves as the chrome template for archive pages).
export function withHead(raw, { title, description, canonical, prev }) {
  let out = raw.replace(HEAD_LINK, "");
  if (title) out = out.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${title}</title>`);
  if (description) out = out.replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${description}">`);
  const links = [`<link rel="canonical" href="${SITE}${canonical}">`];
  if (prev) links.push(`<link rel="prev" href="${SITE}${prev}">`);
  return out.replace(/(\n[ \t]*<link rel="stylesheet"[^>]*>)/, (m) => `${m}\n  ${links.join("\n  ")}`);
}

export const spliceBody = (raw, body) =>
  raw.replace(MARKERS, () => `<!-- CMS:START -->\n${body}\n<!-- CMS:END -->`);

export function pageDoc(templateRaw, k, items) {
  return spliceBody(withHead(templateRaw, {
    title: `News, page ${k} — Velta`,
    description: `Velta news archive, page ${k}.`,
    canonical: pageUrl(k),
    prev: k > 1 ? pageUrl(k - 1) : "",
  }), pageBody(k, items));
}

export function indexDoc(indexRaw, items, pageCount) {
  return spliceBody(withHead(indexRaw, { canonical: "/news/" }), indexBody(items, pageCount));
}

// Plan the writes for one new item. `newestRaw` is the current newest page
// document (null when there are no pages yet). Returns
// [{ path, content, create }] — /news/ plus exactly one archive page.
export function planAdd({ indexRaw, newestRaw, pageCount, li }) {
  const writes = [];
  const latest = [li, ...listItems(indexRaw)];
  let n = pageCount;
  const newest = newestRaw ? listItems(newestRaw) : [];
  if (n && newest.length < PER_PAGE) {
    writes.push({ path: pagePath(n), content: pageDoc(newestRaw, n, [li, ...newest]), create: false });
  } else {
    n += 1;
    writes.push({ path: pagePath(n), content: pageDoc(indexRaw, n, [li]), create: true });
  }
  writes.push({ path: "news/index.html", content: indexDoc(indexRaw, latest, n), create: false });
  return writes;
}
