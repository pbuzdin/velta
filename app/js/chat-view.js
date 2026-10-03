// chat-view.js — virtualized message history (virtual-scroller) + composer
import { formatTime, formatDay, formatBytes } from "./format.js";
import { escapeHtml, escapeAttr, ticksSvg, setVideoLightboxOpener } from "./components.js";
import { showContextMenu, showModal, showStickerPicker, closeAllPopups, confirmDeleteMessagesModal, confirmModal, toast, openImageLightbox, openVideoLightbox, CLOSE_SVG } from "./ui.js";
import { diagnosticRow } from "./diagnostics.js";
import { openWebxdc, prefetchInfo, appIconUrl } from "./webxdc-manager.js";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🎉", "👏"];

// Decoded-dimension memory for media the core had no dimensions for: those
// rows reserve a 4:3 (image) / fixed-band (video) guess, and the true shape
// only lands at decode = a scroll jump. rememberMediaDims records the real
// W×H once seen; the next render reserves the exact box up front.
// ponytail: flat localStorage map, oldest-trimmed at 800 — a core that
// returns dimensions for everything makes this dead weight, delete then.
const DIMS_KEY = "velta-media-dims";
let _mediaDims = null;
function mediaDims(accountId, msgId) {
  if (!_mediaDims) {
    try { _mediaDims = new Map(Object.entries(JSON.parse(localStorage.getItem(DIMS_KEY) || "{}"))); }
    catch { _mediaDims = new Map(); }
  }
  return _mediaDims.get(`${accountId}:${msgId}`) || null;
}
function rememberMediaDims(accountId, msgId, w, h) {
  mediaDims(accountId, msgId); // ensure loaded
  _mediaDims.set(`${accountId}:${msgId}`, [w, h]);
  while (_mediaDims.size > 800) _mediaDims.delete(_mediaDims.keys().next().value);
  try { localStorage.setItem(DIMS_KEY, JSON.stringify(Object.fromEntries(_mediaDims))); } catch { /* full */ }
}

// app.js installs the avatar-profile opener (avoids a circular import);
// invoked when a group message's sender avatar is tapped.
let avatarProfileOpener = null;
export function setAvatarProfileOpener(fn) { avatarProfileOpener = fn; }

// Video playback routes through the fullscreen lightbox (ui.js) - injected
// here so <velta-video> (components.js) never imports ui.js directly.
setVideoLightboxOpener((src, name) => openVideoLightbox(src, name));

import { diagnosticsSink, debugLog } from "./diagnostics.js";
import { fileUrl, mediaFallbackUrl } from "./media.js";
import { openInAppBrowser } from "./inapp-browser.js";
import { renderMarkdown, extractBotCommands } from "./markdown.js";
import { lcRetryTransfer } from "./local-chat.js";
import { linkPreview, linkPreviewCardHtml, firstLink as firstLinkOf } from "./link-preview.js";
import { getReadMarker, clearReadMarker } from "./read-markers.js";

function reactionChipsHtml(reactions) {
  return (reactions || []).map(r =>
    `<span class="reaction-chip${r.mine ? " mine" : ""}" data-react="${escapeAttr(r.emoji)}">${escapeHtml(r.emoji)} ${Number(r.count) || 0}</span>`
  ).join("");
}

function rustLog(msg) {
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
}

// Error toast that ALSO lands in the Diagnostics chat (sink mirrors to
// velta.log): toasts vanish in 2-4 s, diagnostics persist for triage.
function errToast(text, ms = 3000) {
  diagnosticsSink.append("error", text);
  toast(text, ms, { danger: true });
}

// Image extensions the lightbox can show when native opening is unavailable
// (Android) — animated webp included, the <img> element animates it.
export function isMediaFilePath(path) {
  return /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(path || "");
}

// Desktop: open a URL in the SYSTEM browser. wry swallows window.open /
// target=_blank new-window requests, so this rides the opener plugin — the
// same verified path as the update banner (plugin:opener|open_url,
// opener:default capability). Bare window.open is the non-Tauri fallback.
// Injected into every HTML-view overlay (mail body, HTML attachments): a
// capture-phase interceptor that stops links from navigating the sandboxed
// frame and posts them to the parent, which opens them outside (Android
// in-app browser chain / desktop system browser). The CSP blocks inline
// scripts, so these EXACT bytes are hash-whitelisted as script-src in
// index.html AND both tauri confs — change here and there in one commit.
const HTML_VIEW_LINK_JS = `document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;e.preventDefault();parent.postMessage({veltaHtmlLink:a.href},"*")},true)`;

function openExternal(url) {
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) return void invoke("plugin:opener|open_url", { url }).catch(() => window.open(url, "_blank", "noopener"));
  } catch {}
  window.open(url, "_blank", "noopener");
}


// Forwarded messages announce what they carry, not who sent them:
// "Forwarded a picture" / "an audio" / "a video", everything else "a message".
const FWD_NOUNS = { image: "picture", gif: "picture", video: "video", audio: "audio", voice: "audio" };
const FWD_NOUN = (viewtype) => FWD_NOUNS[viewtype] || "message";
const FWD_ARTICLE = (viewtype) => (/^[aeiou]/.test(FWD_NOUN(viewtype)) ? "an " : "a ");

const ICO = {
  reply: `<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h9a7 7 0 017 7v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 012-2h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  forward: `<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5M20 9h-9a7 7 0 00-7 7v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2 1.3-6.2L3 9.5l6.3-.7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  select: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 12.5l2.5 2.5 5-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v6M12 7v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  download: `<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  photo: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4 17l5-5 3.5 3.5L16 12l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  file: `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  webxdc: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M17.5 13.5v6m-3-3h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  mic: `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 11a7 7 0 0014 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  lock: `<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  edit: `<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  resend: `<svg viewBox="0 0 24 24"><polyline points="2.5 5.5 2.5 11 8 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.2 14.5a8 8 0 1 0 1.5-8L2.5 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  pin: `<svg viewBox="0 0 24 24"><path d="M9 4h6l1 7 3 3v2h-6v5l-1 1-1-1v-5H5v-2l3-3z" fill="currentColor"/></svg>`,
};

// Short human reason from the core's raw error text, e.g.
// "Permanent SMTP error: permanent: 5.3.4 Error: message file too big"
// → "Message file too big". Falls back to the raw text (first line).
function failReason(error) {
  if (!error) return "Not sent";
  let t = String(error).split("\n")[0];
  // LAST "Error: " segment wins — take everything after the final occurrence
  // (a greedy match to $ grabs the whole line instead).
  const i = t.lastIndexOf("Error: ");
  if (i >= 0) t = t.slice(i + 7);
  t = t.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}


// On Android the file picker can return a content URI / temporary path that the
// Delta Chat core cannot read directly. Copy the file into our app-local data
// directory and return an absolute filesystem path the core can copy into blobs.
// Desktop: absolute paths used to pass through unchanged — but shell-side
// media commands (posters, read_media_bytes) scope every path to the accounts
// dir (scoped_accounts_path in lib.rs), so an out-of-tree picked file breaks
// the poster pipeline and send's own reads. Copy those too.
async function resolveAttachmentPath(originalPath, filename) {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (!invoke) return originalPath;

  const normalized = originalPath.replace(/\\/g, "/");
  const inAccounts = window.veltaAccountsDir
    && normalized.toLowerCase().startsWith(window.veltaAccountsDir.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() + "/");
  if (inAccounts) return originalPath; // already app-managed (content-uri copies)

  try {
    const destName = `${Date.now()}-${filename || "file"}`;
    // resolve_upload_path already puts everything under uploads/
    const absDest = await invoke("resolve_upload_path", { filename: destName });
    rustLog(`resolveAttachmentPath original=${originalPath} dest=${absDest}`);
    if (!absDest) throw new Error("resolve_upload_path returned empty");

    // Read original bytes and write to app-local destination. write_file
    // takes the path header and a raw byte body (see _sendImageBlob).
    const bytes = new Uint8Array(await invoke("plugin:fs|read_file", { path: originalPath }));
    await invoke("plugin:fs|write_file", bytes, {
      headers: { path: encodeURIComponent(absDest) },
    });
    return absDest;
  } catch (e) {
    rustLog(`resolveAttachmentPath failed: ${e}; falling back to original`);
    return originalPath;
  }
}

// Free-form image cropper over a preview canvas: drag inside the selection to
// move it, drag the corner handle to resize, drag outside to start a new one.
// Resolves with the cropped image as a PNG blob, or null on cancel.
function openImageCropper(imageUrl) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      resolve(v);
    };
    const body = document.createElement("div");
    body.innerHTML = `
      <div data-stage style="display:flex;justify-content:center;background:#0b0b10;border-radius:8px;overflow:hidden">
        <div data-wrap style="position:relative">
          <canvas data-canvas style="display:block;max-width:100%;touch-action:none"></canvas>
          <div data-sel style="position:absolute;border:2px solid #f2f2f5;box-shadow:0 0 0 9999px rgba(11,11,16,.55);pointer-events:none"></div>
          <div data-handle style="position:absolute;width:20px;height:20px;margin:-10px 0 0 -10px;border:2px solid #f2f2f5;border-radius:5px;background:rgba(11,11,16,.6);cursor:nwse-resize;touch-action:none"></div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:center">
        <button class="btn-text" data-apply style="background:var(--accent);color:#f4f4f4">Apply</button>
        <button class="btn-text" data-cancelcrop>Cancel</button>
      </div>`;
    const { close } = showModal({ title: "Crop image", body, onClose: () => finish(null) });
    const canvas = body.querySelector("[data-canvas]");
    const sel = body.querySelector("[data-sel]");
    const handle = body.querySelector("[data-handle]");
    const img = new Image();
    let box = null;   // selection in canvas coordinates { x, y, w, h }
    const drawSel = () => {
      const r = canvas.getBoundingClientRect();
      const k = r.width / canvas.width;
      sel.style.left = (box.x * k) + "px";
      sel.style.top = (box.y * k) + "px";
      sel.style.width = (box.w * k) + "px";
      sel.style.height = (box.h * k) + "px";
      handle.style.left = ((box.x + box.w) * k) + "px";
      handle.style.top = ((box.y + box.h) * k) + "px";
    };
    const canvasPoint = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      };
    };
    let drag = null; // { mode: "move"|"resize"|"new", sx, sy, orig }
    canvas.addEventListener("pointerdown", e => {
      const p = canvasPoint(e);
      const inside = p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
      drag = inside
        ? { mode: "move", sx: p.x, sy: p.y, orig: { ...box } }
        : { mode: "new", sx: p.x, sy: p.y, orig: { ...box } };
      if (!inside) box = { x: p.x, y: p.y, w: 0, h: 0 };
      // Capture the pointer: without it Android's WebView can claim the
      // gesture (scroll/pan), retarget later moves elsewhere or fire
      // pointercancel mid-drag, killing the selection drag. Captured moves
      // still bubble to the window listeners below.
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    handle.addEventListener("pointerdown", e => {
      const p = canvasPoint(e);
      drag = { mode: "resize", sx: p.x, sy: p.y, orig: { ...box } };
      // touch-action:none (inline above) + capture: the handle sits on a
      // scrollable modal, and Android cancelled every resize drag otherwise.
      try { handle.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      e.stopPropagation();
    });
    // Drag tracking on window: a release outside the canvas (or over the
    // handle, which captures its own events) must still end the drag.
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    function onMove(e) {
      if (!drag) return;
      const p = canvasPoint(e);
      if (drag.mode === "move") {
        box.x = Math.min(Math.max(0, drag.orig.x + (p.x - drag.sx)), canvas.width - drag.orig.w);
        box.y = Math.min(Math.max(0, drag.orig.y + (p.y - drag.sy)), canvas.height - drag.orig.h);
      } else if (drag.mode === "resize") {
        // bottom-right handle — the top-left corner stays anchored
        const x2 = Math.min(Math.max(0, p.x), canvas.width);
        const y2 = Math.min(Math.max(0, p.y), canvas.height);
        box = { x: drag.orig.x, y: drag.orig.y, w: Math.max(0, x2 - drag.orig.x), h: Math.max(0, y2 - drag.orig.y) };
      } else {
        // "new": selection spans from the drag start point to the pointer
        const x2 = Math.min(Math.max(0, p.x), canvas.width);
        const y2 = Math.min(Math.max(0, p.y), canvas.height);
        box = { x: Math.min(drag.sx, x2), y: Math.min(drag.sy, y2), w: Math.abs(x2 - drag.sx), h: Math.abs(y2 - drag.sy) };
      }
      drawSel();
    }
    function endDrag() {
      if (!drag) return;
      if (box.w < 12 || box.h < 12) box = drag.orig; // discard accidental taps
      drag = null;
      drawSel();
    }

    img.onload = () => {
      const scale = Math.min(1, 420 / img.naturalWidth, 320 / img.naturalHeight);
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      box = { x: 0, y: 0, w: canvas.width, h: canvas.height };
      // drawSel needs the laid-out canvas rect — wait one frame so the
      // wrapper has its final size before positioning the overlay.
      requestAnimationFrame(drawSel);
    };
    img.src = imageUrl;

    body.querySelector("[data-apply]").addEventListener("click", () => {
      const k = img.naturalWidth / canvas.width;
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(box.w * k));
      out.height = Math.max(1, Math.round(box.h * k));
      out.getContext("2d").drawImage(img, box.x * k, box.y * k, box.w * k, box.h * k, 0, 0, out.width, out.height);
      out.toBlob(b => { finish(b); close(); }, "image/png");
    });
    body.querySelector("[data-cancelcrop]").addEventListener("click", () => { finish(null); close(); });
  });
}

