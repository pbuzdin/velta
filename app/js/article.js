// Article card (#252). The message is plain text: one-line title, a blank
// line, the opening, a blank line, and one https URL on the last line.
// Velta paints that shape as a card. Other clients show the text.
// A short "see this\n\nhttps://…" note does not match.
//
// Detection: strict text shape, no marker. A marker other clients ignore
// needs a custom header or param on the message, which the core's send API
// does not expose for text (core change). An invisible character in the
// text would be shown, copied, or stripped unpredictably by other clients.
import { escapeHtml, escapeAttr } from "./components.js";
import { t } from "./i18n.js";
import { shellProxy } from "./link-preview.js";
import { tauriInvoke } from "./tauri.js";

const MIN_OPEN = 80;
const MAX_OPEN = 1200;
const PARSE_OPEN = 1500;
const MAX_TITLE = 200;

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function cleanOpening(opening) {
  const paras = String(opening || "").replace(/\r\n/g, "\n").trim()
    .split(/\n\n+/).map(s => s.trim()).filter(s => s && !/^https?:\/\/\S+$/.test(s));
  let open = paras.join("\n\n");
  if (open.length > MAX_OPEN) open = open.slice(0, MAX_OPEN).trim();
  return open.length >= MIN_OPEN ? open : "";
}

// Null when there is nothing worth sending (JS shell, failed extract).
export function formatArticleMessage({ title, opening, url }) {
  const u = String(url || "").trim();
  if (!/^https:\/\/\S+$/.test(u)) return null;
  let head = oneLine(title).slice(0, MAX_TITLE).trim();
  if (!head || /^https?:\/\//i.test(head)) head = hostOf(u);
  if (!head || head.length > MAX_TITLE || /^https?:\/\//i.test(head)) return null;
  const open = cleanOpening(opening);
  if (!open) return null;
  return `${head}\n\n${open}\n\n${u}`;
}

// Strict shape. The opening may contain links; a paragraph that is only a
// URL does not. Casual notes stay ordinary bubbles.
export function parseArticleMessage(text) {
  const parts = String(text || "").replace(/\r\n/g, "\n").trim().split(/\n\n/);
  if (parts.length < 3) return null;
  const url = parts[parts.length - 1].trim();
  if (!/^https:\/\/\S+$/.test(url)) return null;
  const title = parts[0].trim();
  if (!title || title.length > MAX_TITLE || title.includes("\n") || /^https?:\/\//i.test(title)) return null;
  const opening = parts.slice(1, -1).join("\n\n").trim();
  if (opening.length < MIN_OPEN || opening.length > PARSE_OPEN) return null;
  if (opening.split(/\n\n/).some(p => /^https?:\/\/\S+$/.test(p.trim()))) return null;
  return { title, opening, url };
}

// `link: false` for the composer ghost: an <a> there would navigate the webview.
export function articleCardHtml(a, { link = true } = {}) {
  if (!a) return "";
  const site = link
    ? `<a class="article-site" href="${escapeAttr(a.url)}">${escapeHtml(t("Open site"))}</a>`
    : `<button type="button" class="article-site" data-act="open-article">${escapeHtml(t("Open site"))}</button>`;
  return `<div class="msg-article">` +
    `<div class="article-host">${escapeHtml(hostOf(a.url))}</div>` +
    `<div class="article-title">${escapeHtml(a.title)}</div>` +
    `<div class="article-open">${escapeHtml(a.opening)}</div>` +
    `<div class="article-actions">` +
    `<button type="button" class="webxdc-start" data-act="read-article">${escapeHtml(t("Read"))}</button>` +
    site +
    `</div></div>`;
}

export async function fetchArticle(url) {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("fetch failed");
  const proxy = await shellProxy();
  return invoke("fetch_article", { url, proxy });
}
