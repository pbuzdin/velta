// link-preview.js — OG preview card for the FIRST link in a message text.
// Fetches shell-side (fetch_link_preview command, CSP: renderer has no
// remote reach), in-memory cache per URL, and a user setting
// (localStorage["velta-link-preview"] === "1") that gates rendering.
import { escapeHtml, escapeAttr } from "./components.js";
import { parseInviteLink } from "./invites.js";

const CACHE = new Map(); // url -> {title, description, image} | null (failed)
const SETTING_KEY = "velta-link-preview";
const PER_CHAT_KEY = "velta-link-preview-chats"; // { [chatId]: "on" | "off" }

// Shown before any path turns previews on. The fetch is this device's IP,
// and a person in the chat may control the page that receives it.
export const LINK_PREVIEW_IP_WARNING =
  "A link preview is loaded from this device, so the website learns your IP address. Someone in a private or group chat may own that site, or be able to edit the page, and can send you the link so the preview reveals your address to them.";

// Global drawer setting. Per-chat overrides win: a chat with an explicit
// entry renders (or not) regardless of the global value.
// "1" = on. Unset and the old "0" are off (#30). Installs that never chose
// start off, including ones that were implicitly on before this default.
export function linkPreviewEnabled(chatId = null) {
  try {
    if (chatId != null) {
      const per = JSON.parse(localStorage.getItem(PER_CHAT_KEY) || "{}");
      if (per[chatId]) return per[chatId] === "on";
    }
    return localStorage.getItem(SETTING_KEY) === "1";
  } catch { return false; }
}

export function setLinkPreviewEnabled(on, chatId = null) {
  try {
    if (chatId != null) {
      const per = JSON.parse(localStorage.getItem(PER_CHAT_KEY) || "{}");
      if (on === null) delete per[chatId]; // back to global default
      else per[chatId] = on ? "on" : "off";
      localStorage.setItem(PER_CHAT_KEY, JSON.stringify(per));
      return;
    }
    if (on) localStorage.setItem(SETTING_KEY, "1");
    else localStorage.removeItem(SETTING_KEY);
  } catch {}
}

// First http(s) URL in the raw text: markdown [label](url) forms first (the
// label may hide the actual address), then bare URLs. Skips invite links —
// those already render as invite cards via markdown.js.
export function firstLink(text) {
  const t = String(text || "");
  const md = /\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)/.exec(t);
  if (md) return md[1];
  const bare = /\bhttps?:\/\/[^\s<>"')\]]+/.exec(t);
  return bare ? bare[0] : null;
}

function isDeltachatIdHost(url) {
  try {
    return new URL(url).hostname === "deltachat.id";
  } catch {
    return false;
  }
}

function invoke(cmd, args) {
  try {
    const tauri = window.__TAURI__;
    const fn = tauri?.core?.invoke || tauri?.invoke;
    if (!fn) return null;
    return fn(cmd, args);
  } catch { return null; }
}

let inFlight = new Map(); // url -> Promise (dedupe concurrent renders)

// Resolves {title, description, image} or null (off/disabled/failed/no Tauri).
export async function linkPreview(text, chatId = null) {
  if (!linkPreviewEnabled(chatId)) return null;
  const url = firstLink(text);
  if (!url || !/^https:\/\//.test(url)) return null;
  // Invite links on the registered domains render as invite cards in the
  // bubble — an OG web preview of the same URL is duplication, and the
  // fetch would leak the invite URL (fingerprint included) to the web.
  // deltachat.id short links render as those cards too; the rest of that
  // host is the same username service, so the whole host stays unfetched.
  if (parseInviteLink(url) || isDeltachatIdHost(url)) return null;
  if (CACHE.has(url)) return CACHE.get(url);
  if (inFlight.has(url)) return inFlight.get(url);
  const p = invoke("fetch_link_preview", { url })
    .then((r) => {
      const v = r && (r.title || r.description || r.image) ? r : null;
      CACHE.set(url, v);
      inFlight.delete(url);
      return v;
    })
    .catch(() => {
      CACHE.set(url, null);
      inFlight.delete(url);
      return null;
    });
  inFlight.set(url, p);
  return p;
}

export function linkPreviewCardHtml(preview, url) {
  if (!preview) return "";
  const img = preview.image
    ? `<img class="lp-img" src="${escapeAttr(preview.image)}" alt="" loading="lazy" draggable="false">`
    : "";
  const desc = preview.description
    ? `<span class="lp-desc">${escapeHtml(preview.description)}</span>`
    : "";
  const title = preview.title || url;
  return `<a class="link-preview" href="${escapeAttr(url)}" target="_blank" rel="noopener" draggable="false">` +
    img +
    `<span class="lp-body"><span class="lp-host">${escapeHtml(hostOf(url))}</span>` +
    `<span class="lp-title">${escapeHtml(title)}</span>${desc}</span></a>`;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
