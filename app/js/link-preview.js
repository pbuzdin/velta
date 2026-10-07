// link-preview.js — OG preview card for the FIRST link in a message text.
// Fetches shell-side (fetch_link_preview command, CSP: renderer has no
// remote reach), in-memory cache per URL, and a user setting
// Drawer radios: off, "picture" (sender bakes a WebP, #88), "fetch"
// (this device loads the card, #30). Old "1" / per-chat "on" are fetch.
import { escapeHtml, escapeAttr } from "./components.js";
import { parseInviteLink } from "./invites.js";

const CACHE = new Map(); // url -> {title, description, image} | null (failed)
const SETTING_KEY = "velta-link-preview";
const PER_CHAT_KEY = "velta-link-preview-chats"; // { [chatId]: "off" | "picture" | "fetch" }

// Drawer hint under Link previews. The fetch is this device's IP.
export const LINK_PREVIEW_IP_WARNING =
  "A link preview is loaded from this device, so the website learns your IP address. Someone in a private or group chat may own that site, or be able to edit the page, and can send you the link so the preview reveals your address to them.";

export const LINK_PREVIEW_LABELS = {
  off: "Off",
  picture: "Send a picture",
  fetch: "Load on this device",
};

// "1" and per-chat "on" are the old single switch: this device fetched.
function storedMode(raw) {
  if (raw === "picture" || raw === "fetch" || raw === "off") return raw;
  if (raw === "1" || raw === "on") return "fetch";
  return "off";
}

// Per-chat entry wins. Missing entry follows the drawer. Unset and "0" are off.
export function linkPreviewMode(chatId = null) {
  try {
    if (chatId != null) {
      const per = JSON.parse(localStorage.getItem(PER_CHAT_KEY) || "{}");
      if (per[chatId] != null) return storedMode(per[chatId]);
    }
    return storedMode(localStorage.getItem(SETTING_KEY));
  } catch { return "off"; }
}