function extOf(path) {  if (!path) return "";
  const base = path.replace(/\\/g, "/").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

// "Remember scroll position in chats" (issue #18): drawer setting, default
// ON since #70 — unset or "1" = on, "0" = off (ui.js owns the toggle, like
// Send on Enter).
export const REMEMBER_SCROLL_KEY = "velta-remember-scroll";
export function rememberScrollOn() {
  try { return localStorage.getItem(REMEMBER_SCROLL_KEY) !== "0"; } catch { return true; }
}

// CSS zoom on <html> (interface scale) scales getBoundingClientRect but not
// scrollTop — rect distances are divided by it before they touch scrollTop.
function cssZoom() {
  try {
    const z = parseFloat(getComputedStyle(document.documentElement).zoom);
    return z > 0 ? z : 1;
  } catch { return 1; }
}

export class ChatView {
  constructor(core, { onChatsChanged, onForward, onOpenChat, onBack }) {
    this.core = core;
    this.onChatsChanged = onChatsChanged;
    this.onForward = onForward;
    this.onOpenChat = onOpenChat;
    this.onBack = onBack;
    // Rig/debug handle (like window.__veltaDiagnostics): lets cdp-eval probe
    // scroll-restore state without a module-global export.
    try { window.__veltaChatView = this; } catch {}
    this.chat = null;
    this._readOnly = false; // read-only chat: reply affordances hide (see readOnly)
    this.items = [];        // flattened items for the virtual scroller
    this.msgIndex = new Map();
    this._rowCache = new Map();  // item.key → rendered element (reused across setItems)
    this._rowSigCache = new Map();  // item.key → render signature of the cached row
    this.hasMore = false;
    this.loadingMore = false;
    // Read tracking (see _checkSeen): the loaded window may stop short of
    // the newest message when a chat opens at its first unread message or
    // read marker — hasNewer then pages downwards instead of appending.
    this.hasNewer = false;
    this.loadingNewer = false;
    this._tracked = false;       // open chat uses per-message read tracking (not local chats)
    this.readMarkerId = null;    // manual "read up to here" marker (read-markers.js)
    this._firstUnreadId = null;  // "Unread messages" line, fixed per open
    this._unreadIds = new Set(); // loaded incoming messages not seen yet
    this._seenPending = [];
    this._seenTimer = null;
    this._seenFrame = 0;
    this._settling = false;
    this.seenFlushMs = 400;      // markseen batching window (tests shrink it)
    this.selection = new Set();
    this.replyTo = null;
    this.replyFragment = null;
    this.editingMsg = null;
    this.pendingMedia = null; // attachment awaiting send: {kind, blob?, url, corePath, name}
    this._session = null;
    this._drafts = new Map();
    // onMsgsChanged refetch coalescing window (tests shrink it).
    this.tailRefetchGapMs = 2000;
    this._tailRefetchAt = 0;
    this._tailRefetchTimer = null;
    this._pendingTailRefetch = null;
    this._pendingMarkReadChatId = null;
    // Mark-read coalescing window (tests shrink it): a burst of incoming
    // messages while the chat is open collapses to one markseen RPC.
    this.markReadDebounceMs = 400;
    this._markReadTimer = null;
    // Fetch-then-jump: search hits / quotes / pinned-bar jumps fetch older
    // history until the target loads, then seek to it (tests shrink these).
    this.jumpMaxPages = 50;
    this.jumpSeekAttempts = 8;
    this.jumpSeekDelayMs = 60;
    this._jumpInFlight = false;
    // Remembered scroll positions (issue #18, setting "Remember scroll
    // position in chats", default off): {anchorId, dy} per (account, chat),
    // keyed like drafts. In-memory like drafts — gone at app restart.
    this._scrollAnchors = new Map();
    this._userAway = false;      // user genuinely scrolled off the bottom (see _bindScroll)
    this._userScrollAt = 0;      // last user scroll input (wheel/touch/keys/scrollbar)
    this._restoring = false;     // the latest settle is a saved-anchor restore
    this._openedWithUnread = false;

    this.scrollEl = document.getElementById("history-scroll");
    this.listEl = document.getElementById("history");
    this.goDownBtn = document.getElementById("btn-go-down");
    this.goDownBadge = document.getElementById("go-down-badge");
    this._newWhileAway = 0;

    this._bindComposer();
    this._bindSelectionQuote();
    this._bindScroll();
    this._bindHistorySwipe();
    this._bindSelectionBar();
    this._bindCoreEvents();
  }

  /* ================= public ================= */

  // Read-only chat (device chats, channels the member cannot post in):
  // there is no composer to reply into, so every reply affordance hides —
  // hover pill and selection-quote chip via the body class, context menu /
  // selection bar here, and _setReply as the backstop. app.js derives this
  // from the chat kind and the core's can_send rights check.
  get readOnly() { return this._readOnly; }
  set readOnly(v) {
    this._readOnly = !!v;
    document.body.classList.toggle("chat-read-only", this._readOnly);
  }

  _isCurrent(session = this._session) {
    return !!session && session === this._session && session.accountEpoch === this.core.accountEpoch;
  }

  // chat: the caller's freshly fetched chat object (app.js openChat), which
  // saves a second getChat per open (#25); fetched here when omitted.
  async open(chatId, chat = null) {
    // Retire the old scroller, composer and pending work before yielding.
    this.close();
    // The row cache survives switches (keys are per-chat message ids), but
    // ids are per-account — drop it when the account changed since the last
    // chat was open.
    if (this._rowCacheAccount !== this.core.accountId) {
      this._rowCache.clear();
      this._rowSigCache.clear();
      this._rowCacheAccount = this.core.accountId;
    }
    const session = this._session = {
      accountEpoch: this.core.accountEpoch,
      accountId: this.core.accountId,
      draftKey: JSON.stringify([String(this.core.accountId), String(chatId)]),
      chatId,
      reload: 0,
    };
    this._loadBar(true);
    try {
      if (chat?.id !== chatId) chat = await this.core.getChat(chatId);
      if (!this._isCurrent(session)) return false;
      // Opening position: while the chat has unread messages it opens at
      // the manual read marker, else at the first unread message; a fully
      // read chat opens at the bottom. Local chats keep open = read.
      const tracked = !chat.isP2p && !!this.core.getFirstUnreadMessageId && !!this.core.markSeen;
      let marker = tracked ? getReadMarker(session.accountId, chatId) : null;
      let firstUnread = null;
      if (tracked && chat.unread > 0) {
        firstUnread = await this.core.getFirstUnreadMessageId(chatId).catch(() => null);
        if (!this._isCurrent(session)) return false;
      }
      let anchorId = firstUnread != null ? (marker ?? firstUnread) : null;
      // Remembered position (setting, issue #18): only for a fully read
      // chat — marker > first unread > saved anchor > bottom. New unread
      // messages retire the saved anchor.
      let restore = null;
      if (tracked && rememberScrollOn()) {
        if (chat.unread > 0) this._scrollAnchors.delete(session.draftKey);
        else if (anchorId == null) restore = this._scrollAnchors.get(session.draftKey) || null;
      }
      const load = (aroundId) => this.core.getMessages(chatId, aroundId != null ? { aroundId, before: 10, limit: 60 } : { limit: 40 });
      let page = await load(anchorId ?? restore?.anchorId);
      if (!this._isCurrent(session)) return false;
      if (restore && !page.messages.some(m => m.id === restore.anchorId)) {
        // The anchor message is gone (deleted) — forget it, open at the bottom.
        this._scrollAnchors.delete(session.draftKey);
        restore = null;
        page = await load(null);
        if (!this._isCurrent(session)) return false;
      }
      if (anchorId != null && anchorId === marker && !page.messages.some(m => m.id === marker)) {
        // The marked message is gone (deleted) — drop the stale marker.
        clearReadMarker(session.accountId, chatId);
        marker = null;
        anchorId = firstUnread;
        page = await load(anchorId);
        if (!this._isCurrent(session)) return false;
      }
      const { messages, hasMore, hasNewer = false } = page;
      if (anchorId != null && !messages.some(m => m.id === anchorId)) anchorId = null;
      this.chat = chat;
      this._tracked = tracked;
      this.hasMore = hasMore;
      this.hasNewer = !!hasNewer;
      this.readMarkerId = marker;
      this._userAway = !!restore; // a restored position is the user's own
      this._openedWithUnread = (chat.unread || 0) > 0;
      this._firstUnreadId = firstUnread ?? (tracked ? messages.find(m => m.unread)?.id ?? null : null);
      const draft = this._drafts.get(session.draftKey);
      const input = document.getElementById("composer-input");
      input.value = draft?.text || "";
      input.disabled = false;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + "px";
      this.replyTo = draft?.replyTo || null;
      this.replyFragment = draft?.replyFragment || null;
      this._renderReplyPreview();
      this._rebuildItems(messages);
      this._createScroller();
      this._refreshPinnedBar();
      if (!tracked) {
        await this.core.markRead(chatId);
        if (!this._isCurrent(session)) return false;
      }
      if (anchorId != null) {
        this._scrollToMessageSettling(anchorId, { marker: anchorId === marker });
        this._newWhileAway = chat.unread || 0;
        this._renderGoDown(true);
      } else if (restore) {
        this._restoreScrollSettling(restore);
        this._renderGoDown(true);
      } else {
        this._scrollBottomSettling();
      }
      this.startLive();
      return true;
    } catch (err) {
      if (!this._isCurrent(session)) return false;
      this.close();
      throw err;
    } finally {
      this._loadBar(false);
    }
  }

  // History loading strip under the chat header (see .chat-load-bar).
  // Stays on >= 150 ms so fast loads (mock core, warm pages) still flash
  // visibly through the .25 s fade — only the indicator is held, never the
  // data. A new on cancels a pending off (no flicker between back-to-back
  // pages; a mid-flight chat switch re-runs open()'s own on).
  _loadBar(on) {
    const bar = document.getElementById("chat-load-bar");
    if (!bar) return;
    clearTimeout(this._loadBarOff);
    if (on) {
      this._loadBarOnAt = performance.now();
      bar.setAttribute("data-on", "");
      return;
    }
    const shownFor = performance.now() - (this._loadBarOnAt || 0);
    if (shownFor < 150) {
      this._loadBarOff = setTimeout(() => bar.removeAttribute("data-on"), 150 - shownFor);
    } else {
      bar.removeAttribute("data-on");
    }
  }

  // Pinned-message tray between the chat head and the history (core 2.59+
  // pinned-messages API). A <details> element: the collapsed summary shows
  // the newest pin; expanding reveals ALL pinned messages, each with an
  // unpin button (issue: multi-pin access + unpin without hunting the
  // message down in history).
  _ensurePinnedBar() {
    if (this.pinnedBar?.isConnected) return this.pinnedBar;
    const bar = this.pinnedBar = document.createElement("details");
    bar.id = "pinned-bar";
    bar.className = "pin-tray";
    bar.hidden = true;
    document.querySelector("#chat-view header.chat-head")?.after(bar);
    return bar;
  }

  async _refreshPinnedBar() {
    const session = this._session;
    const bar = this._ensurePinnedBar();
    if (!session || !this.core.getPinnedMessages) { bar.hidden = true; return; }
    let ids = [];
    try { ids = await this.core.getPinnedMessages(session.chatId); } catch { ids = []; }
    if (!this._isCurrent(session)) return;
    if (!ids.length) { bar.hidden = true; return; }
    const msgs = [];
    for (const id of ids) {
      const m = await this.core.getMessage(id).catch(() => null);
      if (!this._isCurrent(session)) return;
      if (m) msgs.push(m);
    }
    if (!msgs.length) { bar.hidden = true; return; }
    // Newest pin drives the collapsed summary; the tray lists all of them,
    // newest first. `open` (expanded state) survives refreshes.
    const wasOpen = bar.open;
    const snippet = (m) => (m.text || "").slice(0, 60) || (m.viewtype && m.viewtype !== "text" ? m.viewtype : "message");
    const newest = msgs[msgs.length - 1];
    const item = (m) => `
      <div class="pin-tray-item" data-pin-id="${m.id}">
        <span class="pb-text"><b>${escapeHtml(m.fromContact?.name || "")}</b> ${escapeHtml(snippet(m))}</span>
        <button class="pin-unpin" data-unpin="${m.id}" title="Unpin" aria-label="Unpin">✕</button>
      </div>`;
    bar.innerHTML = `
      <summary class="pin-tray-summary">
        ${ICO.pin}<span class="pb-text"><b>${escapeHtml(newest?.fromContact?.name || "")}</b> ${escapeHtml(snippet(newest))}</span>
        ${msgs.length > 1 ? `<span class="pin-tray-count">${msgs.length}</span>` : ""}
        <span class="pin-tray-chevron"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </summary>
      <div class="pin-tray-list">${msgs.slice().reverse().map(item).join("")}</div>`;
    bar.hidden = false;
    bar.open = wasOpen;
    bar.querySelectorAll(".pin-tray-item").forEach(itemEl => {
      itemEl.addEventListener("click", e => {
        if (e.target.closest("[data-unpin]")) return;
        bar.open = false;
        if (this._isCurrent(session)) this._jumpToMessage(Number(itemEl.dataset.pinId));
      });
    });
    bar.querySelectorAll("[data-unpin]").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        try { await this.core.pinMessage(Number(btn.dataset.unpin), false); } catch (err) {
          errToast("Couldn't unpin: " + (err?.message || err));
        }
        this._refreshPinnedBar();
      });
    });
  }

  // Full teardown: stop polling, dispose the virtual scroller, drop cached
  // rows and leave #history empty. Used when another surface takes over the
  // history area (Diagnostics chat) and when the chat is closed.
  close() {
    const input = document.getElementById("composer-input");
    // Rows the user already saw still count — unless the account changed
    // underneath (the ids would land in the wrong account).
    if (this._isCurrent()) this._flushSeen();
    clearTimeout(this._seenTimer);
    this._seenTimer = null;
    this._seenPending = [];
    cancelAnimationFrame(this._seenFrame);
    this._seenFrame = 0;
    // Use the session's owner, not core.accountId: account-changing may have
    // already advanced the core epoch before the app calls close().
    if (this.chat && this._session) {
      if (input.value || this.replyTo) this._drafts.set(this._session.draftKey, { text: input.value, replyTo: this.replyTo, replyFragment: this.replyFragment });
      else this._drafts.delete(this._session.draftKey);
      this._saveScrollAnchor(this._session.draftKey); // measures the live DOM — before teardown
    }
    this._flushMarkRead(); // messages were on screen — mark them before the session dies
    this._session = null;
    input.value = "";
    input.style.height = "auto";
    input.disabled = true;
    this.stopLive();
    if (this._tailRefetchTimer) { clearTimeout(this._tailRefetchTimer); this._tailRefetchTimer = null; }
    this._pendingTailRefetch = null;
    this._stopSettling?.();
    if (this.pinnedBar) this.pinnedBar.hidden = true;
    this.chat = null;
    this.hasMore = false;
    this.loadingMore = false;
    this.hasNewer = false;
    this.loadingNewer = false;
    this.readMarkerId = null;
    this._firstUnreadId = null;
    this._unreadIds.clear();
    this._settling = false;
    this._tracked = false;
    this._userAway = false;
    this._restoring = false;
    this._openedWithUnread = false;
    this._hideGoDown();
    this._leaveTextSelection();
    this._cancelHistorySwipe?.();
    this.vs?.stop();
    this.vs = null;
    this.items = [];
    this.msgIndex.clear();
    // The rendered-row LRU survives close() — reopening a chat reuses the
    // rows instead of rebuilding them; open() clears it on account change
    // (message ids are per-account).
    this.replyTo = null;
    this.replyFragment = null;
    this.editingMsg = null;
    this._clearPendingMedia(); // media not in drafts — re-attach if needed
    this._renderReplyPreview();
    this.exitSelection();
    this.listEl.replaceChildren();
    this.listEl.style.paddingTop = "";
    this.listEl.style.paddingBottom = "";
    this.scrollEl.scrollTop = 0;
  }

  async appendOutgoing(msg) {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat || !msg || msg.chatId !== this.chat.id) return;
    // The loaded window stops short of the tail: the own message belongs
    // after messages that are not loaded yet — jump to the real tail.
    if (this.hasNewer) { this._jumpToLatest(); return; }
    this._insertItems(this._annotateMessages([msg], this.items[this.items.length - 1]?.dayKey ?? null));
    this.vs?.setItems(this.items);
    // Always follow an own message down — the chat may have opened
    // mid-history at the first unread message.
    requestAnimationFrame(() => { if (this._isCurrent(session)) { this._scrollBottom(); this._scheduleSeenCheck(); } });
  }

  // Coalesced mark-read for message-arrival paths: the first message in a
  // burst schedules one markseen; later arrivals within the window are free.
  // All callers are same-chat (onIncoming/onMsgsChanged guard chatId), so the
  // captured chatId is the chat the user was actually reading.
  markReadSoon(chatId) {
    if (this._markReadTimer) return;
    const session = this._session;
    const pendingChatId = chatId;
    this._pendingMarkReadChatId = chatId;
    this._markReadTimer = setTimeout(() => {
      this._markReadTimer = null;
      if (pendingChatId == null || !this._isCurrent(session) || this.chat?.id !== pendingChatId) return;
      this.core.markRead(pendingChatId);
    }, this.markReadDebounceMs);
  }

  _flushMarkRead() {
    if (!this._markReadTimer) return;
    clearTimeout(this._markReadTimer);
    this._markReadTimer = null;
    const chatId = this._pendingMarkReadChatId;
    this._pendingMarkReadChatId = null;
    // Timer never fired: the messages were on screen but unmarked — close()
    // also runs before every chat switch, so flush only when still current
    // (an account switch leaves the read state to the next open).
    if (chatId != null && this._isCurrent()) this.core.markRead(chatId);
  }

  async onIncoming(chatId, msg) {
    const session = this._session;
    if (!this._isCurrent(session)) return;
    rustLog(`chat-view onIncoming chatId=${chatId} current=${this.chat?.id}`);
    if (!this.chat || chatId !== this.chat.id) { this._bumpGoDown(chatId, true); return; }
    // The same message id can arrive twice (e.g. appended as a download
    // placeholder first, then re-notified once the full content merged).
    // Update the existing row in place instead of appending a duplicate.
    if (this.msgIndex.has(msg.id)) { this.onMsgUpdated(chatId, msg); return; }
    if (this.hasNewer) { this._bumpGoDown(chatId); return; } // lands past the loaded window
    this._insertItems(this._annotateMessages([msg], this.items[this.items.length - 1]?.dayKey ?? null));
    this.vs?.setItems(this.items);
    if (this._nearBottom()) {
      if (this._tracked) {
        // Seen once it is actually on screen (_checkSeen), not on arrival —
        // a backgrounded app must not send read receipts.
        requestAnimationFrame(() => { if (this._isCurrent(session)) { this._scrollBottom(); this._scheduleSeenCheck(); } });
      } else {
        requestAnimationFrame(() => { if (this._isCurrent(session)) this._scrollBottom(); });
        this.markReadSoon(chatId);
      }
    } else {
      this._bumpGoDown(chatId);
    }
  }

  // Fallback refresh: the core signals "messages changed" (IncomingMsgBunch
  // carries no ids, and the decorated fast-path may fail). Reload the tail
  // and append only what's actually new, preserving scroll/history paging.
  // Bursts are collapsed: at most one refetch per gap (each is 2+ RPCs, and
  // during an event storm this was the dominant work item), with a single
  // trailing refetch that remembers whether any suppressed call asked for a
  // fresh id rebuild.
  async onMsgsChanged(chatId, { fresh = false } = {}) {
    debugLog(`chat-view onMsgsChanged chatId=${chatId} current=${this.chat?.id} fresh=${fresh}`);
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat || (chatId && chatId !== this.chat.id)) return;
    // A window that stops short of the tail has nothing to diff the tail
    // against; paging down (_loadNewer) or the go-down jump fetches it.
    if (this.hasNewer) return;
    const sinceLast = Date.now() - this._tailRefetchAt;
    if (sinceLast < this.tailRefetchGapMs) {
      const pending = this._pendingTailRefetch || (this._pendingTailRefetch = { fresh: false });
      if (fresh) pending.fresh = true;
      if (!this._tailRefetchTimer) {
        this._tailRefetchTimer = setTimeout(() => {
          this._tailRefetchTimer = null;
          const args = this._pendingTailRefetch;
          this._pendingTailRefetch = null;
          if (args) this.onMsgsChanged(0, args);
        }, this.tailRefetchGapMs - sinceLast);
      }
      return;
    }
    this._tailRefetchAt = Date.now();
    const reload = ++session.reload;
    let maxId = 0;
    for (const it of this.items) if (it.type === "msg" && it.msg.id > maxId) maxId = it.msg.id;
    let messages;
    try {
      ({ messages } = await this.core.getMessages(session.chatId, { limit: 40, fresh }));
    } catch { return; }
    if (!this._isCurrent(session) || session.reload !== reload) return;
    const newMsgs = messages.filter(m => m.id > maxId && !this.msgIndex.has(m.id));
    // Remote deletions (e.g. another member asked for a message to be
    // removed) arrive as MsgsChanged without message ids. Anything inside
    // the refetched tail window that vanished from the id list is gone from
    // the chat — drop those rows so the open view reflects it.
    let deleted = [];
    if (messages.length) {
      const tailMin = messages[0].id;
      const tailIds = new Set(messages.map(m => m.id));
      for (const it of this.items) {
        if (it.type === "msg" && it.msg.id >= tailMin && !tailIds.has(it.msg.id)) deleted.push(it.msg.id);
      }
      if (deleted.length) this.onMsgsDeleted(this.chat.id, deleted);
    }
    // A media message that finished downloading keeps its id, so the "new"
    // filter above skips it. Re-render rows in place when the download state
    // or view type changed (e.g. a video Pre-Message placeholder becoming a
    // playable player once its Post-Message arrives) — or when the delivery
    // state changed, so a MsgDelivered/MsgRead event that the transport
    // dropped self-heals here instead of leaving a stuck sending spinner.
    let updated = 0;
    for (const m of messages) {
      const item = this.msgIndex.get(m.id);
      if (item?.msg && item.msg !== m
        && (item.msg.downloadState !== m.downloadState || item.msg.viewtype !== m.viewtype
          || item.msg.state !== m.state || item.msg.text !== m.text)) {
        this.onMsgUpdated(this.chat.id, m);
        updated++;
      }
    }
    // Loud when something actually changed (a non-zero here means rows were
    // appended/rebuilt — the signal for rerender-loop debugging); silent churn
    // stays behind the debug flag.
    if (newMsgs.length || updated) rustLog(`chat-view onMsgsChanged found ${newMsgs.length} new, ${updated} updated messages`);
    else debugLog(`chat-view onMsgsChanged found 0 new, 0 updated messages`);
    if (!newMsgs.length) return;
    this._insertItems(this._annotateMessages(newMsgs, this.items[this.items.length - 1]?.dayKey ?? null));
    this.vs?.setItems(this.items);
    if (this._nearBottom()) {
      if (this._tracked) {
        requestAnimationFrame(() => { if (this._isCurrent(session)) { this._scrollBottom(); this._scheduleSeenCheck(); } });
      } else {
        requestAnimationFrame(() => { if (this._isCurrent(session)) this._scrollBottom(); });
        this.markReadSoon(this.chat.id);
      }
    } else {
      this._bumpGoDown(this.chat.id);
    }
  }

  // Live tail polling while a chat is open — a safety net for new messages
  // when core events are delayed or dropped by the transport. Realtime
  // delivery is event-driven; this only bounds the worst-case delay, so it
  // can run slowly. Each tick refetches the tail (2 RPCs + a full remap of 40
  // messages) — at the old 2s cadence that alone was a multi-GB/day
  // allocation churn in the WebView.
  startLive() {
    this.stopLive();
    const session = this._session;
    debugLog(`chat-view startLive chat=${this.chat?.id}`);
    this._liveTicks = 0;
    this._liveTimer = setInterval(() => {
      if (this._isCurrent(session) && this.chat && !document.hidden) {
        // Regular ticks reuse the incrementally maintained id cache — the
        // tail refetch stays O(40) instead of refetching every message id
        // in the chat every 20s. Every 5th tick (~100s) rebuilds the ids
        // to self-heal events dropped by the transport.
        const fresh = this._liveTicks % 5 === 4;
        this._liveTicks++;
        this.onMsgsChanged(0, { fresh });
      }
    }, 20000);
  }

  stopLive() {
    if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; }
  }

  onMsgState(chatId, msgId, state) {
    if (!this._isCurrent() || !this.chat || chatId !== this.chat.id) return;
    const item = this.msgIndex.get(msgId);
    if (item) item.msg.state = state;
    const row = this.listEl.querySelector(`[data-msgid="${msgId}"]`);
    const ticks = row?.querySelector(".msg-meta .ticks-slot");
    if (ticks) ticks.innerHTML = ticksSvg(state, "ticks");
    this._syncFail(row, msgId, state);
  }

  // Failed outgoing rows carry a red reason badge in the meta row + a
  // retry/remove pair left of the bubble (see _renderMsgItem); live state
  // transitions get them from here.
  _syncFail(row, msgId, state) {
    if (!row) return;
    let badge = row.querySelector(".msg-fail-badge");
    let actions = row.querySelector(".msg-fail-actions");
    if (state !== "failed") { badge?.remove(); actions?.remove(); return; }
    const m = this.msgIndex.get(msgId)?.msg;
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "msg-fail-badge";
      badge.title = m?.error || "Not sent";
      badge.textContent = failReason(m?.error);
      row.querySelector(".msg-meta")?.after(badge);
    }
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "msg-fail-actions";
      actions.innerHTML =
        `<button type="button" data-act="resend" title="Retry" aria-label="Retry sending">${ICO.resend}</button>`
        + `<button type="button" data-act="fail-del" title="Remove" aria-label="Remove message">${ICO.trash}</button>`;
      row.querySelector(".bubble")?.before(actions);
    }
  }

  // Retry a failed outgoing message: the core flips it back to OutPending,
  // re-queues it, and the usual MsgDelivered/MsgFailed events take over.
  // Issue #13: writing from an archived chat unarchives it (official-client
  // behavior). All sends route through here so none of them misses it.
  async _sendArchivedAware(chatId, data) {
    const session = this._session;
    const msg = await this.core.sendMessage(chatId, data);
    // Chat ids are per profile: after an account switch the same numeric id
    // is another profile's chat — only unarchive in the session that sent.
    if (this._isCurrent(session) && this.chat && this.chat.id === chatId && this.chat.archived) {
      try {
        await this.core.setChatFlags(chatId, { archived: false });
        this.chat.archived = false;
        this.onChatsChanged?.();
      } catch { /* core refused — keep the flag as is */ }
    }
    return msg;
  }

  async _resendMessage(m) {
    try {
      await this.core.resendMessage(m.id);
      this.onMsgState(m.chatId, m.id, "pending");
    } catch (err) {
      errToast(`Resend failed: ${err?.message || err}`);
      diagnosticsSink.append("error", `resend ${m.id}: ${err?.message || err}`);
    }
  }

  // Remove a failed outgoing message. forAll: TRUE — the failure state on our
  // side doesn't guarantee non-delivery (an oversized-media send can still
  // reach the recipient, core retries / partial delivery), so a local-only
  // delete leaves the message alive on their client. It's our own message;
  // the deletion request propagates like any other "delete for everyone".
  async _deleteFailed(m) {
    if (!(await confirmModal("Remove message", "Delete this message for everyone?"))) return;
    try {
      await this.core.deleteMessages(m.chatId, [m.id], { forAll: true });
      this.onMsgsDeleted(m.chatId, [m.id]);
    } catch (err) {
      errToast(`Delete failed: ${err?.message || err}`);
      diagnosticsSink.append("error", `fail-del ${m.id}: ${err?.message || err}`);
    }
  }

  async _lcRetryTransfer(m) {
    try {
      await lcRetryTransfer(m.chatId, m.id);
      toast("Retrying…");
    } catch (err) {
      errToast(`Retry failed: ${err?.message || err}`);
    }
  }

  _rowSignature(m) {
    return JSON.stringify([
      m.viewtype, m.downloadState, m.text, m.state, m.edited, m.starred,
      m.reactions, m.filePath, m.fileName, m.duration, m.fwdFrom, m.quote, m.error,
      m.originalMsgId,
    ]);
  }

  // Reactions sit at index 6 of _rowSignature. A reaction must not rebuild
  // the row: that reloads images and restarts video (#33).
  _onlyReactionsChanged(prev, next) {
    let reactionsDiffer = false;
    const a = JSON.parse(this._rowSignature(prev));
    const b = JSON.parse(this._rowSignature(next));
    for (let i = 0; i < a.length; i++) {
      const same = JSON.stringify(a[i]) === JSON.stringify(b[i]);
      if (i === 6) reactionsDiffer = !same;
      else if (!same) return false;
    }
    return reactionsDiffer;
  }

  // Swap the chip row in place. Returns false when the row has no bubble,
  // so the caller falls back to a full rebuild.
  _patchReactions(row, reactions) {
    const bubble = row.querySelector?.(".bubble");
    if (!bubble) return false;
    let box = bubble.querySelector(".msg-reactions");
    if (!reactions?.length) {
      box?.remove();
      return true;
    }
    if (!box) {
      box = document.createElement("div");
      box.className = "msg-reactions";
      const track = bubble.querySelector(".msg-hover-reply-track");
      if (track) bubble.insertBefore(box, track);
      else bubble.appendChild(box);
    }
    box.innerHTML = reactionChipsHtml(reactions);
    return true;
  }

  // Report which render-relevant fields flip-flopped between polls — this is
  // how we catch data that alternates between fetches and loops re-renders.
  _logSignatureDiff(key, a, b) {
    try {
      const fa = JSON.parse(a), fb = JSON.parse(b);
      const names = ["viewtype","downloadState","text","state","edited","starred","reactions","filePath","fileName","duration","fwdFrom","quote","error","originalMsgId"];
      const diffs = [];
      for (let i = 0; i < names.length; i++) {
        if (JSON.stringify(fa[i]) !== JSON.stringify(fb[i])) {
          diffs.push(`${names[i]}: ${JSON.stringify(fa[i])} -> ${JSON.stringify(fb[i])}`);
        }
      }
      diagnosticsSink.append("warning", `row ${key} rebuilt: ${diffs.join("; ") || "no field diff"}`);
    } catch (e) {
      diagnosticsSink.append("warning", `row ${key} rebuilt (diff failed: ${e})`);
    }
  }

  onMsgUpdated(chatId, msg) {
    if (!this._isCurrent() || !this.chat || chatId !== this.chat.id) return;
    const item = this.msgIndex.get(msg.id);
    if (!item) return;
    const sig = this._rowSignature(msg);
    const prevSig = this._rowSigCache.get(item.key);
    if (item.msg && prevSig === sig) {
      item.msg = msg; // data-only change — keep the rendered row untouched
      return;
    }
    // Reaction-only: patch the chips. A full replace reloads images and
    // restarts video (#33). No bubble (or nothing rendered yet) falls through.
    if (item.msg && prevSig !== undefined && this._onlyReactionsChanged(item.msg, msg)) {
      const live = this.listEl.querySelector(`[data-msgid="${msg.id}"]`);
      const cached = this._rowCache.get(item.key);
      const targets = [...new Set([live, cached].filter(Boolean))];
      if (targets.length && targets.every(el => this._patchReactions(el, msg.reactions))) {
        item.msg = msg;
        if (live) this._rowCache.set(item.key, live);
        this._rowSigCache.set(item.key, sig);
        if (live) this.vs?.onItemHeightDidChange?.(item);
        return;
      }
    }
    if (item.msg && prevSig !== undefined) {
      this._logSignatureDiff(item.key, prevSig, sig);
    }
    item.msg = msg;
    const row = this.listEl.querySelector(`[data-msgid="${msg.id}"]`);
    if (row) {
      this.vs?.onItemHeightDidChange?.(item);
      const fresh = this._buildItem(item);
      row.replaceWith(fresh);
      this._rowCache.set(item.key, fresh);
      this._rowSigCache.set(item.key, sig);
    } else {
      // Not mounted: drop the stale cached row so the scroller rebuilds it
      // from the updated item on next mount, and record the new signature.
      // Deleting the signature instead made every duplicate event take this
      // full "changed" path again (and re-fire onItemHeightDidChange for an
      // unmounted item, which the scroller warns about) — one duplicate fed
      // the next forever during event storms.
      this._rowCache.delete(item.key);
      this._rowSigCache.set(item.key, sig);
    }
  }

  onMsgsDeleted(chatId, ids) {
    if (!this._isCurrent() || !this.chat || chatId !== this.chat.id) return;
    this.items = this.items.filter(it => !(it.type === "msg" && ids.includes(it.msg.id)));
    for (const id of ids) {
      this.msgIndex.delete(id);
      this._unreadIds.delete(id);
      this._rowCache.delete("m" + id);
      this._rowSigCache.delete("m" + id);
    }
    this.vs?.setItems(this.items);
  }

  /* ================= items & day chips ================= */

  _rebuildItems(messages) {
    this.items = [];
    this.msgIndex.clear();
    this._unreadIds.clear();
    this._insertItems(this._annotateMessages(messages));
  }

  // Day chips ride INSIDE the first message row of each day (dayFirst flag)
  // instead of being separate list items: the virtual scroller's diff needs
  // the entire previous items array to appear contiguously after a prepend,
  // and separator items broke that on every day-crossing batch (key
  // collisions with existing separators, seam removals) — the failed diff
  // forced a full relayout with estimated heights and no scroll restoration,
  // i.e. the scroll jumps when paging up through long histories.
  // The "Unread messages" line and the read marker ride inside their rows
  // the same way (unreadFirst / readMarker flags) — both can appear in any
  // page, including prepended ones, without breaking the prefix rule.
  _annotateMessages(messages, prevDayKey = null) {
    const out = [];
    let lastDay = prevDayKey;
    for (const m of messages) {
      const dayKey = new Date(m.ts).toDateString();
      const item = {
        type: "msg", key: "m" + m.id, msg: m, dayKey, dayFirst: dayKey !== lastDay,
        unreadFirst: m.id === this._firstUnreadId,
        readMarker: m.id === this.readMarkerId,
      };
      this.msgIndex.set(m.id, item);
      if (m.unread) this._unreadIds.add(m.id);
      out.push(item);
      lastDay = dayKey;
    }
    return out;
  }

  _insertItems(newItems) {
    if (newItems.length && newItems[0]._prepend) {
      this.items = [...newItems.map(i => (delete i._prepend, i)), ...this.items];
    } else {
      this.items = [...this.items, ...newItems];
    }
  }

  async _loadOlder() {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat || this.loadingMore || !this.hasMore || !this.items.length) return;
    this.loadingMore = true;
    const firstMsg = this.items.find(i => i.type === "msg");
    const beforeId = firstMsg?.msg.id ?? null;
    this._loadBar(true); // same history-loading strip as open(); paging up is history loading too
    try {
      const { messages, hasMore } = await this.core.getMessages(session.chatId, { beforeId, limit: 40 });
      if (!this._isCurrent(session)) return;
      this.hasMore = hasMore;
      if (messages.length) this._prependHistory(messages);
    } catch (err) {
      if (this._isCurrent(session)) errToast("Couldn't load older messages: " + (err.message || err));
    } finally {
      this._loadBar(false); // unconditional: an early session-invalid return must not leave the bar on
      if (this._isCurrent(session)) this.loadingMore = false;
    }
  }

  // Pure message prefix prepend — shared by scroll-up paging (_loadOlder)
  // and the fetch-then-jump walk. Prepends must never touch existing items
  // or the scroller's diff (which needs the whole previous array contiguous)
  // fails and forces a relayout-without-scroll-restore (= jump).
  _prependHistory(messages) {
    const oldFirst = this.items[0];
    const out = this._annotateMessages(messages, oldFirst?.dayKey ?? null);
    this.items = [...out, ...this.items];
    this.vs?.setItems(this.items, { preserveScrollPositionOnPrependItems: true });
    // The previous first row loses its day chip when the batch ends on the
    // same day — rebuild it so the day isn't labelled twice.
    if (out.length && oldFirst?.type === "msg" && oldFirst.dayFirst
      && out[out.length - 1].dayKey === oldFirst.dayKey) {
      oldFirst.dayFirst = false;
      const fresh = this._buildItem(oldFirst);
      this._rowCache.set(oldFirst.key, fresh);
      this._rowSigCache.set(oldFirst.key, this._rowSignature(oldFirst.msg));
      const mounted = this.listEl.querySelector(`[data-msgid="${oldFirst.msg.id}"]`);
      if (mounted) mounted.replaceWith(fresh);
      this.vs?.onItemHeightDidChange?.(oldFirst);
    }
    return out;
  }

  /* ================= virtual scroller ================= */

  _createScroller() {
    this.vs = new VirtualScroller(this.listEl, this.items, (item) => this._renderItem(item), {
      getScrollableContainer: () => this.scrollEl,
      getItemId: (item) => item.key,
      getEstimatedItemHeight: () => 48,
      // Default 1 prerenders one viewport of rows (~10 messages) past the
      // visible area; 3 gives ~30 for smoother fast-scroll reach-back.
      getPrerenderMarginRatio: () => 3,
    });
    // Media components (velta-video poster reservation) report row height
    // changes that happened after mount — keep the scroller's math fresh.
    // Delegated: Elena re-renders replace the inner elements.
    if (!this._rowResizedBound) {
      this._rowResizedBound = true;
      this.listEl.addEventListener("velta-row-resized", e => {
        const row = e.target?.closest?.(".msg-row");
        const item = row && this.msgIndex.get(Number(row.dataset.msgid));
        if (item) this.vs?.onItemHeightDidChange?.(item);
      });
    }
    // Debug: trace what drives the scroller (re-render loop investigation).
    window.__vs = this.vs;
    // The scroller's async update can race a setItems that removed an item
    // (e.g. the unread separator vanishing when messages are marked read):
    // its rendered-items snapshot then indexes one past the container's
    // childNodes ("Element with index N was not found… There're only N-1").
    // The next update re-syncs the rendered list, so swallow exactly that
    // known race instead of letting it escape as an uncaught rejection.
    const wrap = (name, orig) => function (...args) {
      if (debugLog.enabled) debugLog(`vs.${name} n=${args[0]?.length ?? ""} t=${Date.now() % 100000}`);
      const r = orig.apply(this, args);
      if (r && typeof r.catch === "function") {
        r.catch(err => {
          if (String(err?.message || "").includes("was not found in the list of Rendered Item Elements")) {
            debugLog(`vs.${name} desync race swallowed: ${err.message}`);
            return undefined;
          }
          throw err;
        });
      }
      return r;
    };
    for (const name of ["setItems", "onItemHeightDidChange", "update", "renderItem", "rerender", "stop", "start"]) {
      if (typeof this.vs[name] === "function") this.vs[name] = wrap(name, this.vs[name]);
    }
  }

  _renderItem(item) {
    // Reuse already-rendered rows across setItems calls — rebuilding a row
    // recreates its <video>/<audio> element, which resets playback (the
    // "flickering player"). Invalidate the cache entry when content changes.
    const cached = this._rowCache.get(item.key);
    // Rows are cached across opens; a row built with other in-row markers
    // (day chip, unread line, read marker) is stale for this item.
    if (cached && cached._veltaFlags === this._itemFlags(item)) {
      if (cached.querySelector?.("video")) {
        debugLog(`render: CACHED video row ${item.key} t=${Date.now() % 100000}`);
      }
      return cached;
    }
    const el = this._buildItem(item);
    this._rowCache.set(item.key, el);
    // Record the rendered content's signature so the first onMsgUpdated can
    // compare against it instead of treating "no known signature" as a
    // change (which silently rebuilt the row on every duplicate event).
    if (item.type === "msg") this._rowSigCache.set(item.key, this._rowSignature(item.msg));
    // Detached rows keep their event listeners alive while cached — cap the
    // cache so a long session can't retain the whole history as detached DOM.
    if (this._rowCache.size > 200) {
      const oldest = this._rowCache.keys().next().value;
      if (oldest !== item.key) {
        this._rowCache.delete(oldest);
        this._rowSigCache.delete(oldest);
      }
    }
    return el;
  }

  _itemFlags(item) {
    return `${item.dayFirst ? 1 : 0}${item.unreadFirst ? 1 : 0}${item.readMarker ? 1 : 0}`;
  }

  _buildItem(item) {
    const el = this._renderMsgItem(item);
    el._veltaFlags = this._itemFlags(item);
    return el;
  }

  _unreadSepEl() {
    const el = document.createElement("div");
    el.className = "unread-sep";
    el.textContent = "Unread messages";
    return el;
  }

  // The manual read marker: a line under the marked message; its button
  // removes the marker.
  _readMarkerEl() {
    const el = document.createElement("div");
    el.className = "read-marker";
    el.innerHTML = `<span>Read up to here</span><button type="button" class="read-marker-x" title="Remove read marker" aria-label="Remove read marker">${CLOSE_SVG}</button>`;
    el.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._isCurrent() && this.chat) this._clearReadMarker();
    });
    return el;
  }

  _dayChipEl(item) {
    const el = document.createElement("div");
    el.className = "day-chip";
    el.textContent = formatDay(item.msg.ts);
    return el;
  }

  _renderMsgItem(item) {
    const m = item.msg;
    const chatId = this.chat.id;
    // Handlers below live on cached rows that survive close()/open() — the
    // build-time session would be stale after any chat switch and silently
    // kill every click (lightbox, avatar profile, context menu, reply pill).
    // Validate at EVENT time instead: current session (account epoch per the
    // isolation contract) AND the row's chat still open. Rows are per-chat
    // (message ids are per-account; the cache is cleared on account change),
    // so this cannot leak actions across chats or accounts.
    const alive = () => this._isCurrent() && this.chat?.id === chatId;
    const liveItem = () => (alive() ? this.msgIndex.get(m.id) : null);
    if (m.kind === "service") {
      const row = diagnosticRow(m);
      if (!item.dayFirst && !item.unreadFirst && !item.readMarker) {
        row.dataset.msgid = m.id;
        return row;
      }
      const wrap = document.createElement("div");
      wrap.className = "msg-row day-first";
      wrap.dataset.msgid = m.id;
      if (item.dayFirst) wrap.append(this._dayChipEl(item));
      if (item.unreadFirst) wrap.append(this._unreadSepEl());
      wrap.append(row);
      if (item.readMarker) wrap.append(this._readMarkerEl());
      return wrap;
    }
    const out = m.from === 1;
    const showAvatar = !out && (this.chat.kind === "group");
    // Event-driven inserts (onIncoming) can carry rows before decoration —
    // never let a missing fromContact kill the whole render pass.
    const fc = m.fromContact || { id: m.from, name: "Unknown", color: "#888" };
    const row = document.createElement("div");
    row.className = "msg-row" + (out ? " out" : "") + (showAvatar ? " with-avatar" : "") + (m.originalMsgId ? " has-original" : "");
    row.dataset.msgid = m.id;
    if (this.selection.size) row.classList.add("selectable");
    if (this.selection.has(m.id)) row.classList.add("selected");

    let inner = "";
    // Day chip rides inside the first row of the day (see _annotateMessages).
    if (item.dayFirst) inner += `<div class="day-chip">${escapeHtml(formatDay(m.ts))}</div>`;
    if (item.unreadFirst) inner += `<div class="unread-sep">Unread messages</div>`;
    if (this.selection.size) {
      inner += `<div class="msg-checkbox">${this.selection.has(m.id) ? ICO.check : ""}</div>`;
    }
    if (showAvatar) {
      inner += `<velta-avatar name="${escapeHtml(fc.name)}" color="${fc.color}" size="42" contact-id="${fc.id ?? ""}" addr="${escapeAttr(fc.addr || "")}"${fc.avatar ? ` avatar="${escapeAttr(fileUrl(fc.avatar))}"` : ""}></velta-avatar>`;
    }

    let bubble = "";
    // Saved copy: round chevron back to the message in its own chat (#19).
    // Same control as the desktop shortcut menu, kept visible so a touch
    // can hit it. Hangs off the bubble into the gap .has-original reserves.
    if (m.originalMsgId) {
      bubble += `<button type="button" class="msg-show-in-chat" data-act="show-original" title="Show in chat" aria-label="Show in chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    }
    if (showAvatar) bubble += `<div class="msg-sender" style="color:${fc.color}">${escapeHtml(fc.name)}</div>`;
    if (m.fwdFrom) bubble += `<div class="msg-fwd">Forwarded ${FWD_ARTICLE(m.viewtype)}${FWD_NOUN(m.viewtype)}</div>`;
    if (m.quote) {
      bubble += `<div class="msg-quote" data-quote="${m.quote.id}">
        <span class="q-name">${escapeHtml(m.quote.fromContact?.name || "")}</span>
        <span class="q-text">${escapeHtml(m.quote.text || "")}</span></div>`;
    }
    if (m.transfer) {
      const pct = Math.max(0, Math.min(100, m.transfer.pct || 0));
      const head = `<div class="mfp-name">${escapeHtml(m.fileName || "File")}</div>`;
      if (m.transfer.failed) {
        bubble += `<div class="msg-transfer is-failed">${head}<div class="mfp-fail">Transfer interrupted</div><button type="button" class="btn-text" data-act="lc-retry">Retry</button></div>`;
      } else {
        bubble += `<div class="msg-transfer">${head}<div class="mfp-bar"><i style="width:${pct}%"></i></div><div class="mfp-pct">${pct}%</div></div>`;
      }
    } else if (m.viewtype === "image" || m.viewtype === "gif" || m.viewtype === "sticker") {
      // Demo stickers are emoji placeholders, not files — render the emoji.
      if (m.viewtype === "sticker" && typeof m.filePath === "string" && m.filePath.startsWith("mock:")) {
        bubble += `<div class="msg-image"><div class="sticker-emoji">${escapeHtml(m.filePath.slice(5))}</div></div>`;
      } else if (m.downloadState === "Done" && m.filePath) {
        // Animated loading: the placeholder reserves the final box (height
        // capped, width follows the image's aspect ratio) so the row height
        // is stable while the image decodes.
        const dw = m.dimensionsWidth > 0 ? m.dimensionsWidth : 0;
        const dh = m.dimensionsHeight > 0 ? m.dimensionsHeight : 0;
        // Stickers stay compact (official Android DC renders stickers inside
        // a 175dp square — media_bubble_sticker_dimens) instead of the
        // 45vh/450px photo cap.
        const cap = m.viewtype === "sticker" ? "175px" : "45vh, 450px";
        // Core dimensions win; else the remembered decode shape (below).
        const dims = (dw && dh) ? [dw, dh] : mediaDims(this.core.accountId, m.id);
        // Width-first box (#27): a px-only width — never a % term, Safari
        // collapses percentages inside the shrink-to-fit bubble during
        // intrinsic sizing (the macOS sliver bug) — with the height derived
        // from aspect-ratio. The formula reproduces the intended
        // min(natural, bubble, maxHeight × ratio) box: portrait shots get
        // cappedHeight × their ratio, landscape ones the 480px bubble cap.
        // The reserve IS the final box, so the decode causes no jump.
        const box = dims && dims[0] && dims[1]
          ? ` style="width:min(${dims[0]}px, 480px, calc(min(${cap}) * ${(dims[0] / dims[1]).toFixed(4)})); aspect-ratio:${dims[0]} / ${dims[1]}; max-width:100%"`
          : "";
        const wrapCls = `${m.viewtype === "sticker" ? " sticker" : ""}${box ? "" : " no-dims"}`;
        bubble += `<div class="msg-image"><div class="img-wrap${wrapCls}"${box}><div class="img-ph"><div class="img-ph-ico">${ICO.photo}</div></div><img data-src="image" decoding="async" alt=""></div></div>`;
      } else {
        const size = m.fileSize ? formatBytes(m.fileSize) : "";
        bubble += `<div class="msg-file download-btn" role="button" data-act="download">
          <div class="file-ico">${ICO.download}</div>
          <div><div class="file-name">${escapeHtml(m.fileName || "Photo")}</div><div class="file-size">${m.downloadState === "InProgress" ? "Downloading…" : size || "Tap to download"}</div></div>
        </div>`;
      }
    } else if (m.viewtype === "video") {
      if (m.downloadState === "Done" && m.filePath) {
        // Click-to-load: <velta-video> renders a static placeholder; the real
        // <video> (decoder + media requests) is only created on tap. `file`
        // carries the raw path for poster extraction; `src` is served.
        const size = m.fileSize ? formatBytes(m.fileSize) : "";
        // Known dimensions (same source as images): width-first aspect box
        // (#27, see the image reserve — px-only width, no % term), height
        // capped like photos. No dimensions: CSS falls back to the fixed
        // 260px band.
        const dw = m.dimensionsWidth > 0 ? m.dimensionsWidth : 0;
        const dh = m.dimensionsHeight > 0 ? m.dimensionsHeight : 0;
        const vBox = dw && dh ? ` style="width:min(${dw}px, 480px, calc(min(45vh, 260px) * ${(dw / dh).toFixed(4)})); aspect-ratio:${dw} / ${dh}; max-width:100%"` : "";
        bubble += `<div class="msg-video"${vBox}><velta-video src="${escapeAttr(fileUrl(m.filePath))}" file="${escapeAttr(m.filePath)}" size="${escapeAttr(size)}" duration="${m.duration || ""}" name="${escapeHtml(m.fileName || "Video")}"></velta-video></div>`;
      } else {
        const size = m.fileSize ? formatBytes(m.fileSize) : "";
        bubble += `<div class="msg-file download-btn" role="button" data-act="download">
          <div class="file-ico">${ICO.download}</div>
          <div><div class="file-name">${escapeHtml(m.fileName || "Video")}</div><div class="file-size">${m.downloadState === "InProgress" ? "Downloading…" : size || "Tap to download"}</div></div>
        </div>`;
      }
    } else if (m.viewtype === "audio" || m.viewtype === "voice") {
      if (m.downloadState === "Done" && m.filePath) {
        bubble += `<div class="msg-audio"><audio data-src="audio" controls preload="metadata"></audio></div>`;
      } else {
        const label = m.viewtype === "voice" ? "Voice message" : "Audio";
        bubble += `<div class="msg-file download-btn" role="button" data-act="download">
          <div class="file-ico">${ICO.download}</div>
          <div><div class="file-name">${escapeHtml(m.fileName || label)}</div><div class="file-size">${m.downloadState === "InProgress" ? "Downloading…" : "Tap to download"}</div></div>
        </div>`;
      }
    } else if (m.viewtype === "webxdc") {
      // Webxdc mini-app: an app card (icon + name + summary hydrate async
      // from the app manifest); tapping opens the app in the webxdc overlay.
      const appName = (m.fileName || "app.xdc").replace(/\.xdc$/i, "");
      bubble += `<div class="msg-webxdc" role="button" data-act="open-webxdc">
        <div class="webxdc-ico"><img data-webxdc-icon="${m.id}" alt="" decoding="async"><span class="webxdc-ico-letter" hidden></span><span class="webxdc-ico-glyph">${ICO.webxdc || ICO.download}</span></div>
        <div><div class="file-name">${escapeHtml(appName)}</div><div class="file-sub"><span class="webxdc-summary">Webxdc app</span> · tap to open</div></div>
        <button type="button" class="webxdc-start" data-act="open-webxdc">Start</button>
      </div>`;
    } else if (m.viewtype === "file") {
      const isDownloaded = m.downloadState === "Done";
      bubble += `<div class="msg-file${isDownloaded ? "" : " download-btn"}" role="button" data-act="${isDownloaded ? "open" : "download"}">
        <div class="file-ico">${ICO.download}</div>
        <div><div class="file-name">${escapeHtml(m.fileName || "File")}</div><div class="file-size">${m.downloadState === "InProgress" ? "Downloading…" : (m.fileSize ? formatBytes(m.fileSize) : "Tap to download")}</div></div>
      </div>`;
    } else if (m.viewtype === "vcard") {
      // Shared contact card, styled like the invite cards: avatar on the
      // left, name/address hydrate async from the vCard attachment
      // (_hydrateVcardCard below); the tap imports the contact and opens
      // the DM chat. Re-sharing a contact is the message context menu's
      // Forward.
      bubble += `<span class="invite-card vcard-card">` +
        `<span class="vcard-avatar" data-vcard-avatar></span>` +
        `<button type="button" class="invite-main" data-vcard-open>` +
          `<span class="invite-line">Chat with <b data-vcard-name>${escapeHtml(m.text || "contact")}</b></span>` +
          `<span class="invite-sub" data-vcard-sub hidden></span>` +
        `</button>` +
      `</span>`;
    }

    if (m.text) {
      // "Show Full Message…" (the official client's label): the core stores
      // the original body whenever the mail simplifier touched the message
      // (hasHtml = core's mime_modified, mapped in rpc-core). Gate on hasHtml
      // alone — the original can differ from the simplified bubble even
      // without the " [...]" cut marker (HTML mails). Forwarded copies carry
      // no stored original (hasHtml false): no button, because it could open
      // nothing.
      const fullMsg = m.hasHtml === true;
      bubble += `<div class="msg-text">${renderMarkdown(m.text)}`;
      if (m.fromContact?.bot) { // bot flag rides the sender contact (mock + core)
        const cmds = extractBotCommands(m.text);
        if (cmds.length) {
          bubble += `<div class="msg-cmds">${cmds.map((c) => `<button type="button" class="msg-cmd" data-cmd="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join("")}</div>`;
        }
      }
      if (fullMsg) bubble += `<div style="margin-top:6px"><button type="button" class="btn-text" data-fullmsg style="padding:4px 8px;font-size:13px">Show Full Message…</button></div>`;
      // Link preview card for the first link: empty slot here, hydrates
      // async below (notifyHeight keeps the scroller's layout math fresh).
      bubble += `<div class="msg-link-preview" data-lp hidden></div>`;
    } else if (m.viewtype === "call") {
      // Issue #8: call messages render as a Velta call card — direction,
      // state and duration come from core call_info (hydrated below); the
      // message text is just a stock string used as the fallback label.
      const callOut = m.from === 1;
      bubble += `<div class="call-card${callOut ? " call-out" : " call-in"}" data-call-card><span class="call-card-ico"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.24 11.4 11.4 0 003.6.58 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.6 1 1 0 01-.25 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span><span class="call-card-main"><span class="call-card-label" data-call-label>${escapeHtml(m.text || (callOut ? "Outgoing call" : "Incoming call"))}</span><span class="call-card-sub" data-call-sub></span></span></div>`;
    } else bubble += `<div class="msg-text">`;
    const edited = m.edited ? `<span class="edited">edited</span>` : "";
    // Bot chip in the meta row's right corner (same slot as "edited"): the
    // sender contact carries the core's isBot flag (rpc-core + mock). The
    // desktop hover-reply pill sticks along the bubble's right edge, so the
    // chip stays in the meta row where it never fights it. Sticker bubbles carry no meta.
    const botChip = m.kind === "msg" && !out && m.viewtype !== "sticker" && m.fromContact?.bot
      ? `<span class="bot-chip" title="Sent by a bot">bot</span>` : "";
    const star = m.starred ? `<svg class="star-ico" viewBox="0 0 24 24"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2 1.3-6.2L3 9.5l6.3-.7z" fill="currentColor"/></svg>` : "";
    const ticks = out ? `<span class="ticks-slot">${ticksSvg(m.state, "ticks")}</span>` : "";
    // Failed sends: a small red reason badge in the meta row (floats left,
    // against the right-floating timestamp) plus retry/remove buttons to the
    // LEFT of the bubble — the old in-bubble resend icon was too small a
    // target for the primary action.
    let failBadge = "";
    if (out && m.state === "failed") {
      inner += `<div class="msg-fail-actions">`
        + `<button type="button" data-act="resend" title="Retry" aria-label="Retry sending">${ICO.resend}</button>`
        + `<button type="button" data-act="fail-del" title="Remove" aria-label="Remove message">${ICO.trash}</button></div>`;
      const reason = failReason(m.error);
      failBadge = `<span class="msg-fail-badge" title="${escapeAttr(m.error || "Not sent")}">${escapeHtml(reason)}</span>`;
    }
    bubble += `<span class="msg-meta">${edited}${star}${botChip}${formatTime(m.ts)}${ticks}</span>${failBadge}</div>`;
    if (m.reactions?.length) {
      bubble += `<div class="msg-reactions">${reactionChipsHtml(m.reactions)}</div>`;
    }
    inner += `<div class="bubble${m.viewtype === "sticker" ? " sticker" : ""}">${bubble}</div>`;
    row.innerHTML = inner;
    if (item.readMarker) row.append(this._readMarkerEl());
    if (m.viewtype === "vcard" && m.filePath) this._hydrateVcardCard(row, m);
    if (m.viewtype === "call") this._hydrateCallCard(row, m);
    if (showAvatar) {
      row.querySelector("velta-avatar")?.addEventListener("click", (e) => {
        // The sender's avatar opens their profile — not row selection/menus.
        e.stopPropagation();
        if (!alive()) return;
        avatarProfileOpener?.({ contactId: fc.id, name: fc.name, contact: { addr: fc.addr }, online: fc.online, lastSeen: fc.lastSeen, color: fc.color });
      });
    }

    // One-click reply (desktop hover): the pill sits on a full-height track
    // so it sticks for the whole bubble (issue #26). Same _setReply the
    // context menu uses, plus composer focus. Read-only chats (no composer)
    // get no pill; the body class also hides any already-mounted ones.
    if (!this.readOnly) {
      const track = document.createElement("div");
      track.className = "msg-hover-reply-track";
      const hoverReply = document.createElement("button");
      hoverReply.type = "button";
      hoverReply.className = "msg-hover-reply";
      hoverReply.title = "Reply";
      hoverReply.innerHTML = `${ICO.reply}<span>Reply</span>`;
      hoverReply.addEventListener("click", e => {
        e.stopPropagation();
        const it = liveItem();
        if (!it) return;
        this._setReply(it);
        document.getElementById("composer-input")?.focus();
      });
      track.appendChild(hoverReply);
      row.querySelector(".bubble")?.appendChild(track);
    }

    // Wire up real local file URLs for images / video / audio. When media
    // can't load, show a clear placeholder instead of a broken element.
    // Media rows change height when their content loads (image decodes,
    // video metadata sets the aspect ratio) — the virtual scroller must be
    // told about each change, otherwise its layout math goes stale and the
    // list jitters while scrolling ("Item index N height changed
    // unexpectedly" console warnings).
    const notifyHeight = () => { const it = liveItem(); if (it) this.vs?.onItemHeightDidChange?.(it); };
    // Link preview hydration: only plain-text first-link messages carry the
    // slot; failed/off settings resolve null and the slot stays hidden.
    const lpSlot = row.querySelector("[data-lp]");
    if (lpSlot && lpSlot.dataset.lpDone !== "1") {
      lpSlot.dataset.lpDone = "1";
      linkPreview(m.text, chatId).then((p) => {
        if (!p || !alive() || !lpSlot.isConnected) return;
        lpSlot.innerHTML = linkPreviewCardHtml(p, firstLinkOf(m.text));
        lpSlot.hidden = false;
        notifyHeight();
      });
    }
    const webxdcCard = row.querySelector('.msg-webxdc[data-act="open-webxdc"]');
    if (webxdcCard && webxdcCard.dataset.wired !== "1") {
      webxdcCard.dataset.wired = "1";
      webxdcCard.addEventListener("click", () => {
        if (!alive()) return;
        openWebxdc(m.id, webxdcCard.querySelector(".file-name")?.textContent || "Webxdc app");
      });
      const appName = (m.fileName || "app.xdc").replace(/\.xdc$/i, "");
      // Manifest data (name/icon/summary) applies to the card; an app with no
      // icon gets a letter tile instead of the generic glyph — the official
      // client always shows the app name, never the .xdc filename.
      const hydrateWebxdcCard = (info) => {
        if (!info || !alive() || webxdcCard.isConnected === false) return;
        const name = webxdcCard.querySelector(".file-name");
        const summary = webxdcCard.querySelector(".webxdc-summary");
        if (info.name && name) name.textContent = info.name;
        if (summary) summary.textContent = info.summary || "App";
        const title = String(info.name || appName).trim();
        const iconImg = webxdcCard.querySelector("img[data-webxdc-icon]");
        const glyph = webxdcCard.querySelector(".webxdc-ico-glyph");
        const letter = webxdcCard.querySelector(".webxdc-ico-letter");
        if (info.icon && iconImg) {
          iconImg.src = appIconUrl(m.id, info.icon);
          iconImg.style.display = "block"; // beats the CSS `display: none` default
          if (glyph) glyph.hidden = true;
          if (letter) letter.hidden = true;
        } else if (letter) {
          letter.textContent = (title[0] || "A").toUpperCase();
          letter.hidden = false;
          if (glyph) glyph.hidden = true;
        }
      };
      const loadInfo = (attempt = 0) => {
        prefetchInfo(m.id).then((info) => {
          if (!alive() || webxdcCard.isConnected === false) return;
          // A failed RPC returns the generic fallback without a name — retry
          // once: the core answers with the manifest name/icon once it is idle.
          if ((!info || !info.name) && attempt === 0) {
            setTimeout(() => { if (alive() && webxdcCard.isConnected) loadInfo(1); }, 2000);
            return;
          }
          hydrateWebxdcCard(info);
        }).catch(() => {
          if (attempt === 0) setTimeout(() => { if (alive() && webxdcCard.isConnected) loadInfo(1); }, 2000);
        });
      };
      loadInfo();
    }
    if (m.fromContact?.bot) { // bot flag rides the sender contact (mock + core)
      row.querySelectorAll(".msg-cmd[data-cmd]").forEach((cmdBtn) => {
        cmdBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const input = document.getElementById("composer-input");
          if (!input) return;
          input.value = cmdBtn.dataset.cmd;
          input.focus();
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      });
    }
    const mediaImg = row.querySelector('.msg-image img[data-src]');
    if (mediaImg) {
      const wrap = mediaImg.closest(".img-wrap");
      // Fade the loaded image in over the shimmer placeholder. When the core
      // had no dimensions for this message the placeholder used a 4/3 guess,
      // so snap the wrap to the image's true geometry (the same
      // natural-size-capped box the CSS used to produce) before revealing.
      const reveal = () => {
        if (!alive()) return;
        if (mediaImg.naturalWidth && mediaImg.naturalHeight && wrap) {
          const r = mediaImg.naturalWidth / mediaImg.naturalHeight;
          wrap.style.aspectRatio = `${mediaImg.naturalWidth} / ${mediaImg.naturalHeight}`;
          // Stickers match the official Android cap (175dp, see the reserve
          // above) — the photo cap made stickers render up to 450px AND
          // jump from the reserve.
          const cap = m.viewtype === "sticker" ? 175 : 450;
          // px terms only (#27): no % inside min() — a percentage here
          // collapses the box in Safari's shrink-to-fit bubble. max-width
          // on the wrap handles the narrow-bubble clamp instead.
          wrap.style.width = `min(${mediaImg.naturalWidth}px, 480px, calc(min(${cap}px, 45vh) * ${r.toFixed(4)}))`;
          // The core had no dimensions for this message (the reserved box was
          // a 4/3 guess) — remember the true shape so the NEXT render
          // reserves the exact box and the decode causes no jump.
          if (!(m.dimensionsWidth > 0)) rememberMediaDims(this.core.accountId, m.id, mediaImg.naturalWidth, mediaImg.naturalHeight);
        }
        if (wrap && !wrap.dataset.ready) {
          wrap.dataset.ready = "1";
          wrap.classList.add("ready");
          setTimeout(() => wrap.querySelector(".img-ph")?.remove(), 400);
        }
        notifyHeight();
      };
      if (mediaImg.complete && mediaImg.naturalWidth) reveal();
      mediaImg.addEventListener("load", reveal);
      // Assign after the listeners: even cached/data-URL images fire `load`
      // asynchronously, but this order makes the reveal race-free.
      // Bubble loads use the shell's downscaled thumbnail (?w=720); the
      // lightbox below re-requests the original so full-screen shows full
      // resolution. Stickers are the exception: they load the ORIGINAL so
      // animated stickers play in-chat like official Android, and they are
      // small files anyway (the 720px thumbnail is a static JPEG that would
      // kill the animation and its bytes are negligible at ≤175px display).
      mediaImg.src = m.viewtype === "sticker"
        ? fileUrl(m.filePath)
        : fileUrl(m.filePath, { thumb: true });
      mediaImg.addEventListener("click", e => {
        e.stopPropagation();
        if (!alive()) return;
        // Received sticker: official-client behavior — tap asks to add it to
        // the user's sticker collection (misc_save_sticker), then opens the
        // lightbox either way (desktop parity: viewer + add-to-collection).
        // Ask first: the modal layer sits below the lightbox, so a modal
        // opened after it would render underneath.
        if (m.viewtype === "sticker" && m.from !== 1 && m.filePath) {
          confirmModal("Add sticker", "Add this sticker to your sticker collection?", "Add", false)
            .then(ok => {
              if (ok) {
                this.core.saveSticker(m.id).then(() => toast("Sticker saved to your collection"))
                  .catch(err => errToast("Couldn't save: " + (err?.message || err)));
              }
              openImageLightbox(fileUrl(m.filePath), m.fileName || "sticker");
            });
          return;
        }
        // Own stickers: lightbox unconditionally. The bubble loads the
        // (static) thumbnail, which on Android can still be decoding when
        // the tap lands — the old naturalWidth gate made those taps die
        // silently. The lightbox loads the original, where animated
        // stickers play.
        if (m.viewtype === "sticker" && m.filePath) {
          openImageLightbox(fileUrl(m.filePath), m.fileName || "sticker");
          return;
        }
        // Original, not the bubble thumbnail: full-screen shows full resolution.
        if (mediaImg.naturalWidth) openImageLightbox(fileUrl(m.filePath), m.fileName || "photo");
      });
      mediaImg.onerror = () => {
        if (!alive()) return;
        rustLog(`media img error src=${mediaImg.src} original=${m.filePath}`);
        // One-shot swap to the legacy chain (media HTTP server / asset
        // protocol) before giving up.
        const fb = mediaFallbackUrl(m.filePath);
        if (fb && mediaImg.dataset.fallback !== "1" && mediaImg.src !== fb) {
          mediaImg.dataset.fallback = "1";
          mediaImg.src = fb;
          return;
        }
        diagnosticsSink.append("error", `img ${m.id} failed to load`);
        const box = mediaImg.closest(".msg-image");
        if (box && !box.dataset.failed) {
          box.dataset.failed = "1";
          box.innerHTML = `<div class="media-fail"><div class="media-fail-ico">${ICO.photo}</div><div>Couldn't load image</div></div>`;
          notifyHeight();
        }
      };
    }
    const mediaAudio = row.querySelector('.msg-audio audio[data-src]');
    if (mediaAudio) {
      mediaAudio.src = fileUrl(m.filePath);
      mediaAudio.onerror = () => {
        if (!alive()) return;
        rustLog(`media audio error src=${mediaAudio.src} original=${m.filePath}`);
        const fb = mediaFallbackUrl(m.filePath);
        if (fb && mediaAudio.dataset.fallback !== "1" && mediaAudio.src !== fb) {
          mediaAudio.dataset.fallback = "1";
          mediaAudio.src = fb;
          return;
        }
        const box = mediaAudio.closest(".msg-audio");
        if (box && !box.dataset.failed) {
          box.dataset.failed = "1";
          box.innerHTML = `<div class="media-fail"><div class="media-fail-ico">${ICO.mic}</div><div>Audio can't be played</div></div>`;
        }
      };
    }

    row.addEventListener("contextmenu", e => {
      // Alt+right-click passes through to the WebView default menu
      // (Inspect / devtools) for debugging.
      const it = liveItem();
      if (e.altKey || !it) return;
      e.preventDefault();
      // Select-text mode owns the bubble: the menu stays closed until Close.
      if (this._textSelect) return;
      this._msgContextMenu(it, e.clientX, e.clientY);
    });
    let pressTimer;
    let swipe = null;
    const endReplySwipe = (commit) => {
      clearTimeout(pressTimer);
      const s = swipe;
      swipe = null;
      this._replySwipe = false;
      if (!s?.on) return;
      s.bubble.style.transition = "transform .16s ease-out";
      s.bubble.style.transform = "";
      const tidy = () => { s.bubble.style.transition = ""; };
      s.bubble.addEventListener?.("transitionend", tidy, { once: true });
      if (commit && s.dx >= 48) {
        const it = liveItem();
        if (it) this._setReply(it);
      }
    };
    row.addEventListener("touchstart", e => {
      // A second finger (pinch / two-finger swipe) never means long-press,
      // and the WebView can abort the whole gesture with touchcancel once
      // it claims it — without this listener the timer would survive.
      if (e.touches.length > 1 || this._textSelect) {
        clearTimeout(pressTimer);
        if (swipe?.on) {
          swipe.bubble.style.transform = "";
          swipe.bubble.style.transition = "";
        }
        swipe = null;
        this._replySwipe = false;
        return;
      }
      pressTimer = setTimeout(() => { const it = liveItem(); if (it) this._msgContextMenu(it, innerWidth / 2, innerHeight / 2); }, 500);
      swipe = null;
      if (!this._mobileGestures() || this.readOnly || this.selection.size || this._backSwipe) return;
      const bubble = e.target.closest?.(".bubble");
      if (!bubble || e.target.closest?.("button, a, input, textarea, audio, video")) return;
      const t = e.touches[0];
      swipe = { x: t.clientX, y: t.clientY, bubble, dx: 0, on: false };
    }, { passive: true });
    row.addEventListener("touchmove", e => {
      clearTimeout(pressTimer);
      if (!swipe || this._backSwipe || e.touches.length !== 1) {
        if (swipe?.on) {
          swipe.bubble.style.transform = "";
          swipe.bubble.style.transition = "";
        }
        swipe = null;
        this._replySwipe = false;
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (!swipe.on) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { swipe = null; return; }
        if (dx < 12 || Math.abs(dx) < Math.abs(dy)) return;
        swipe.on = true;
        this._replySwipe = true;
        swipe.bubble.style.transition = "none";
      }
      swipe.dx = Math.max(0, Math.min(dx, 64));
      swipe.bubble.style.transform = swipe.dx ? `translateX(${swipe.dx}px)` : "";
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    row.addEventListener("touchend", () => endReplySwipe(true));
    row.addEventListener("touchcancel", () => endReplySwipe(false));
    row.addEventListener("click", async e => {
      if (!alive()) return;
      if (this.selection.size) { this._toggleSelect(m.id, row); return; }
      // Bubble anchors (markdown links, link-preview cards): delegated, not
      // per-anchor wiring — the preview card's <a> is inserted ASYNC after
      // row build, so per-anchor wiring never sees it. Android WebView drops
      // target=_blank → in-app browser overlay; desktop opens in the SYSTEM
      // browser via the opener plugin (window.open is silently swallowed by
      // wry's new-window handling — it is NOT a working fallback path).
      const link = e.target.closest("a[href]");
      if (link) {
        const href = link.getAttribute("href") || "";
        if (/^https?:/i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          if (/Android/.test(navigator.userAgent)) openInAppBrowser(href);
          else openExternal(href);
        }
        return; // non-http hrefs: browser default, never row selection
      }
      const chip = e.target.closest("[data-react]");
      if (chip) { this.core.addReaction(this.chat.id, m.id, chip.dataset.react); return; }
      const quote = e.target.closest("[data-quote]");
      if (quote) { this._jumpToMessage(Number(quote.dataset.quote)); return; }
      const mediaAction = e.target.closest("[data-act]");
      if (mediaAction) {
        e.stopPropagation();
        if (mediaAction.dataset.act === "download" && m.downloadState !== "InProgress") this._downloadMedia(m.id);
        else if (mediaAction.dataset.act === "open") this._openFile(m.filePath, m.fileName);
        else if (mediaAction.dataset.act === "resend") this._resendMessage(m);
        else if (mediaAction.dataset.act === "fail-del") this._deleteFailed(m);
        else if (mediaAction.dataset.act === "lc-retry") this._lcRetryTransfer(m);
        else if (mediaAction.dataset.act === "show-original") this._showOriginal(m);
        return;
      }
      const vcardBtn = e.target.closest("[data-vcard-open]");
      if (vcardBtn) { e.stopPropagation(); this._openVcardContact(m); return; }
      const readMore = e.target.closest("[data-fullmsg]");
      if (readMore) { e.stopPropagation(); this._showFullMessage(m); return; }
    });
    return row;
  }

  // "Show Full Message…": render the original, unsimplified mail in the same
  // isolated overlay as HTML attachments — sandboxed srcdoc iframe, opaque
  // origin, scripts run but can touch nothing of ours. Remote images stay
  // blocked by the page CSP (srcdoc inherits it) — matches the zero-remote-
  // content privacy stance; loading them needs a deliberate exception later.
  async _showFullMessage(m) {
    let html = null;
    try {
      html = await this.core.getMessageHtml(m.id);
    } catch {
      html = null;
    }
    if (!html) {
      errToast("The full version isn't available for this message");
      return;
    }
    this._openHtmlOverlay("Full message", { html });
  }

  // Fill a call card's label and sub-line from the core's call state
  // (issue #8). Fire-and-forget with a fallback to the stock message text;
  // the card is height-stable, so no scroller notification is needed.
  async _hydrateCallCard(row, m) {
    let state = null;
    try {
      state = await this.core.callState?.(m.id) ?? null;
    } catch { return; } // not a call / backend without calls — keep fallback text
    if (!state || !row.isConnected) return;
    const card = row.querySelector(".call-card");
    if (!card) return;
    const label = card.querySelector("[data-call-label]");
    const sub = card.querySelector("[data-call-sub]");
    const kind = state.kind || state;
    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (kind === "Completed") {
      if (label) label.textContent = m.from === 1 ? "Outgoing call" : "Incoming call";
      if (sub) sub.textContent = `Ended · ${fmt(state.duration || 0)}`;
    } else if (kind === "Missed") {
      if (label) label.textContent = "Missed call";
      card.classList.add("missed");
    } else if (kind === "Declined") {
      if (label) label.textContent = "Call declined";
      card.classList.add("missed");
    } else if (kind === "Canceled") {
      if (label) label.textContent = "Call canceled";
    } else if (kind === "Active" || kind === "Alerting") {
      if (label) label.textContent = "Call in progress…";
    }
  }

  // True when the event target is the selected text or the in-bubble bar.
  // Walks parents so the headless test DOM (no Element.closest) agrees with
  // the WebView. A tap there adjusts the native handles or presses Reply /
  // Copy / Close; anything else leaves the mode.
  _pointerInTextSelect(target) {
    let el = target;
    while (el && el !== document && el !== document.body) {
      const name = el.className;
      if (typeof name === "string") {
        const cls = name.split(/\s+/);
        if (cls.includes("msg-select-bar") || cls.includes("text-selecting")) return true;
      }
      el = el.parentElement || el.parent || null;
    }
    return false;
  }

  _selectionInside(target, sel) {
    if (!target || !sel?.rangeCount) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    let el = node?.nodeType === 3 ? node.parentElement : node;
    while (el) {
      if (el === target) return true;
      el = el.parentElement || el.parent || null;
    }
    return false;
  }

  // The span the user currently has selected, or the whole bubble when the
  // WebView has no Selection (select-all on entry still covers that case).
  _selectionText() {
    const target = this._textSelect?.target;
    let raw = "";
    try {
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed && this._selectionInside(target, sel)) raw = sel.toString();
    } catch { /* headless */ }
    if (!raw && target) raw = target.textContent || "";
    return raw.replace(/\s+/g, " ").trim();
  }

  _dropSelection() {
    let sel;
    try { sel = window.getSelection?.(); } catch { return; }
    if (!sel) return;
    try { sel.removeAllRanges(); } catch {}
    try { sel.empty?.(); } catch {}
  }

  // Android WebView draws selection handles outside the page. removeAllRanges
  // only dismisses them while the node is still user-select:text. Flipping
  // to none first leaves the handles on screen after the bar is gone.
  _clearNativeSelection(target) {
    let sel;
    try { sel = window.getSelection?.(); } catch { return; }
    if (!sel) return;
    this._dropSelection();
    try {
      if (target && typeof document.createRange === "function") {
        const range = document.createRange();
        const anchor = target.firstChild || target;
        range.setStart(anchor, 0);
        range.collapse(true);
        sel.addRange(range);
        this._dropSelection();
      }
    } catch { /* headless */ }
  }

  _leaveTextSelection() {
    const state = this._textSelect;
    if (!state) return;
    this._textSelect = null;
    this._selectSnap = null;
    document.removeEventListener("pointerdown", state.exit, true);
    const target = state.target;
    this._clearNativeSelection(target);
    // none, then one more clear, then drop the inline override so the
    // touch CSS (user-select:none without .text-selecting) owns it.
    try {
      if (target?.style) {
        target.style.webkitUserSelect = "none";
        target.style.userSelect = "none";
      }
    } catch {}
    this._dropSelection();
    target?.classList.remove("text-selecting");
    state.bar?.remove();
    try {
      if (target?.style) {
        target.style.webkitUserSelect = "";
        target.style.userSelect = "";
      }
    } catch {}
    this._dropSelection();
    try { requestAnimationFrame(() => this._dropSelection()); } catch {}
    try { if (document.activeElement === target) target.blur?.(); } catch {}
    const item = this.msgIndex.get(Number(state.row?.dataset?.msgid));
    if (item) this.vs?.onItemHeightDidChange?.(item);
  }

  _replyToSelection() {
    const msgId = Number(this._textSelect?.row?.dataset?.msgid);
    const fragment = (this._selectSnap || this._selectionText()).slice(0, 800);
    if (!fragment) return;
    this._leaveTextSelection();
    this._setReplyFragment(msgId, fragment);
  }

  _copySelection() {
    const text = this._selectSnap || this._selectionText();
    if (!text) return;
    this._leaveTextSelection();
    navigator.clipboard?.writeText(text);
    toast("Copied");
  }

  _selectMessageText(msgId) {
    const row = this.listEl?.querySelector?.(`[data-msgid="${msgId}"]`);
    if (row) this._enterBubbleTextSelection(row);
  }

  // Issue #35. Mobile is the overlay column (max-width 820px) without a
  // fine pointer. A missing matchMedia (some node tests) does not invent
  // a phone — those tests opt in by stubbing matchMedia.
  _mobileGestures() {
    try {
      return matchMedia("(max-width: 820px)").matches
        && !matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch {
      return false;
    }
  }

  // Desktop already selects with the mouse and the floating Reply chip.
  // Same gate as the touch user-select:none rule. A missing matchMedia
  // (the node tests) still offers the item.
  _offerSelectText() {
    try {
      return !matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch {
      return true;
    }
  }

  // Select text (context menu, #36): native selection for this one bubble,
  // plus Reply / Copy / Close inside it. Touch keeps user-select:none until
  // .text-selecting (see the touch CSS near .bubble). The next pointerdown
  // outside the text and the bar exits. Re-entry tears the previous listener
  // down first so two bubbles are never selecting at once.
  _enterBubbleTextSelection(row) {
    this._leaveTextSelection();
    const target = row.querySelector(".msg-text");
    const bubble = row.querySelector(".bubble");
    if (!target || !bubble) return;
    target.classList.add("text-selecting");
    const bar = document.createElement("div");
    bar.className = "msg-select-bar";
    const addBtn = (label, onClick, keepSelection) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "msg-select-btn";
      b.textContent = label;
      b.addEventListener("pointerdown", e => {
        e.stopPropagation();
        // Reply and Copy read the span on click, so the tap must not
        // collapse it. Close must NOT preventDefault: that is what keeps
        // Android's selection handles up after the bar is gone.
        if (!keepSelection) return;
        this._selectSnap = this._selectionText();
        e.preventDefault();
      });
      b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); onClick(); });
      bar.appendChild(b);
    };
    if (!this.readOnly) addBtn("Reply", () => this._replyToSelection(), true);
    addBtn("Copy", () => this._copySelection(), true);
    addBtn("Close", () => this._leaveTextSelection(), false);
    bubble.insertBefore(bar, bubble.children?.[0] || null);
    const exit = (e) => {
      if (this._pointerInTextSelect(e.target)) return;
      this._leaveTextSelection();
    };
    this._textSelect = { row, target, bar, exit };
    if (this._selChip) this._selChip.hidden = true;
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* headless/odd webview — the class still enables manual selection */ }
    document.addEventListener("pointerdown", exit, true);
    const item = this.msgIndex.get(Number(row.dataset.msgid));
    if (item) this.vs?.onItemHeightDidChange?.(item);
  }

  // Fill a shared-contact card's avatar, name and address from its vCard
  // attachment. Fire-and-forget: the card already shows the message summary.
  // Guarded at continuation time against account epoch and chat identity —
  // rows are cached across chat switches, so build-time sessions go stale.
  _hydrateVcardCard(row, m) {
    this.core.parseVcard(m.filePath).then(([c]) => {
      if (!this._isCurrent() || this.chat?.id !== m.chatId || !c) return;
      const card = row.querySelector(".vcard-card");
      const nameEl = row.querySelector("[data-vcard-name]");
      const subEl = row.querySelector("[data-vcard-sub]");
      const avEl = row.querySelector("[data-vcard-avatar]");
      if (!card) return;
      card.dataset.name = c.displayName || "";
      card.dataset.addr = c.addr || "";
      if (nameEl && c.displayName) nameEl.textContent = c.displayName;
      if (subEl && c.addr) { subEl.textContent = c.addr; subEl.hidden = false; }
      if (avEl) {
        if (c.profileImage) {
          // Base64 PHOTO sniffing: JPEG streams start "/9j/", PNG "iVBOR".
          const mime = c.profileImage.startsWith("iVBOR") ? "png" : "jpeg";
          const img = new Image();
          img.alt = "";
          img.src = `data:image/${mime};base64,${c.profileImage}`;
          avEl.replaceChildren(img);
        } else {
          avEl.textContent = (c.displayName || c.addr || "?").trim().charAt(0).toUpperCase();
          avEl.style.background = c.color || "#777";
        }
      }
    }).catch(() => {});
  }

  // Tap on a shared-contact card: import the vCard and open the DM chat.
  async _openVcardContact(m) {
    try {
      const contactIds = await this.core.importVcard(m.filePath);
      const contactId = contactIds?.[0];
      if (!contactId) { toast("This contact card is empty"); return; }
      const chatId = await this.core.createChatByContactId(contactId);
      this.onOpenChat?.(Number(chatId));
    } catch (err) {
      errToast("Couldn't add contact: " + (err?.message || err));
    }
  }

  /* ================= message actions ================= */

  _msgContextMenu(item, x, y) {
    // The in-bubble select bar is up: long-press and right-click stay shut.
    if (this._textSelect) return;
    const session = this._session;
    if (!this._isCurrent(session) || this.msgIndex.get(item.msg.id) !== item) return;
    const m = item.msg;
    if (m.kind === "service") return;
    const items = [];
    // No reply without a composer (read-only chats).
    if (!this.readOnly) items.push({ label: "Reply", icon: ICO.reply, onClick: () => this._setReply(item) });
    // Core mirrors these guards (own + plain text + non-empty); the menu just
    // hides the entry where the core would refuse. P2P chats keep a separate
    // message store — no edit there yet.
    if (!this.chat?.isP2p && m.from === 1 && m.viewtype === "text" && m.text) items.push({ label: "Edit", icon: ICO.edit, onClick: () => this._setEdit(item) });
    if (!this.chat?.isP2p && m.viewtype === "sticker" && m.from !== 1 && m.filePath) {
      items.push({
        label: "Save sticker", icon: ICO.download,
        onClick: () => {
          this.core.saveSticker(m.id).then(() => toast("Sticker saved")).catch((err) => errToast("Couldn't save: " + (err.message || err)));
        },
      });
    }
    if (this.core.pinMessage) {
      items.push({
        label: m.pinned ? "Unpin" : "Pin",
        icon: ICO.pin,
        onClick: () => {
          this.core.pinMessage(m.id, !m.pinned)
            .then(() => { m.pinned = !m.pinned; return this._refreshPinnedBar(); })
            .catch((err) => errToast("Couldn't " + (m.pinned ? "unpin" : "pin") + ": " + (err.message || err)));
        },
      });
    }
    // Captions count: any bubble with text can enter selection mode. Copy
    // text stays whole-message and plain-text only. Touch only — desktop
    // uses the mouse and the floating Reply chip.
    if (m.text && this._offerSelectText()) items.push({ label: "Select text", icon: ICO.copy, onClick: () => this._selectMessageText(m.id) });
    if (m.viewtype === "text" && m.text) items.push({ label: "Copy text", icon: ICO.copy, onClick: () => { navigator.clipboard?.writeText(m.text); toast("Copied"); } });
    items.push(
      { label: "Forward", icon: ICO.forward, onClick: () => this._forward([m.id]) },
    );
    // Resend: re-queues the own message through the pipeline (core
    // resend_messages flips it back to OutPending and retransmits —
    // recipients get a duplicate). The core rejects info/drafts/pending
    // messages with an error, which _resendMessage toasts. P2P chats retry
    // through their own engine paths, not the core.
    if (!this.chat?.isP2p && m.from === 1) items.push({ label: "Resend", icon: ICO.resend, onClick: () => this._resendMessage(m) });
    items.push(
      { label: "Save to Saved Messages", icon: ICO.star, onClick: async () => {
        try {
          await this.core.starMessages(session.chatId, [m.id]);
          if (!this._isCurrent(session)) return;
          toast("Saved");
          this.onChatsChanged();
        } catch (err) {
          if (this._isCurrent(session)) errToast("Couldn't save message: " + (err.message || err));
        }
      } },
      { label: "React", icon: QUICK_REACTIONS[0], onClick: () => this._reactionMenu(item, x, y) },
      { label: "Select", icon: ICO.select, onClick: () => this._enterSelection(m.id) },
    );
    items.push(
      { label: "Info", icon: ICO.info, onClick: () => this._showInfo(item) },
      "-",
      { label: "Delete", icon: ICO.trash, danger: true, onClick: () => this._delete([m.id]) },
    );
    showContextMenu(items.map(action => action === "-" ? action : {
      ...action, onClick: () => { if (this._isCurrent(session)) return action.onClick(); },
    }), x, y);
  }

  _reactionMenu(item, x, y) {
    const session = this._session;
    if (!this._isCurrent(session) || this.msgIndex.get(item.msg.id) !== item) return;
    showContextMenu(QUICK_REACTIONS.map(e => ({
      label: e, onClick: () => { if (this._isCurrent(session)) return this.core.addReaction(session.chatId, item.msg.id, e); },
    })), x, y - 10);
  }

  _showInfo(item) {
    const m = item.msg;
    // Honest pipeline phrasing: chatmail is store-and-forward, so what we
    // can vouch for ENDS at the own relay's acceptance — "seen" only ever
    // comes from the recipient's read receipt (MDN). Never promise more.
    const stateLines = {
      pending: "Sending — your relay has not accepted it yet (it retries on its own while the relay is unreachable)",
      sent: "Sent — accepted by your relay",
      delivered: "Sent — accepted by your relay",
      read: "Sent and seen (the recipient's device confirmed)",
      received: "Received",
      failed: "Failed to send" + (m.error ? `: ${failReason(m.error)}` : ""),
    };
    showModal({
      title: "Message info",
      body: `
      <div class="enc-note">${ICO.lock}<span>This message is end-to-end encrypted with OpenPGP. Only you and the recipient can read it — the chatmail relay cannot.</span></div>
      <div class="info-row"><span class="k">Type</span><span class="v">${m.viewtype}</span></div>
      <div class="info-row"><span class="k">From</span><span class="v">${escapeHtml(m.fromContact.name)}</span></div>
      <div class="info-row"><span class="k">Sent</span><span class="v">${new Date(m.ts).toLocaleString()}</span></div>
      <div class="info-row"><span class="k">State</span><span class="v">${stateLines[m.state] || m.state}</span></div>
      <div class="info-row"><span class="k">Message ID</span><span class="v">#${m.id}</span></div>`,
    });
  }

  async _delete(ids) {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat) return;
    // Mirror the official Delta Chat desktop dialog: "Delete for everyone"
    // is offered only when the core can honor it — self-sent messages in an
    // encrypted chat that isn't self-talk (delete_messages_for_all rules).
    const msgs = ids.map(id => this.msgIndex.get(id)?.msg).filter(Boolean);
    const canForAll = msgs.length === ids.length
      && this.chat.kind !== "saved"
      && this.chat.encrypted !== false
      && msgs.every(m => m.from === 1);
    const choice = await confirmDeleteMessagesModal(ids.length, canForAll);
    if (!choice || !this._isCurrent(session)) return;
    try {
      await this.core.deleteMessages(session.chatId, ids, { forAll: choice === "everyone" });
      if (!this._isCurrent(session)) return;
      this.exitSelection();
      this.onChatsChanged();
    } catch (err) {
      if (this._isCurrent(session)) errToast("Couldn't delete messages: " + (err.message || err), 4500);
    }
  }

  _forward(ids) {
    this.onForward(ids);
  }

  /* ================= selection mode ================= */

  _enterSelection(msgId) {
    this.selection.add(msgId);
    this._applySelectionUI();
  }

  _toggleSelect(msgId, row) {
    if (this.selection.has(msgId)) this.selection.delete(msgId);
    else this.selection.add(msgId);
    row?.classList.toggle("selected", this.selection.has(msgId));
    const box = row?.querySelector(".msg-checkbox");
    if (box) box.innerHTML = this.selection.has(msgId) ? ICO.check : "";
    if (!this.selection.size) this.exitSelection();
    else document.getElementById("sel-count").textContent = this.selection.size;
  }

  _applySelectionUI() {
    document.getElementById("selection-bar").hidden = this.selection.size === 0;
    document.getElementById("chat-head-actions").style.visibility = this.selection.size ? "hidden" : "";
    document.getElementById("sel-count").textContent = this.selection.size;
    for (const row of this.listEl.querySelectorAll(".msg-row[data-msgid]")) {
      const id = Number(row.dataset.msgid);
      row.classList.add("selectable");
      row.classList.toggle("selected", this.selection.has(id));
      if (!row.querySelector(".msg-checkbox")) {
        const cb = document.createElement("div");
        cb.className = "msg-checkbox";
        cb.innerHTML = this.selection.has(id) ? ICO.check : "";
        row.prepend(cb);
      }
    }
  }

  exitSelection() {
    this.selection.clear();
    document.getElementById("selection-bar").hidden = true;
    document.getElementById("chat-head-actions").style.visibility = "";
    for (const row of this.listEl.querySelectorAll(".msg-row")) {
      row.classList.remove("selectable", "selected");
      row.querySelector(".msg-checkbox")?.remove();
    }
  }

  _bindSelectionBar() {
    document.getElementById("btn-sel-close").addEventListener("click", () => this.exitSelection());
    document.querySelector(".sel-actions").addEventListener("click", async e => {
      const session = this._session;
      if (!this._isCurrent(session) || !this.chat) return;
      const btn = e.target.closest("[data-sel]");
      if (!btn) return;
      const ids = [...this.selection];
      const act = btn.dataset.sel;
      if (act === "reply") {
        const item = this.msgIndex.get(ids[0]);
        if (item) this._setReply(item);
        this.exitSelection();
      } else if (act === "forward") this._forward(ids);
      else if (act === "copy") {
        const texts = ids.map(id => this.msgIndex.get(id)?.msg.text).filter(Boolean);
        navigator.clipboard?.writeText(texts.join("\n"));
        toast("Copied " + texts.length + " messages");
        this.exitSelection();
      } else if (act === "star") {
        try {
          await this.core.starMessages(session.chatId, ids);
          if (!this._isCurrent(session)) return;
          toast("Saved to Saved Messages");
          this.exitSelection();
          this.onChatsChanged();
        } catch (err) {
          if (this._isCurrent(session)) errToast("Couldn't save messages: " + (err.message || err));
        }
      } else if (act === "delete") this._delete(ids);
      else if (act === "info") {
        const item = this.msgIndex.get(ids[0]);
        if (item) this._showInfo(item);
      }
    });
  }

  /* ================= reply ================= */

  _setReply(item) {
    if (this.readOnly) return;
    if (!this._isCurrent() || this.msgIndex.get(item.msg.id) !== item) return;
    this.replyTo = item.msg;
    this.replyFragment = null;
    this._renderReplyPreview();
    document.getElementById("composer-input").focus();
  }

  _setEdit(item) {
    if (!this._isCurrent() || this.msgIndex.get(item.msg.id) !== item) return;
    this.replyTo = null;
    this.replyFragment = null;
    this.editingMsg = item.msg;
    this._renderReplyPreview();
    const input = document.getElementById("composer-input");
    input.value = item.msg.text;
    input.dispatchEvent(new Event("input", { bubbles: true })); // regrow textarea
    input.focus();
  }

  // Fragment quote: reply referencing only the selected span of a bubble's
  // text. Travels as email/DC-style "> " quote lines — every client (Velta
  // included) renders them as a quote block, so no core changes are needed
  // and no separate quote header is attached (that would duplicate the quote).
  _setReplyFragment(msgId, fragment) {
    if (this.readOnly) return;
    const item = this.msgIndex.get(msgId) || this.items.find(i => i.type === "msg" && i.msg.id === msgId);
    if (!item || !this._isCurrent()) return;
    this.replyTo = item.msg;
    this.replyFragment = fragment;
    this._renderReplyPreview();
    document.getElementById("composer-input").focus();
  }

  _renderReplyPreview() {
    const bar = document.getElementById("reply-preview");
    if (!this.replyTo && !this.editingMsg) { bar.hidden = true; return; }
    bar.hidden = false;
    if (this.editingMsg) {
      document.getElementById("reply-name").textContent = "Editing message";
      document.getElementById("reply-text").textContent = this.editingMsg.text || "";
      return;
    }
    document.getElementById("reply-name").textContent = this.replyTo.fromContact?.name || "You";
    document.getElementById("reply-text").textContent = this.replyFragment
      ? "“" + this.replyFragment + "”"
      : (this.replyTo.text || this.replyTo.viewtype);
  }

  // Selection → floating "Reply" chip: watches text selections anchored in a
  // bubble's text and offers quoting just that fragment.
  _bindSelectionQuote() {
    const chip = document.createElement("button");
    chip.id = "sel-quote-chip";
    chip.type = "button";
    chip.hidden = true;
    chip.textContent = "Reply";
    chip.addEventListener("pointerdown", e => e.preventDefault()); // keep the selection alive
    chip.addEventListener("click", () => {
      const sel = this._pendingQuoteSel;
      chip.hidden = true;
      if (sel) this._setReplyFragment(sel.msgId, sel.fragment);
    });
    document.body.appendChild(chip);
    this._selChip = chip;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try { this._updateSelChip(); }
        catch (e) { (window.__chipErr = window.__chipErr || []).push(e.message + " | " + e.stack.split("\n")[1]); }
      });
    };
    document.addEventListener("selectionchange", schedule);
    this.scrollEl.addEventListener("scroll", () => { chip.hidden = true; }, { passive: true });
  }

  _updateSelChip() {
    const chip = this._selChip;
    // The in-bubble bar already has Reply. A second floating chip would
    // sit on top of the same selection.
    if (this._textSelect) { chip.hidden = true; return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { chip.hidden = true; return; }
    const range = sel.getRangeAt(0);
    const startNode = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const row = startNode?.closest?.(".msg-text")?.closest(".msg-row");
    if (!row || !this.listEl.contains(row) || !row.dataset.msgid) { chip.hidden = true; return; }
    const fragment = sel.toString().replace(/\s+/g, " ").trim().slice(0, 800);
    const rect = range.getBoundingClientRect();
    if (!fragment || !rect || (!rect.width && !rect.height)) { chip.hidden = true; return; }
    this._pendingQuoteSel = { msgId: Number(row.dataset.msgid), fragment, rect };
    chip.hidden = false;
    chip.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - 36, innerWidth - 84)) + "px";
    chip.style.top = Math.max(8, rect.top - 42) + "px";
  }

  /* ================= composer ================= */

  _bindComposer() {
    const input = document.getElementById("composer-input");
    const send = document.getElementById("btn-send");
    const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + "px"; };
    input.addEventListener("input", grow);
    input.addEventListener("keydown", e => {
      // Send on Enter is a setting (drawer, default on). Off: Enter falls
      // through to the textarea's native newline insert, whose input event
      // runs grow() — every line stays visible. Shift+Enter is always a
      // newline; Enter during IME composition never sends. With the setting
      // off, Ctrl/Cmd+Enter still sends (#56).
      const sendOnEnter = localStorage.getItem("velta-send-enter") !== "0";
      const chordSend = !sendOnEnter && (e.ctrlKey || e.metaKey);
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (sendOnEnter || chordSend)) { e.preventDefault(); this._send(); }
    });
    input.addEventListener("paste", e => {
      const session = this._session;
      if (!this._isCurrent(session) || !this.chat) return;
      const items = [...(e.clipboardData?.items || [])];
      let file = items.find(i => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
      if (!file) file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
      if (!file) return; // fall through to normal text paste
      e.preventDefault();
      this._setPendingMedia("image", file);
    });
    send.addEventListener("click", () => this._send());
    document.getElementById("btn-sticker").addEventListener("click", () => this._toggleStickerPicker());
    document.getElementById("btn-media-close").addEventListener("click", () => this._clearPendingMedia());
    document.getElementById("btn-media-crop").addEventListener("click", async () => {
      const pm = this.pendingMedia;
      if (!pm || pm.kind !== "image" || !pm.blob) return;
      const cropped = await openImageCropper(pm.url).finally(() => {}); // pm.url still alive — cropped replaces it
      if (cropped) this._setPendingMedia("image", cropped, null, pm.name); // cropped bytes need writing
    });
    document.getElementById("btn-reply-close").addEventListener("click", () => { this.replyTo = null; this.replyFragment = null; this.editingMsg = null; this._renderReplyPreview(); });
    document.getElementById("btn-attach").addEventListener("click", e => {
      const session = this._session;
      if (!this._isCurrent(session) || !this.chat) return;
      // Anchored to the attach button: bottom edge 10px above its top,
      // growing upward.
      const anchor = e.currentTarget;
      const r = anchor.getBoundingClientRect();
      const x = Math.min(e.currentTarget.getBoundingClientRect().left, window.innerWidth - 220);
      const attachItems = [
        { label: "Photo", icon: ICO.photo, onClick: () => this._sendAttachment("image") },
        { label: "Video", icon: ICO.photo, onClick: () => this._sendAttachment("video") },
        { label: "File", icon: ICO.file, onClick: () => this._sendAttachment("file") },
      ];
      // Voice messages are not supported in local chat — hide the item there.
      if (!this.chat?.isP2p) {
        attachItems.push({ label: "Voice message", icon: ICO.mic, onClick: () => this._sendAttachment("voice") });
      }
      const menu = showContextMenu(attachItems.map(action => ({ ...action, onClick: () => { if (this._isCurrent(session)) return action.onClick(); } })), x, 8);
      menu.classList.add("attach-pop");
      menu.style.top = "auto";
      menu.style.bottom = (window.innerHeight - r.top + 10) + "px";
      menu.style.left = x + "px";
      requestAnimationFrame(() => {
        if (!this._isCurrent(session)) return;
        if (menu.getBoundingClientRect().top < 8) {
          menu.style.bottom = "auto";
          menu.style.top = "8px";
        }
      });
    });
  }

  // Sticker picker: anchored above the composer; a picked sticker sends
  // immediately as a Sticker-viewtype message (transparent bubble).
  _toggleStickerPicker() {
    if (document.querySelector(".sticker-pop")) { closeAllPopups(); return; }
    const session = this._session;
    showStickerPicker({
      getStickers: () => this.core.getStickers(),
      onPick: (path) => {
        if (!this._isCurrent(session) || !this.chat) return;
        this._sendArchivedAware(session.chatId, { text: "", viewtype: "sticker", file: path })
          .then((msg) => { if (this._isCurrent(session)) { this.appendOutgoing(msg); this.onChatsChanged(); } })
          .catch((err) => { if (this._isCurrent(session)) errToast("Couldn't send sticker: " + (err.message || err)); });
      },
    });
  }

  // Pending attachment (official-client pattern): the picked media shows as a
  // strip above the composer input, the caption IS the composer text, Send
  // sends both. src is a Blob (paste/crop — object URL owned by us) or an
  // already-resolved URL string (videos — never read big files into RAM);
  // corePath is the core-readable path when one exists (picker), else null
  // (clipboard blobs are written to the uploads directory on send).
  _setPendingMedia(kind, src, corePath = null, name = null) {
    this._clearPendingMedia();
    const owned = typeof src !== "string";
    this.pendingMedia = {
      kind, blob: owned ? src : null,
      url: owned ? URL.createObjectURL(src) : src,
      corePath, name,
    };
    this._renderMediaPreview();
    document.getElementById("composer-input").focus(); // caption = input (#5)
  }

  _clearPendingMedia() {
    if (this.pendingMedia?.blob) URL.revokeObjectURL(this.pendingMedia.url);
    this.pendingMedia = null;
    this._renderMediaPreview();
  }

  _renderMediaPreview() {
    const bar = document.getElementById("media-preview");
    const thumb = document.getElementById("media-preview-thumb");
    const name = document.getElementById("media-preview-name");
    const crop = document.getElementById("btn-media-crop");
    const pm = this.pendingMedia;
    if (!pm) { bar.hidden = true; thumb.replaceChildren(); thumb.classList.remove("ph-word"); name.textContent = ""; crop.hidden = true; return; }
    bar.hidden = false;
    thumb.replaceChildren();
    thumb.classList.remove("ph-word");
    if (pm.kind === "video") {
      // Native first-frame thumb: preload=metadata + the #t fragment paints
      // frame 0 — no poster extraction (unstable, removed).
      const media = document.createElement("video");
      media.muted = true; media.playsInline = true;
      media.preload = "metadata";
      media.src = pm.url + (pm.url.includes("#") ? "" : "#t=0.1");
      thumb.append(media);
    } else {
      const media = document.createElement("img");
      media.src = pm.url; media.alt = "";
      thumb.append(media);
    }
    name.textContent = pm.name || (pm.kind === "video" ? "Video" : "Photo");
    crop.hidden = pm.kind !== "image";
  }

  // Send the pending attachment with the composer text as its caption.
  async _sendPendingMedia(session) {
    const pm = this.pendingMedia;
    const input = document.getElementById("composer-input");
    const text = input.value.trim();
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    this._clearPendingMedia();
    input.value = ""; input.style.height = "auto";
    try {
      const { quoteId, quoteText, prefix } = this._takeQuote();
      let filePath = pm.corePath;
      let filename;
      if (filePath) {
        filename = filePath.replace(/\\/g, "/").split("/").pop();
      } else {
        const t = pm.blob.type;
        const ext = t === "image/jpeg" ? "jpg" : t === "image/webp" ? "webp" : t === "image/gif" ? "gif" : t?.startsWith("video/") ? "mp4" : "png";
        filename = `${pm.kind}-${Date.now()}.${ext}`;
        filePath = await invoke("resolve_upload_path", { filename });
        diagnosticsSink.append("info", `media: upload path = ${filePath}`);
        if (!filePath) throw new Error("resolve_upload_path returned empty");
        const bytes = new Uint8Array(await pm.blob.arrayBuffer());
        await invoke("plugin:fs|write_file", bytes, {
          headers: { path: encodeURIComponent(filePath) },
        });
        diagnosticsSink.append("info", `media: wrote ${bytes.length} bytes`);
      }
      const msg = await this._sendArchivedAware(session.chatId, { text: prefix + text, viewtype: pm.kind, file: filePath, filename, quoteId, quoteText });
      if (!this._isCurrent(session)) return;
      this.appendOutgoing(msg);
      this.onChatsChanged();
    } catch (err) {
      diagnosticsSink.append("error", `${pm.kind} send failed: ${err?.message || err}`);
      if (this._isCurrent(session)) errToast(`Could not send ${pm.kind}: ` + (err?.message || err));
    }
  }


  // Consume the pending reply (same semantics for every send path): a
  // full-message reply rides the core's quotedMessageId; a fragment reply
  // becomes "> " quote lines prefixed to the text (renders as a quote block
  // in every Delta Chat client). Attachment sends use this too — picking a
  // file must not silently drop the reply (it used to).
  _takeQuote() {
    const quoteId = this.replyFragment ? null : (this.replyTo?.id ?? null);
    const quoteText = quoteId != null ? (this.replyTo?.text || "") : null;
    const prefix = this.replyFragment
      ? this.replyFragment.split("\n").map(l => "> " + l).join("\n") + "\n\n"
      : "";
    this.replyTo = null;
    this.replyFragment = null;
    this._renderReplyPreview();
    return { quoteId, quoteText, prefix };
  }

  async _send() {
    const session = this._session;
    const input = document.getElementById("composer-input");
    const text = input.value.trim();
    if (!this._isCurrent(session) || !this.chat) return;
    if (this.pendingMedia) {
      // Attachment pending: caption = composer text (may be empty).
      await this._sendPendingMedia(session);
      return;
    }
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    if (this.editingMsg) {
      const editing = this.editingMsg;
      this.editingMsg = null;
      this._renderReplyPreview();
      try {
        await this.core.editMessage(session.chatId, editing.id, text);
      } catch (err) {
        if (this._isCurrent(session)) errToast("Couldn't edit message: " + (err.message || err));
      }
      return;
    }
    const { quoteId, quoteText, prefix } = this._takeQuote();
    const sendText = prefix + text;
    try {
      const msg = await this._sendArchivedAware(session.chatId, { text: sendText, quoteId, quoteText });
      if (!this._isCurrent(session)) return;
      this.appendOutgoing(msg);
      this.onChatsChanged();
    } catch (err) {
      if (this._isCurrent(session)) errToast("Couldn't send message: " + (err.message || err));
    }
  }

  async _sendAttachment(kind) {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat) return;

    // Voice recording is not implemented yet — keep the old demo placeholder.
    if (kind === "voice") {
      try {
        const msg = await this._sendArchivedAware(session.chatId, { text: "", viewtype: "voice", extra: { duration: 5 + Math.floor(Math.random() * 40) } });
        if (!this._isCurrent(session)) return;
        this.appendOutgoing(msg);
        this.onChatsChanged();
      } catch (err) {
        if (this._isCurrent(session)) errToast("Couldn't send voice message: " + (err.message || err));
      }
      return;
    }

    let filters;
    if (kind === "image") {
      filters = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }];
    } else if (kind === "video") {
      filters = [{ name: "Videos", extensions: ["mp4", "mov", "mkv", "avi", "webm"] }];
    } else {
      filters = [{ name: "All files", extensions: ["*"] }];
    }

    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (!invoke) {
      errToast("File picker is only available in the Tauri app");
      return;
    }

    try {
      let picked = await invoke("plugin:dialog|open", { options: { multiple: false, filters } });
      if (!this._isCurrent(session)) return;
      if (Array.isArray(picked)) picked = picked[0];
      if (!picked) return;
      // The Android picker returns content:// URIs that neither tauri-plugin-fs
      // nor the core can read — copy the bytes into app storage via
      // ContentResolver first (resolve_content_uri in lib.rs). The resolved
      // path carries the real display name, which the type detection needs
      // (the raw content id has no extension).
      let resolved;
      if (/^content:\/\//.test(picked)) {
        resolved = await invoke("resolve_content_uri", { uri: picked, filename: String(Date.now()) });
        if (!this._isCurrent(session)) return;
        diagnosticsSink.append("info", `attachment copied to ${resolved}`);
      } else {
        resolved = await resolveAttachmentPath(picked, picked.replace(/\\/g, "/").split("/").pop());
      }
      if (!this._isCurrent(session)) return;
      const name = resolved.replace(/\\/g, "/").split("/").pop() || "attachment";

      // Images and videos go through the pending-attachment strip (caption =
      // composer text); other files send immediately as before.
      const exts = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
      if (kind === "image" || Object.keys(exts).includes(extOf(resolved))) {
        const mime = exts[extOf(resolved).toLowerCase()] || "image/png";
        const bytes = new Uint8Array(await invoke("plugin:fs|read_file", { path: resolved }));
        const blob = new Blob([bytes], { type: mime });
        if (!this._isCurrent(session)) return;
        this._setPendingMedia("image", blob, resolved, name);
        return;
      }
      if (kind === "video") {
        // Preview streams from the file URL — a 500 MB video must not enter
        // RAM just to be shown; corePath is kept so send never re-writes it.
        this._setPendingMedia("video", fileUrl(resolved), resolved, name);
        return;
      }

      const ext = extOf(name);
      let viewtype = "file";
      if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) viewtype = "video";
      else if (["mp3", "m4a", "ogg", "wav", "flac"].includes(ext)) viewtype = "audio";
      const { quoteId, quoteText, prefix } = this._takeQuote();
      const msg = await this._sendArchivedAware(session.chatId, { text: prefix, viewtype, file: resolved, filename: name, quoteId, quoteText });
      if (!this._isCurrent(session)) return;
      this.appendOutgoing(msg);
      this.onChatsChanged();
    } catch (err) {
      if (!this._isCurrent(session)) return;
      diagnosticsSink.append("error", `send ${kind} failed: ${err.message || err}`);
      errToast("Could not send file: " + (err.message || err), 4000);
      console.error(err);
    }
  }

  async _downloadMedia(msgId) {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat) return;
    try {
      await this.core.downloadFullMessage(msgId);
      if (!this._isCurrent(session)) return;
      const msg = await this.core.getMessage(msgId);
      if (!this._isCurrent(session)) return;
      this.onMsgUpdated(session.chatId, msg);
    } catch (err) {
      if (!this._isCurrent(session)) return;
      errToast("Download failed: " + (err.message || err), 4000);
      console.error(err);
    }
  }

  _openFile(path, name = null) {
    const session = this._session;
    if (!this._isCurrent(session) || !path) return;
    // HTML attachments are untrusted web content: open them in a sandboxed
    // iframe (no allow-same-origin -> opaque origin, no access to the app or
    // the network context of this page) instead of the system browser.
    if (/\.x?html?$/i.test(path)) return this._openHtmlIsolated(path, name);
    // Android: tauri-plugin-opener ships no file-open implementation on
    // mobile (its Kotlin side only handles URLs — open_path dies in
    // plugin-internal arg parsing), and the app's private storage is not
    // reachable from other apps without a FileProvider anyway. Media opens
    // in the lightbox instead; other types say so honestly.
    if (/Android/.test(navigator.userAgent)) {
      if (isMediaFilePath(path)) {
        openImageLightbox(fileUrl(path), name || "image");
        return;
      }
      errToast("Opening this file type isn't supported on Android yet");
      return;
    }
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) {
      // The core returns blob paths RELATIVE to the accounts dir; the opener
      // scope pattern ($APPLOCALDATA/accounts/**) matches absolute paths
      // only, so resolve before invoking (window.veltaAccountsDir is set at
      // boot by app.js get_accounts_dir).
      let abs = path;
      if (!/^(?:[a-zA-Z]:[\\/]|\/)/.test(path) && window.veltaAccountsDir) {
        abs = window.veltaAccountsDir.replace(/[\\/]+$/, "") + "/" + path.replace(/^[\\/]+/, "");
      }
      invoke("plugin:opener|open_path", { path: abs }).catch(err => {
        if (this._isCurrent(session)) errToast("Could not open file: " + (err.message || err) + " path=" + abs);
      });
    } else {
      errToast("File opening is only available in the Tauri app");
    }
  }

  // Isolated viewer for HTML file attachments: same overlay pattern as the
  // webxdc overlay; sandbox without allow-same-origin keeps the document in
  // an opaque origin (scripts run, but can touch nothing of ours).
  _openHtmlIsolated(path, name = null) {
    return this._openHtmlOverlay(name || "HTML preview", { url: fileUrl(path) });
  }

  // Shared overlay: content comes from a fetched url (attachments) or a raw
  // html string ("Show Full Message…"). One overlay at a time; Android BACK
  // pops the pushed history entry and tears it down (same pattern as
  // openChat/closeChat in app.js).
  _openHtmlOverlay(titleText, { url = null, html = null } = {}) {
    document.getElementById("html-view-overlay")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "html-view-overlay";
    const bar = document.createElement("div");
    bar.className = "html-view-bar";
    const title = document.createElement("span");
    title.textContent = titleText;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "icon-btn";
    closeBtn.innerHTML = CLOSE_SVG; // bold house icon — unicode ✕ renders hairline
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", () => closeViewer());
    bar.append(title, closeBtn);
    const frame = document.createElement("iframe");
    frame.className = "html-view-frame";
    frame.setAttribute("sandbox", "allow-scripts"); // no allow-same-origin
    // The iframe element's color-scheme only sets the canvas — the
    // document's own scrollbar follows ITS color-scheme, so inject it.
    const injectTheme = html => {
      const dark = document.documentElement.dataset.theme !== "light";
      const inject = `<style>html{color-scheme:${dark ? "dark" : "light"}}</style>` + `<script>${HTML_VIEW_LINK_JS}</script>`;
      const head = /<head[^>]*>/i.exec(html) || /<html[^>]*>/i.exec(html);
      return head
        ? html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length)
        : inject + html;
    };
    // Links inside the mail must leave, not navigate the sandboxed frame
    // (a plain click replaces the mail with the linked page INSIDE the
    // overlay; target=_blank is swallowed by the sandbox/wry). The frame
    // can't be touched from here (opaque origin), so the injected snippet
    // posts the URL back and the SAME routing as chat bubble links applies:
    // Android in-app browser chain, desktop system browser. The snippet's
    // exact bytes are hash-whitelisted in the CSP (script-src, all three
    // policy copies — see index.html / both tauri confs).
    const onFrameLink = (e) => {
      // V-06/#64: only THIS viewer's frame may hand us links. Without the
      // e.source check any window (webxdc app, in-app-browser iframe) could
      // post a forged veltaHtmlLink and ride the open chain.
      if (e.source !== frame.contentWindow) return;
      const href = e.data?.veltaHtmlLink;
      if (typeof href !== "string" || !/^https?:/i.test(href)) return;
      if (/Android/.test(navigator.userAgent)) openInAppBrowser(href);
      else openExternal(href);
    };
    const closeViewer = () => {
      window.removeEventListener("message", onFrameLink);
      if (history.state?.velta === "html-view") history.back();
      else wrap.remove();
    };
    // Reopening replaces the stale entry instead of stacking a second one.
    if (history.state?.velta !== "html-view") history.pushState({ velta: "html-view" }, "");
    window.addEventListener("popstate", () => {
      window.removeEventListener("message", onFrameLink);
      wrap.remove();
    }, { once: true });
    window.addEventListener("message", onFrameLink);
    if (html != null) {
      frame.srcdoc = injectTheme(html);
    } else {
      // Prefer fetch -> srcdoc: navigating a sandboxed opaque-origin frame to
      // a custom-protocol URL makes Tauri's injected init script throw
      // ("Cannot read properties of undefined (reading 'plugins')"), while
      // srcdoc documents don't. The direct navigation stays as fallback for
      // transports where fetch is blocked (no CORS on the serving origin).
      fetch(url).then(r => (r.ok ? r.text() : Promise.reject(r.status)))
        .then(text => { frame.srcdoc = injectTheme(text); })
        .catch(() => { frame.src = url; });
    }
    wrap.append(bar, frame);
    document.body.appendChild(wrap);
  }

  /* ================= scrolling ================= */

  _bindScroll() {
    this.scrollEl.addEventListener("scroll", () => {
      if (!this._isCurrent() || !this.chat) return;
      // No paging while open/jump positioning settles: a prepend under the
      // pin (e.g. the scrollTop 0 close() leaves behind) made the landing
      // non-deterministic (issue #18). The settle's end pages instead.
      if (this.scrollEl.scrollTop < 220 && !this._settling) this._loadOlder();
      // Remembered position gate: only a genuine user scroll (input within
      // the last 1.5 s, which covers touch momentum) moves off the bottom —
      // programmatic settles and seeks never fabricate an anchor.
      if (!this._settling) {
        if (this._nearBottom()) this._userAway = false;
        else if (Date.now() - this._userScrollAt < 1500) this._userAway = true;
      }
      if (this._nearBottom()) {
        if (this.hasNewer) this._loadNewer();
        else this._hideGoDown();
      } else if (this.goDownBtn.hidden) {
        this._renderGoDown(true); // away from the bottom — offer the way back
      }
      this._scheduleSeenCheck();
    }, { passive: true });
    // User scroll input for the remembered-position gate: wheel/touch over
    // the message list (bubbles from the rows), keys and scrollbar drags on
    // the scroller (pointerdown on the scroller itself, not a row tap).
    const userInput = (e) => {
      if (e.type === "pointerdown" && e.target !== this.scrollEl) return;
      this._userScrollAt = Date.now();
    };
    for (const type of ["wheel", "touchstart", "touchmove"]) this.listEl.addEventListener(type, userInput, { passive: true });
    for (const type of ["keydown", "pointerdown"]) this.scrollEl.addEventListener(type, userInput, { passive: true });
    // Go-down = catch up: jump to the newest message and mark the whole chat
    // read (a manual read marker stays where it is).
    this.goDownBtn.addEventListener("click", async () => {
      const session = this._session;
      if (!this._isCurrent(session) || !this.chat) return;
      this._hideGoDown();
      for (const it of this.items) if (it.type === "msg") it.msg.unread = false;
      this._unreadIds.clear();
      this._seenPending = [];
      await this.core.markRead(session.chatId);
      if (!this._isCurrent(session)) return;
      this._jumpToLatest();
    });
    // Messages that arrived while the app was hidden become seen only once
    // the user is back and can actually see them.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this._scheduleSeenCheck();
    });
    // Resize covers interface-scale (CSS zoom) changes: the virtual scroller
    // then re-measures and shifts its paddings for a few frames — re-pin to
    // the latest message if we were at the bottom.
    window.addEventListener("resize", () => {
      if (this._isCurrent() && this.chat && this._nearBottom()) this._scrollBottomSettling();
    });
  }

  // Swipe left on the history (#35) follows the finger with the whole chat
  // column, then leaves for the chat list. The list sits under .main and
  // is visibility:hidden while a chat is open, so .swipe-back shows it
  // for the drag. Reply-right on a bubble sets _replySwipe first and wins.
  _bindHistorySwipe() {
    const scroller = this.scrollEl;
    if (!scroller) return;
    let g = null;
    const mainOf = () => document.getElementById("main");
    const appOf = () => document.querySelector(".app");
    this._cancelHistorySwipe = () => {
      if (g) g.settled = true;
      if (this._historyDrag) this._historyDrag.settled = true;
      g = null;
      this._historyDrag = null;
      // A column already at -100% must not snap to 0 in the same turn
      // .chat-open is removed: the stylesheet's .22s slide would carry it
      // across the list. Park it on the closed side and drop the inline
      // override after that frame.
      const main = mainOf();
      const at = main?.style.transform || "";
      const park = at === "translateX(-100%)" || at === "translateX(100%)";
      if (main) {
        main.style.transition = "none";
        main.style.transform = park ? "translateX(100%)" : "";
      }
      appOf()?.classList.remove("swipe-back");
      this._backSwipe = false;
      if (!main) return;
      if (park) {
        requestAnimationFrame(() => {
          main.style.transform = "";
          requestAnimationFrame(() => { main.style.transition = ""; });
        });
      } else {
        main.style.transition = "";
      }
    };
    scroller.addEventListener("touchstart", e => {
      if (!this._mobileGestures() || this._textSelect || this._replySwipe || e.touches.length !== 1) return;
      if (e.target.closest?.("button, a, input, textarea, audio, video")) return;
      const t = e.touches[0];
      g = { x: t.clientX, y: t.clientY, dx: 0, on: false, settled: false };
    }, { passive: true });
    scroller.addEventListener("touchmove", e => {
      if (!g || g.settled || this._replySwipe || e.touches.length !== 1) {
        if (g?.on) this._cancelHistorySwipe();
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      const main = mainOf();
      if (!main) return;
      if (!g.on) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { g = null; return; }
        if (dx > -12 || Math.abs(dx) < Math.abs(dy)) return;
        g.on = true;
        this._backSwipe = true;
        this._historyDrag = g;
        main.style.transition = "none";
        appOf()?.classList.add("swipe-back");
      }
      const width = main.clientWidth || main.getBoundingClientRect?.().width || 320;
      g.dx = Math.min(0, Math.max(dx, -width));
      main.style.transform = `translateX(${g.dx}px)`;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    const end = (commit) => {
      const drag = g;
      g = null;
      this._backSwipe = false;
      if (!drag?.on || drag.settled) return;
      const main = mainOf();
      if (!main) return;
      const width = main.clientWidth || main.getBoundingClientRect?.().width || 320;
      const go = commit && drag.dx <= -Math.min(72, width * 0.28);
      main.style.transition = "transform .18s ease-out";
      main.style.transform = go ? "translateX(-100%)" : "";
      const finish = () => {
        if (drag.settled) return;
        drag.settled = true;
        if (this._historyDrag === drag) this._historyDrag = null;
        if (g?.on) return;
        const committed = go && this._isCurrent();
        if (committed) {
          // Match the closed stylesheet position before closeChat drops
          // .chat-open. close() keeps this park for one frame.
          main.style.transition = "none";
          main.style.transform = "translateX(100%)";
        } else {
          main.style.transition = "none";
          main.style.transform = "";
          main.style.transition = "";
        }
        appOf()?.classList.remove("swipe-back");
        if (committed) this.onBack?.();
        // onBack that leaves the chat open (the headless tests) still has
        // .chat-open, whose transform:none would be stuck under the park.
        if (committed && this._isCurrent()) {
          main.style.transform = "";
          main.style.transition = "";
        }
      };
      main.addEventListener?.("transitionend", finish, { once: true });
      setTimeout(finish, 240);
    };
    scroller.addEventListener("touchend", () => end(true));
    scroller.addEventListener("touchcancel", () => end(false));
  }

  _nearBottom() {
    return this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 220;
  }

  _scrollBottom(instant = false) {
    this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight, behavior: instant ? "auto" : "smooth" });
    this._hideGoDown();
  }

  // After opening a chat the scroller keeps measuring rendered items and
  // adjusting its virtual paddings for several frames, each of which can
  // shift the content under a single "jump to bottom". Keep re-asserting the
  // bottom position until the layout stops moving (or the user scrolls away).
  _scrollBottomSettling() {
    this._hideGoDown();
    // The final re-assert is instant: a smooth scroll outlives _settling
    // and the scroller's own relayout could stop it mid-way (issue #18).
    this._settleScroll(() => this.scrollEl.scrollHeight, () => this._scrollBottom(true), { atBottom: true });
  }

  // Open at a message instead of the bottom: the unread line near the top
  // of the viewport, or the read marker's line at a third of its height
  // (a bit of the already-read text stays visible above it). Until the
  // virtual scroller mounts the row, aim at its estimated position.
  _scrollToMessageSettling(msgId, { marker = false } = {}) {
    const target = () => {
      const row = this.listEl.querySelector(`[data-msgid="${msgId}"]`);
      if (!row) {
        const idx = this.items.findIndex(it => it.msg?.id === msgId);
        if (idx < 0) return null;
        return Math.max(0, (idx / this.items.length) * this.scrollEl.scrollHeight - this.scrollEl.clientHeight / 2);
      }
      const el = row.querySelector(marker ? ".read-marker" : ".unread-sep") || row;
      const top = el.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top + this.scrollEl.scrollTop;
      return Math.max(0, Math.round(top - (marker ? this.scrollEl.clientHeight / 3 : 8)));
    };
    this._settleScroll(target, () => { const top = target(); if (top != null) this.scrollEl.scrollTop = top; });
  }

  // Remembered position (issue #18): put the saved anchor row back at its
  // saved viewport offset. Relative correction from the row's live offset,
  // so it converges while the scroller still shifts its paddings.
  _restoreScrollSettling({ anchorId, dy }) {
    const target = () => {
      const row = this.listEl.querySelector(`[data-msgid="${anchorId}"]`);
      if (!row) {
        const idx = this.items.findIndex(it => it.msg?.id === anchorId);
        if (idx < 0) return null;
        return Math.max(0, Math.round((idx / this.items.length) * this.scrollEl.scrollHeight - dy));
      }
      const off = row.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top;
      return Math.max(0, Math.round(this.scrollEl.scrollTop + (off - dy) / cssZoom()));
    };
    this._settleScroll(target, () => { const top = target(); if (top != null) this.scrollEl.scrollTop = top; });
    this._restoring = true; // cleared by the next settle (go-down, jumps)
  }

  // close(): remember where the user left a fully read chat they scrolled
  // up in; anything else forgets the chat's anchor. A restore that is still
  // settling keeps the saved anchor (the user never moved).
  _saveScrollAnchor(key) {
    if (!rememberScrollOn() || !this._tracked) { this._scrollAnchors.delete(key); return; }
    if (this._settling && this._restoring) return;
    const fullyRead = !this._unreadIds.size && !this._newWhileAway && (!this.hasNewer || !this._openedWithUnread);
    const anchor = this._userAway && fullyRead && !this._nearBottom() ? this._topVisibleAnchor() : null;
    if (anchor) this._scrollAnchors.set(key, anchor);
    else this._scrollAnchors.delete(key);
  }

  // Topmost message row still visible under the viewport top, with its
  // offset from that top (≤ 0 when partly scrolled out), in rect px.
  _topVisibleAnchor() {
    const view = this.scrollEl.getBoundingClientRect();
    if (!view.height) return null;
    for (const row of this.listEl.children) {
      const id = row.dataset?.msgid;
      if (!id) continue;
      const r = row.getBoundingClientRect();
      if (!r.height || r.bottom <= view.top + 1) continue;
      return r.top < view.bottom ? { anchorId: Number(id), dy: Math.round(r.top - view.top) } : null;
    }
    return null;
  }

  // After opening a chat the scroller keeps measuring rendered items and
  // adjusting its virtual paddings for several frames, each of which can
  // shift the content under a single jump. Keep re-asserting the target
  // position until the layout stops moving (or the user scrolls away).
  // Read tracking waits for the final position (_settling): rows that only
  // flash by while the layout settles are not seen.
  _settleScroll(computeTop, reassert, { atBottom = false } = {}) {
    this._stopSettling?.();
    this._restoring = false;
    const session = this._session;
    const token = this._settleToken = (this._settleToken || 0) + 1;
    this._settling = true;
    let lastTop = -1, stableFrames = 0, frames = 0, stopped = false, userScrolled = false;
    const onUserScroll = () => { userScrolled = true; stop(); };
    this.scrollEl.addEventListener("wheel", onUserScroll, { passive: true });
    this.scrollEl.addEventListener("touchstart", onUserScroll, { passive: true });
    const stop = () => {
      stopped = true;
      clearInterval(this._pinTimer);
      if (this._stopSettling === stop) this._stopSettling = null;
      // The virtual scroller re-lays out on its own ~100ms "scrolling stopped"
      // timer and shifts the paddings after we stop pinning — re-assert the
      // position once more after that settles (unless the user took over).
      setTimeout(() => {
        this.scrollEl.removeEventListener("wheel", onUserScroll);
        this.scrollEl.removeEventListener("touchstart", onUserScroll);
        // A newer settle (or another chat) owns the position now.
        if (token !== this._settleToken || !this._isCurrent(session) || !this.chat) return;
        if (!userScrolled) reassert();
        this._settling = false;
        if (this.scrollEl.scrollTop < 220) this._loadOlder(); // paging held off while settling
        if (this._nearBottom() && !this.hasNewer) this._hideGoDown();
        this._scheduleSeenCheck();
      }, userScrolled ? 0 : 450);
    };
    this._stopSettling = stop;
    const tick = () => {
      if (stopped || !this._isCurrent(session) || !this.chat) { stop(); return; }
      // A null target (row not rendered yet — the scroller renders
      // asynchronously) holds the position without counting stability.
      const top = computeTop();
      if (top != null) {
        this.scrollEl.scrollTop = top;
        if (atBottom) this._hideGoDown();
        const cur = this.scrollEl.scrollTop;
        if (cur === lastTop) stableFrames++; else { stableFrames = 0; lastTop = cur; }
      }
      frames++;
      if (stableFrames >= 4 || frames >= 90) { stop(); return; }
    };
    // Timer-driven, not rAF: rAF never fires in occluded/hidden windows
    // (headless checks, app starting in the background) — the pin must work
    // exactly then, because the scroller lays out asynchronously in all cases.
    this._pinTimer = setInterval(tick, 40);
    this._pinTimer?.unref?.();
  }

  _bumpGoDown(chatId, background = false) {
    if (background) return;
    this._newWhileAway++;
    this._renderGoDown(true);
  }

  // The go-down badge counts unread messages below the viewport: seeded
  // with the chat's unread count when it opens mid-history, bumped by
  // arrivals, drained as _checkSeen marks rows seen.
  _renderGoDown(show = !this.goDownBtn.hidden) {
    this.goDownBadge.textContent = this._newWhileAway > 999 ? "999+" : String(this._newWhileAway);
    this.goDownBadge.hidden = this._newWhileAway <= 0;
    this.goDownBtn.hidden = !show;
  }

  _hideGoDown() {
    this._newWhileAway = 0;
    this.goDownBadge.hidden = true;
    this.goDownBtn.hidden = true;
  }

  /* ================= read tracking ================= */

  // Messages count as seen only once they were on screen. Seen is a
  // watermark (like most messengers): the lowest row the user has seen
  // marks every loaded unread message up to it, so skimming past a burst
  // reads it while everything below the viewport stays unread — switching
  // chats mid-way keeps the rest of the badge.
  _scheduleSeenCheck() {
    if (this._seenFrame || !this._unreadIds.size) return;
    this._seenFrame = requestAnimationFrame(() => {
      this._seenFrame = 0;
      this._checkSeen();
    });
  }

  _checkSeen() {
    if (!this._isCurrent() || !this.chat || !this._tracked || this._settling || document.hidden) return;
    if (!this._unreadIds.size) return;
    const view = this.scrollEl.getBoundingClientRect();
    if (!view.height) return;
    // Bottom-up over the mounted rows: the first one that counts as seen
    // is the watermark (fully on screen, or a tall row that already fills
    // half the viewport).
    let lastSeen = null;
    const rows = this.listEl.children;
    for (let i = rows.length - 1; i >= 0; i--) {
      const id = rows[i].dataset?.msgid;
      if (!id) continue;
      const r = rows[i].getBoundingClientRect();
      if (!r.height || r.top >= view.bottom) continue;
      if (r.bottom <= view.top) break;
      if (r.bottom <= view.bottom + 2 || r.top <= view.top + view.height / 2) { lastSeen = Number(id); break; }
    }
    if (lastSeen == null) return;
    const upTo = this.items.indexOf(this.msgIndex.get(lastSeen));
    this._markSeenThrough(upTo);
  }

  _markSeenThrough(index) {
    const ids = [];
    for (let i = 0; i <= index && i < this.items.length; i++) {
      const m = this.items[i].msg;
      if (m?.unread) {
        m.unread = false;
        this._unreadIds.delete(m.id);
        ids.push(m.id);
      }
    }
    if (!ids.length) return;
    this._newWhileAway = Math.max(0, this._newWhileAway - ids.length);
    this._renderGoDown();
    this._seenPending.push(...ids);
    if (!this._seenTimer) this._seenTimer = setTimeout(() => this._flushSeen(), this.seenFlushMs);
  }

  _flushSeen() {
    clearTimeout(this._seenTimer);
    this._seenTimer = null;
    const ids = this._seenPending;
    this._seenPending = [];
    const session = this._session;
    if (!ids.length || !this._isCurrent(session)) return;
    this.core.markSeen(session.chatId, ids).catch?.(() => {});
  }

  _clearReadMarker() {
    const session = this._session;
    if (!this._isCurrent(session)) return;
    const prev = this.readMarkerId;
    clearReadMarker(session.accountId, session.chatId);
    this.readMarkerId = null;
    if (prev != null) this._refreshRowFlags(prev);
  }

  // Re-render one row after its in-row markers changed.
  _refreshRowFlags(msgId) {
    const item = this.msgIndex.get(msgId);
    if (!item) return;
    item.readMarker = msgId === this.readMarkerId;
    const row = this.listEl.querySelector(`[data-msgid="${msgId}"]`);
    if (!row) { this._rowCache.delete(item.key); return; }
    const fresh = this._buildItem(item);
    row.replaceWith(fresh);
    this._rowCache.set(item.key, fresh);
    this._rowSigCache.set(item.key, this._rowSignature(item.msg));
    this.vs?.onItemHeightDidChange?.(item);
  }

  // Page downwards through a window that stops short of the tail.
  async _loadNewer() {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat || this.loadingNewer || !this.hasNewer || !this.items.length) return;
    this.loadingNewer = true;
    const last = this.items[this.items.length - 1];
    this._loadBar(true);
    try {
      const { messages, hasNewer = false } = await this.core.getMessages(session.chatId, { afterId: last.msg.id, limit: 40 });
      if (!this._isCurrent(session)) return;
      const newMsgs = messages.filter(m => !this.msgIndex.has(m.id));
      if (!newMsgs.length) {
        // The last loaded message vanished from the chat — resync from the tail.
        if (!hasNewer) { this.hasNewer = false; this._jumpToLatest(); }
        return;
      }
      this.hasNewer = !!hasNewer;
      this._insertItems(this._annotateMessages(newMsgs, last.dayKey));
      this.vs?.setItems(this.items);
    } catch (err) {
      if (this._isCurrent(session)) toast("Couldn't load newer messages: " + (err.message || err));
    } finally {
      this._loadBar(false);
      if (this._isCurrent(session)) this.loadingNewer = false;
    }
  }

  // Scroll to the newest message; when the loaded window stops short of
  // it, replace the window with the tail page first.
  async _jumpToLatest() {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat) return;
    if (!this.hasNewer) { this._scrollBottomSettling(); return; }
    this._loadBar(true);
    try {
      if (await this._reloadTail(session)) this._scrollBottomSettling();
    } catch (err) {
      if (this._isCurrent(session)) toast("Couldn't load the latest messages: " + (err.message || err));
    } finally {
      this._loadBar(false);
    }
  }

  // Replace a window that stops short of the tail with the newest page.
  // Resolves false when the session went stale meanwhile.
  async _reloadTail(session) {
    const { messages, hasMore } = await this.core.getMessages(session.chatId, { limit: 40 });
    if (!this._isCurrent(session)) return false;
    this.hasMore = hasMore;
    this.hasNewer = false;
    this._stopSettling?.();
    this._leaveTextSelection();
    this.vs?.stop();
    this.vs = null;
    this.listEl.replaceChildren();
    this.listEl.style.paddingTop = "";
    this.listEl.style.paddingBottom = "";
    this._rebuildItems(messages);
    this._createScroller();
    return true;
  }

  // Saved-message copy → the message it was saved from (#19). Same chat
  // jumps in place. Another chat opens first; open() replaces the session,
  // so the epoch is what still proves this account.
  async _showOriginal(m) {
    const epoch = this._session?.accountEpoch;
    const id = Number(m.originalMsgId);
    if (!id) return;
    let orig = null;
    try { orig = await this.core.getMessage(id); } catch { orig = null; }
    if (this.core.accountEpoch !== epoch || !this._isCurrent()) return;
    if (!orig?.chatId) {
      toast("The original message is no longer available");
      return;
    }
    if (Number(orig.chatId) === Number(this.chat?.id)) {
      this._jumpToMessage(orig.id);
      return;
    }
    await this.onOpenChat?.(orig.chatId);
    if (this.core.accountEpoch !== epoch) return;
    if (Number(this.chat?.id) !== Number(orig.chatId)) return;
    this._jumpToMessage(orig.id);
  }

  _jumpToMessage(msgId) {
    const row = this.listEl.querySelector(`[data-msgid="${msgId}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      this._flashRow(row);
      return;
    }
    // Not in the rendered window (search hits, quote jumps, pinned bar):
    // fetch older pages until the message is part of the loaded items, then
    // seek to it. The virtual scroller can't scroll to history that isn't
    // loaded, so fetching IS the jump. The promise is returned so tests
    // (and anyone else) can await completion.
    return this._jumpFetchAndScroll(msgId);
  }

  async _jumpFetchAndScroll(msgId) {
    const session = this._session;
    if (!this._isCurrent(session) || !this.chat || this._jumpInFlight) return;
    this._jumpInFlight = true;
    this._loadBar(true);
    try {
      // A window opened mid-history (read tracking) may end above the
      // target: restart from the tail, then walk older pages as usual.
      if (this.hasNewer && !this._hasItem(msgId) && !await this._reloadTail(session)) return;
      for (let page = 0; page < this.jumpMaxPages && !this._hasItem(msgId); page++) {
        if (!this.hasMore) {
          if (this._isCurrent(session)) toast("Message is no longer in this chat's history");
          return;
        }
        const firstMsg = this.items.find(i => i.type === "msg");
        const { messages, hasMore } = await this.core.getMessages(session.chatId, { beforeId: firstMsg?.msg.id ?? null, limit: 40 });
        if (!this._isCurrent(session)) return;
        this.hasMore = hasMore;
        if (!messages.length) break;
        this._prependHistory(messages);
      }
      if (!this._hasItem(msgId)) {
        if (this._isCurrent(session)) toast("Message is higher up in history — scroll up to load it");
        return;
      }
      await this._scrollToItemSeek(msgId, session);
    } catch (err) {
      if (this._isCurrent(session)) errToast("Couldn't load history: " + (err?.message || err));
    } finally {
      this._jumpInFlight = false;
      if (this._isCurrent(session)) this._loadBar(false);
    }
  }

  _hasItem(msgId) {
    return this.items.some(i => i.type === "msg" && i.msg.id === msgId);
  }

  // Bring an item that exists in `this.items` but has no mounted DOM row into
  // view: the scroller only renders rows around the current scroll offset, so
  // seek by index distance × average measured row height, re-measuring each
  // pass — the mounted window moves toward the target geometrically. Zoom
  // (CSS zoom on <html>) scales getBoundingClientRect but not scrollTop, so
  // distances are divided out (same coordinate split as the vendor patch).
  async _scrollToItemSeek(msgId, session) {
    const zoom = () => {
      const z = parseFloat(getComputedStyle(document.documentElement).zoom);
      return z > 0 ? z : 1;
    };
    for (let attempt = 0; attempt < this.jumpSeekAttempts; attempt++) {
      if (!this._isCurrent(session)) return;
      const row = this.listEl.querySelector(`[data-msgid="${msgId}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        this._flashRow(row);
        return;
      }
      const mounted = [...this.listEl.querySelectorAll("[data-msgid]")];
      const targetIdx = this.items.findIndex(it => it.type === "msg" && it.msg.id === msgId);
      if (targetIdx === -1) return;
      let delta = -this.scrollEl.clientHeight * 2;
      if (mounted.length) {
        const firstId = Number(mounted[0].dataset.msgid);
        const firstIdx = this.items.findIndex(it => it.type === "msg" && it.msg.id === firstId);
        if (firstIdx !== -1 && mounted.length >= 2) {
          const rectTop = mounted[0].getBoundingClientRect().top;
          const rectBottom = mounted[mounted.length - 1].getBoundingClientRect().top;
          const avg = Math.max(24, (rectBottom - rectTop) / (mounted.length - 1)) / zoom();
          delta = Math.round((targetIdx - firstIdx) * avg);
        }
      }
      this.scrollEl.scrollTop += delta;
      await new Promise(r => setTimeout(r, this.jumpSeekDelayMs));
    }
  }

  _flashRow(row) {
    if (!row) return;
    row.style.transition = "background .3s";
    row.style.background = "rgba(90,162,230,.25)";
    setTimeout(() => row.style.background = "", 900);
  }

  _bindCoreEvents() {
    this.core.addEventListener("msg-state", e => this.onMsgState(e.detail.chatId, e.detail.msgId, e.detail.state));
    this.core.addEventListener("msg-updated", e => this.onMsgUpdated(e.detail.chatId, e.detail.msg));
    this.core.addEventListener("msgs-deleted", e => this.onMsgsDeleted(e.detail.chatId, e.detail.ids));
    this.core.addEventListener("incoming-msg", e => this.onIncoming(e.detail.chatId, e.detail.msg));
    // fresh only for an unknown scope (chatId 0): a known chat's event hits
    // an id cache the core layer already invalidated, so forcing fresh would
    // just re-download every id of the chat (#43).
    this.core.addEventListener("msgs-changed", e => this.onMsgsChanged(e.detail.chatId, { fresh: !e.detail.chatId }));
    this.core.addEventListener("msg-sent", e => { /* handled via sendMessage return */ });
    this.core.addEventListener("pinned-changed", e => {
      if (e.detail.chatId === this._session?.chatId) this._refreshPinnedBar();
    });
    // #69: a deleted pin never fires pinned-changed — the core's tombstone
    // REPLACE silently wipes the pinned column (no MessageUnpinned event),
    // so the tray kept showing the deleted message. Any change to the open
    // chat (msgs-changed), a deletion (msgs-deleted, local or remote/ephemeral
    // via rpc-core's MsgDeleted mapping) or a global sweep re-checks the
    // pins; debounced to one refresh per 400 ms burst.
    this._pinRefreshTimer = null;
    const queuePinRefresh = () => {
      clearTimeout(this._pinRefreshTimer);
      this._pinRefreshTimer = setTimeout(() => this._refreshPinnedBar(), 400);
    };
    this.core.addEventListener("msgs-changed", e => {
      if (e.detail.chatId && e.detail.chatId !== this._session?.chatId) return;
      queuePinRefresh();
    });
    this.core.addEventListener("msgs-deleted", e => {
      if (e.detail.chatId === this._session?.chatId) queuePinRefresh();
    });
  }
}

// Inline text rendering (URLs, invite cards, markdown) lives in markdown.js.