// chatId + mode null clears that chat's override. Off removes the global key.
export function setLinkPreviewMode(mode, chatId = null) {
  try {
    if (chatId != null) {
      const per = JSON.parse(localStorage.getItem(PER_CHAT_KEY) || "{}");
      if (mode == null) delete per[chatId];
      else per[chatId] = storedMode(mode);
      localStorage.setItem(PER_CHAT_KEY, JSON.stringify(per));
      return;
    }
    const next = storedMode(mode);
    if (next === "off") localStorage.removeItem(SETTING_KEY);
    else localStorage.setItem(SETTING_KEY, next);
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

// https URL worth a sender-side card, or null. A half-typed host (no dot)
// is not fetched. Dismiss is the exact URL the user crossed out.
export function senderPreviewUrl(text, { enabled = false, hasFile = false, dismissed = null } = {}) {
  if (!enabled || hasFile) return null;
  const url = firstLink(text);
  if (!url || !/^https:\/\//.test(url)) return null;
  if (parseInviteLink(url) || isDeltachatIdHost(url)) return null;
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  if (!host.includes(".")) return null;
  if (dismissed && dismissed === url) return null;
  return url;
}

// Receive-time fetch is for plain text only. An image caption — including
// a card we baked — must not contact the site.
export function receiveFetchesPreview(viewtype) {
  return !viewtype || viewtype === "text";
}

// Greedy word wrap. `measure` returns a width in the same unit as maxW.
export function wrapLines(text, maxW, measure) {
  const lines = [];
  let line = "";
  for (const w of String(text || "").split(/\s+/).filter(Boolean)) {
    const next = line ? line + " " + w : w;
    if (line && measure(next) > maxW) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function invoke(cmd, args) {
  try {
    const tauri = window.__TAURI__;
    const fn = tauri?.core?.invoke || tauri?.invoke;
    if (!fn) return Promise.resolve(null);
    return fn(cmd, args);
  } catch { return Promise.resolve(null); }
}

let inFlight = new Map(); // url -> Promise (dedupe concurrent renders)

// Resolves {title, description, image} or null (off/failed/no Tauri).
// `picture` may call this from the composer. Incoming rows must call it
// only for `fetch` — a picture-mode receive must not contact the site.
export async function linkPreview(text, chatId = null) {
  if (linkPreviewMode(chatId) === "off") return null;
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

export function linkPreviewCardHtml(preview, url, { link = true } = {}) {
  if (!preview) return "";
  const img = preview.image
    ? `<img class="lp-img" src="${escapeAttr(preview.image)}" alt="" loading="lazy" draggable="false">`
    : "";
  const desc = preview.description
    ? `<span class="lp-desc">${escapeHtml(preview.description)}</span>`
    : "";
  const title = preview.title || url;
  const attrs = link ? ` href="${escapeAttr(url)}" target="_blank" rel="noopener"` : "";
  const tag = link ? "a" : "div";
  return `<${tag} class="link-preview"${attrs} draggable="false">` +
    img +
    `<span class="lp-body"><span class="lp-host">${escapeHtml(hostOf(url))}</span>` +
    `<span class="lp-title">${escapeHtml(title)}</span>${desc}</span></${tag}>`;
}

const CARD_W = 480;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}

// One 480px card in Velta's dark colors (the picture is frozen for other
// clients). WebP, JPEG if this webview's toBlob ignores WebP.
export async function renderPreviewImage(preview, url) {
  if (!preview || typeof document === "undefined" || !document.createElement) return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  let photo = null;
  if (preview.image) {
    try { photo = await loadImage(preview.image); } catch { photo = null; }
  }
  const pad = 16;
  const maxW = CARD_W - pad * 2;
  const measure = (font) => (s) => { ctx.font = font; return ctx.measureText(s).width; };
  const title = preview.title || hostOf(url);
  const titleLines = wrapLines(title, maxW, measure("600 22px sans-serif")).slice(0, 2);
  const descLines = preview.description
    ? wrapLines(preview.description, maxW, measure("16px sans-serif")).slice(0, 3)
    : [];
  const landscape = photo && photo.width >= photo.height;
  const imgH = photo ? (landscape ? Math.max(1, Math.round(CARD_W * photo.height / photo.width)) : 220) : 0;
  const textH = 16 + 18 + 8 + titleLines.length * 28 + (descLines.length ? 8 + descLines.length * 22 : 0) + 16;
  // 2x bitmap so the chip's "t" survives being shown smaller and WebP compression.
  canvas.width = CARD_W * 2;
  canvas.height = (imgH + textH) * 2;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.fillStyle = "#1c1c26";
  ctx.fillRect(0, 0, CARD_W, imgH + textH);
  if (photo && landscape) {
    ctx.drawImage(photo, 0, 0, CARD_W, imgH);
  } else if (photo) {
    const scale = Math.max(CARD_W / photo.width, imgH / photo.height);
    const sw = CARD_W / scale;
    const sh = imgH / scale;
    ctx.drawImage(photo, (photo.width - sw) / 2, (photo.height - sh) / 2, sw, sh, 0, 0, CARD_W, imgH);
  }
  const sign = "Sent with Velta";
  const signFont = "600 16px \"Segoe UI\", Roboto, sans-serif";
  ctx.font = signFont;
  const chipW = Math.ceil(ctx.measureText(sign).width) + 20;
  const chipH = 28;
  const chipX = CARD_W - 10 - chipW;
  const chipY = 10;
  let y = imgH + 16;
  const hostMax = photo ? maxW : Math.max(40, chipX - pad - 8);
  const host = wrapLines(hostOf(url), hostMax, measure("14px sans-serif"))[0] || "";
  ctx.fillStyle = "#8f8f9c";
  ctx.font = "14px sans-serif";
  ctx.fillText(host, pad, y + 14);
  y += 26;
  ctx.fillStyle = "#f2f2f5";
  ctx.font = "600 22px sans-serif";
  for (const line of titleLines) { ctx.fillText(line, pad, y + 20); y += 28; }
  ctx.fillStyle = "#b7b7c2";
  ctx.font = "16px sans-serif";
  y += 4;
  for (const line of descLines) { ctx.fillText(line, pad, y + 16); y += 22; }
  ctx.beginPath();
  const r = 6;
  ctx.moveTo(chipX + r, chipY);
  ctx.arcTo(chipX + chipW, chipY, chipX + chipW, chipY + chipH, r);
  ctx.arcTo(chipX + chipW, chipY + chipH, chipX, chipY + chipH, r);
  ctx.arcTo(chipX, chipY + chipH, chipX, chipY, r);
  ctx.arcTo(chipX, chipY, chipX + chipW, chipY, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(15,15,20,0.78)";
  ctx.fill();
  ctx.strokeStyle = "rgba(242,242,245,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = signFont;
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "#f2f2f5";
  ctx.strokeText(sign, chipX + 10, chipY + 19);
  ctx.fillStyle = "#f2f2f5";
  ctx.fillText(sign, chipX + 10, chipY + 19);
  const encode = (type) => new Promise(res => canvas.toBlob(res, type, 0.72));
  const webp = await encode("image/webp");
  if (webp && webp.type === "image/webp") return webp;
  return encode("image/jpeg");
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
