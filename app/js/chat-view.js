// chat-view.js — virtualized message history (virtual-scroller) + composer
import { formatTime, formatDay, formatBytes } from "./mock-core.js";
import { escapeHtml, escapeAttr, ticksSvg } from "./components.js";
import { showContextMenu, showModal, showStickerPicker, closeAllPopups, confirmDeleteMessagesModal, toast, openImageLightbox, CLOSE_SVG } from "./ui.js";
import { diagnosticRow } from "./diagnostics.js";
import { openWebxdc, prefetchInfo, appIconUrl } from "./webxdc-manager.js";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🎉", "👏"];

// app.js installs the avatar-profile opener (avoids a circular import);
// invoked when a group message's sender avatar is tapped.
let avatarProfileOpener = null;
export function setAvatarProfileOpener(fn) { avatarProfileOpener = fn; }

import { diagnosticsSink, debugLog } from "./diagnostics.js";
import { fileUrl, mediaFallbackUrl } from "./media.js";
import { openInAppBrowser } from "./inapp-browser.js";
import { renderMarkdown, extractBotCommands } from "./markdown.js";
import { lcRetryTransfer } from "./local-chat.js";
import { linkPreview, linkPreviewCardHtml, firstLink as firstLinkOf } from "./link-preview.js";

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
  toast(text, ms);
}

// Desktop: open a URL in the SYSTEM browser. wry swallows window.open /
// target=_blank new-window requests, so this rides the opener plugin — the
// same verified path as the update banner (plugin:opener|open_url,
// opener:default capability). Bare window.open is the non-Tauri fallback.
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

// On Android the file picker can return a content URI / temporary path that the
// Delta Chat core cannot read directly. Copy the file into our app-local data
// directory and return an absolute filesystem path the core can copy into blobs.
async function resolveAttachmentPath(originalPath, filename) {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (!invoke) return originalPath;

  // Desktop usually returns an absolute path already — pass it through.
  const normalized = originalPath.replace(/\\/g, "/");
  if (/^([a-zA-Z]:|\/data\/|\/storage\/)/.test(normalized)) return originalPath;

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

export class ChatView {
  constructor(core, { onChatsChanged, onForward, onOpenChat }) {
    this.core = core;
    this.onChatsChanged = onChatsChanged;
    this.onForward = onForward;
    this.onOpenChat = onOpenChat;
    this.chat = null;
    this._readOnly = false; // read-only chat: reply affordances hide (see readOnly)
    this.items = [];        // flattened items for the virtual scroller
    this.msgIndex = new Map();
    this._rowCache = new Map();  // item.key → rendered element (reused across setItems)
    this._rowSigCache = new Map();  // item.key → render signature of the cached row
    this.hasMore = false;
    this.loadingMore = false;
    this.selection = new Set();
    this.replyTo = null;
    this.replyFragment = null;
    this.editingMsg = null;
    this._session = null;
    this._drafts = new Map();
    // onMsgsChanged refetch coalescing window (tests shrink it).
    this.tailRefetchGapMs = 2000;
    this._tailRefetchAt = 0;
    this._tailRefetchTimer = null;
    this._pendingTailRefetch = null;

    this.scrollEl = document.getElementById("history-scroll");
    this.listEl = document.getElementById("history");
    this.goDownBtn = document.getElementById("btn-go-down");
    this.goDownBadge = document.getElementById("go-down-badge");
    this._newWhileAway = 0;

    this._bindComposer();
    this._bindSelectionQuote();
    this._bindScroll();
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

  async open(chatId) {
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
      draftKey: JSON.stringify([String(this.core.accountId), String(chatId)]),
      chatId,
      reload: 0,
    };
    this._loadBar(true);
    try {
      const chat = await this.core.getChat(chatId);
      if (!this._isCurrent(session)) return false;
      const { messages, hasMore } = await this.core.getMessages(chatId, { limit: 40 });
      if (!this._isCurrent(session)) return false;
      this.chat = chat;
      this.hasMore = hasMore;
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
      await this.core.markRead(chatId);
      if (!this._isCurrent(session)) return false;
      this._scrollBottomSettling();
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

  // Pinned-message strip between the chat head and the history (core 2.59+
  // pinned-messages API; group and private chats). Shows the most recent
  // pinned message. 🐴 The core returns the whole pinned list per chat but
  // the strip shows only the newest one — a multi-pin carousel is the
  // upgrade path if multiple pins per chat are wanted.
  _ensurePinnedBar() {
    if (this.pinnedBar?.isConnected) return this.pinnedBar;
    const bar = this.pinnedBar = document.createElement("button");
    bar.id = "pinned-bar";
    bar.className = "pinned-bar";
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
    const id = ids[ids.length - 1];
    const m = await this.core.getMessage(id).catch(() => null);
    if (!this._isCurrent(session)) return;
    const snippet = (m?.text || "").slice(0, 60) || (m?.viewtype && m.viewtype !== "text" ? m.viewtype : "message");
    bar.innerHTML = `${ICO.pin}<span class="pb-text"><b>${escapeHtml(m?.fromContact?.name || "")}</b> ${escapeHtml(snippet)}</span>`;
    bar.hidden = false;
    bar.onclick = () => { if (this._isCurrent(session)) this._jumpToMessage(id); };
  }

  // Full teardown: stop polling, dispose the virtual scroller, drop cached
  // rows and leave #history empty. Used when another surface takes over the
  // history area (Diagnostics chat) and when the chat is closed.
  close() {
    const input = document.getElementById("composer-input");
    // Use the session's owner, not core.accountId: account-changing may have
    // already advanced the core epoch before the app calls close().
    if (this.chat && this._session) {
      if (input.value || this.replyTo) this._drafts.set(this._session.draftKey, { text: input.value, replyTo: this.replyTo, replyFragment: this.replyFragment });
      else this._drafts.delete(this._session.draftKey);
    }
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
    this._unreadPlaced = false;
    this._unreadFirstDone = false;
    this._hideGoDown();
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
    this._insertItems(this._annotateMessages([msg], this.items[this.items.length - 1]?.dayKey ?? null));
    this.vs?.setItems(this.items);
    if (this._nearBottom()) requestAnimationFrame(() => { if (this._isCurrent(session)) this._scrollBottom(); });
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
    this._insertItems(this._annotateMessages([msg], this.items[this.items.length - 1]?.dayKey ?? null));
    this.vs?.setItems(this.items);
    if (this._nearBottom()) {
      requestAnimationFrame(() => { if (this._isCurrent(session)) this._scrollBottom(); });
      this.core.markRead(chatId);
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
      requestAnimationFrame(() => { if (this._isCurrent(session)) this._scrollBottom(); });
      this.core.markRead(this.chat.id);
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
    this._syncResend(row, msgId, state);
  }

  // Failed outgoing rows carry a bottom-left resend button; row rebuilds get
  // it from the template, live state transitions get it from here.
  _syncResend(row, msgId, state) {
    if (!row) return;
    const btn = row.querySelector(".msg-resend");
    if (state === "failed" && !btn) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "msg-resend";
      el.title = "Resend";
      el.setAttribute("aria-label", "Resend message");
      el.innerHTML = ICO.resend;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const m = this.msgIndex.get(msgId)?.msg;
        if (m) this._resendMessage(m);
      });
      row.querySelector(".msg-meta")?.before(el);
    } else if (state !== "failed" && btn) {
      btn.remove();
    }
  }

  // Retry a failed outgoing message: the core flips it back to OutPending,
  // re-queues it, and the usual MsgDelivered/MsgFailed events take over.
  async _resendMessage(m) {
    try {
      await this.core.resendMessage(m.id);
      this.onMsgState(m.chatId, m.id, "pending");
    } catch (err) {
      errToast(`Resend failed: ${err?.message || err}`);
      diagnosticsSink.append("error", `resend ${m.id}: ${err?.message || err}`);
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
      m.reactions, m.filePath, m.fileName, m.duration, m.fwdFrom, m.quote,
    ]);
  }

  // Report which render-relevant fields flip-flopped between polls — this is
  // how we catch data that alternates between fetches and loops re-renders.
  _logSignatureDiff(key, a, b) {
    try {
      const fa = JSON.parse(a), fb = JSON.parse(b);
      const names = ["viewtype","downloadState","text","state","edited","starred","reactions","filePath","fileName","duration","fwdFrom","quote"];
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
    if (item.msg && prevSig !== undefined) {
      this._logSignatureDiff(item.key, prevSig, sig);
    }
    item.msg = msg;
    const row = this.listEl.querySelector(`[data-msgid="${msg.id}"]`);
    if (row) {
      this.vs?.onItemHeightDidChange?.(item);
      const fresh = this._renderMsgItem(item);
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
      this._rowCache.delete("m" + id);
      this._rowSigCache.delete("m" + id);
    }
    this.vs?.setItems(this.items);
  }

  /* ================= items & day chips ================= */

  _rebuildItems(messages) {
    this.items = [];
    this.msgIndex.clear();
    this._insertItems(this._annotateMessages(messages), true);
  }

  // Day chips ride INSIDE the first message row of each day (dayFirst flag)
  // instead of being separate list items: the virtual scroller's diff needs
  // the entire previous items array to appear contiguously after a prepend,
  // and separator items broke that on every day-crossing batch (key
  // collisions with existing separators, seam removals) — the failed diff
  // forced a full relayout with estimated heights and no scroll restoration,
  // i.e. the scroll jumps when paging up through long histories.
  _annotateMessages(messages, prevDayKey = null) {
    const out = [];
    let lastDay = prevDayKey;
    let firstUnreadPlaced = this._unreadPlaced;
    for (const m of messages) {
      const dayKey = new Date(m.ts).toDateString();
      if (!firstUnreadPlaced && this.chat?.unread > 0 && m.from !== 1 && this._isFirstUnread(m)) {
        out.push({ type: "unread", key: "unread-sep", dayKey });
        firstUnreadPlaced = true;
      }
      const item = { type: "msg", key: "m" + m.id, msg: m, dayKey, dayFirst: dayKey !== lastDay };
      this.msgIndex.set(m.id, item);
      out.push(item);
      lastDay = dayKey;
    }
    if (firstUnreadPlaced) this._unreadPlaced = true;
    return out;
  }

  _isFirstUnread() {
    if (this._unreadFirstDone) return false;
    this._unreadFirstDone = true;
    return true;
  }

  _insertItems(newItems, reset = false) {
    if (reset) this._unreadPlaced = false;
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
      if (messages.length) {
        // Pure message prefix: prepends must never touch existing items or the
        // scroller's diff (which needs the whole previous array contiguous)
        // fails and forces a relayout-without-scroll-restore (= jump).
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
      }
    } catch (err) {
      if (this._isCurrent(session)) errToast("Couldn't load older messages: " + (err.message || err));
    } finally {
      this._loadBar(false); // unconditional: an early session-invalid return must not leave the bar on
      if (this._isCurrent(session)) this.loadingMore = false;
    }
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
    if (cached) {
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

  _buildItem(item) {
    switch (item.type) {
      case "unread": {
        const el = document.createElement("div");
        el.className = "unread-sep";
        el.textContent = "Unread messages";
        return el;
      }
      default:
        return this._renderMsgItem(item);
    }
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
      if (!item.dayFirst) return row;
      const wrap = document.createElement("div");
      wrap.className = "msg-row day-first";
      wrap.append(this._dayChipEl(item), row);
      return wrap;
    }
    const out = m.from === 1;
    const showAvatar = !out && (this.chat.kind === "group");
    // Event-driven inserts (onIncoming) can carry rows before decoration —
    // never let a missing fromContact kill the whole render pass.
    const fc = m.fromContact || { id: m.from, name: "Unknown", color: "#888" };
    const row = document.createElement("div");
    row.className = "msg-row" + (out ? " out" : "") + (showAvatar ? " with-avatar" : "");
    row.dataset.msgid = m.id;
    if (this.selection.size) row.classList.add("selectable");
    if (this.selection.has(m.id)) row.classList.add("selected");

    let inner = "";
    // Day chip rides inside the first row of the day (see _annotateMessages).
    if (item.dayFirst) inner += `<div class="day-chip">${escapeHtml(formatDay(m.ts))}</div>`;
    if (this.selection.size) {
      inner += `<div class="msg-checkbox">${this.selection.has(m.id) ? ICO.check : ""}</div>`;
    }
    if (showAvatar) {
      inner += `<velta-avatar name="${escapeHtml(fc.name)}" color="${fc.color}" size="42" contact-id="${fc.id ?? ""}" addr="${escapeAttr(fc.addr || "")}"${fc.avatar ? ` avatar="${escapeAttr(fileUrl(fc.avatar))}"` : ""}></velta-avatar>`;
    }

    let bubble = "";
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
        // Stickers stay compact (official-client scale) instead of the
        // 45vh/450px photo cap.
        const cap = m.viewtype === "sticker" ? "240px" : "45vh, 450px";
        const box = dw && dh
          ? ` style="height:min(${dh}px, ${cap}); aspect-ratio:${dw} / ${dh}; max-width:100%"`
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
        bubble += `<div class="msg-video"><velta-video src="${escapeAttr(fileUrl(m.filePath))}" file="${escapeAttr(m.filePath)}" size="${escapeAttr(size)}" duration="${m.duration || ""}" name="${escapeHtml(m.fileName || "Video")}"></velta-video></div>`;
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
    } else bubble += `<div class="msg-text">`;
    const edited = m.edited ? `<span class="edited">edited</span>` : "";
    const star = m.starred ? `<svg class="star-ico" viewBox="0 0 24 24"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2 1.3-6.2L3 9.5l6.3-.7z" fill="currentColor"/></svg>` : "";
    const ticks = out ? `<span class="ticks-slot">${ticksSvg(m.state, "ticks")}</span>` : "";
    // Failed sends keep the meta clean (no ticks) and get a resend button
    // at the bubble's bottom-left instead. No whitespace before the button:
    // msg-text is pre-wrap.
    const resend = out && m.state === "failed" ? `<button type="button" class="msg-resend" data-act="resend" title="Resend" aria-label="Resend message">${ICO.resend}</button>` : "";
    bubble += `<span class="msg-meta">${edited}${star}${formatTime(m.ts)}${ticks}</span>${resend}</div>`;
    if (m.reactions?.length) {
      bubble += `<div class="msg-reactions">${m.reactions.map(r =>
        `<span class="reaction-chip${r.mine ? " mine" : ""}" data-react="${escapeAttr(r.emoji)}">${escapeHtml(r.emoji)} ${Number(r.count) || 0}</span>`).join("")}</div>`;
    }
    inner += `<div class="bubble${m.viewtype === "sticker" ? " sticker" : ""}">${bubble}</div>`;
    row.innerHTML = inner;
    if (m.viewtype === "vcard" && m.filePath) this._hydrateVcardCard(row, m);
    if (showAvatar) {
      row.querySelector("velta-avatar")?.addEventListener("click", (e) => {
        // The sender's avatar opens their profile — not row selection/menus.
        e.stopPropagation();
        if (!alive()) return;
        avatarProfileOpener?.({ contactId: fc.id, name: fc.name, contact: { addr: fc.addr }, online: fc.online, lastSeen: fc.lastSeen, color: fc.color });
      });
    }

    // One-click reply (desktop hover): a small pill at the bubble's top-right
    // corner — the same _setReply the context menu uses, plus composer focus
    // so the reply really is a single click. Read-only chats (no composer)
    // get no pill; the body class also hides any already-mounted ones.
    if (!this.readOnly) {
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
      row.querySelector(".bubble")?.appendChild(hoverReply);
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
          wrap.style.width = `min(${mediaImg.naturalWidth}px, 100%, calc(min(450px, 45vh) * ${r.toFixed(4)}))`;
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
      mediaImg.src = fileUrl(m.filePath);
      mediaImg.addEventListener("click", e => {
        e.stopPropagation();
        if (!alive()) return;
        if (mediaImg.naturalWidth) openImageLightbox(mediaImg.src, m.fileName || "photo");
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
      this._msgContextMenu(it, e.clientX, e.clientY);
    });
    let pressTimer;
    row.addEventListener("touchstart", e => {
      // A second finger (pinch / two-finger swipe) never means long-press,
      // and the WebView can abort the whole gesture with touchcancel once
      // it claims it — without this listener the timer would survive.
      if (e.touches.length > 1) { clearTimeout(pressTimer); return; }
      pressTimer = setTimeout(() => { const it = liveItem(); if (it) this._msgContextMenu(it, innerWidth / 2, innerHeight / 2); }, 500);
    }, { passive: true });
    row.addEventListener("touchend", () => clearTimeout(pressTimer));
    row.addEventListener("touchmove", () => clearTimeout(pressTimer));
    row.addEventListener("touchcancel", () => clearTimeout(pressTimer));
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
        if (mediaAction.dataset.act === "download") this._downloadMedia(m.id);
        else if (mediaAction.dataset.act === "open") this._openFile(m.filePath, m.fileName);
        else if (mediaAction.dataset.act === "resend") this._resendMessage(m);
        else if (mediaAction.dataset.act === "lc-retry") this._lcRetryTransfer(m);
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
    if (m.viewtype === "text" && m.text) items.push({ label: "Copy text", icon: ICO.copy, onClick: () => { navigator.clipboard?.writeText(m.text); toast("Copied"); } });
    items.push(
      { label: "Forward", icon: ICO.forward, onClick: () => this._forward([m.id]) },
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
    const stateNames = { pending: "Sending…", sent: "Sent", delivered: "Delivered", read: "Read", received: "Received", failed: "Failed" };
    showModal({
      title: "Message info",
      body: `
      <div class="enc-note">${ICO.lock}<span>This message is end-to-end encrypted with OpenPGP. Only you and the recipient can read it — the chatmail relay cannot.</span></div>
      <div class="info-row"><span class="k">Type</span><span class="v">${m.viewtype}</span></div>
      <div class="info-row"><span class="k">From</span><span class="v">${escapeHtml(m.fromContact.name)}</span></div>
      <div class="info-row"><span class="k">Sent</span><span class="v">${new Date(m.ts).toLocaleString()}</span></div>
      <div class="info-row"><span class="k">State</span><span class="v">${stateNames[m.state] || m.state}</span></div>
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
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    input.addEventListener("paste", e => {
      const session = this._session;
      if (!this._isCurrent(session) || !this.chat) return;
      const items = [...(e.clipboardData?.items || [])];
      let file = items.find(i => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
      if (!file) file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
      if (!file) return; // fall through to normal text paste
      e.preventDefault();
      this._imageSendFlow(file, session);
    });
    send.addEventListener("click", () => this._send());
    document.getElementById("btn-sticker").addEventListener("click", () => this._toggleStickerPicker());
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
        this.core.sendMessage(session.chatId, { text: "", viewtype: "sticker", file: path })
          .then((msg) => { if (this._isCurrent(session)) { this.appendOutgoing(msg); this.onChatsChanged(); } })
          .catch((err) => { if (this._isCurrent(session)) errToast("Couldn't send sticker: " + (err.message || err)); });
      },
    });
  }

  // Shared image send flow (paste and file picker): preview with caption →
  // optional crop loop → send. corePath is the core-readable path of the
  // original file when one exists (picker); clipboard blobs (null) are
  // written to the uploads directory first.
  async _imageSendFlow(blob, session, corePath = null) {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (!invoke) { errToast("Sending images is only available in the app"); return; }
    let current = blob;
    let text = "";
    let outPath = corePath;
    for (;;) {
      const act = await this._imagePreviewModal(current, text);
      if (!act) return; // preview dismissed
      text = act.text;
      if (act.action === "send") {
        try {
          const { quoteId, quoteText, prefix } = this._takeQuote();
          let filePath = outPath;
          let filename;
          if (filePath) {
            filename = filePath.replace(/\\/g, "/").split("/").pop();
          } else {
            const ext = current.type === "image/jpeg" ? "jpg" : current.type === "image/webp" ? "webp" : current.type === "image/gif" ? "gif" : "png";
            filename = `image-${Date.now()}.${ext}`;
            filePath = await invoke("resolve_upload_path", { filename });
            diagnosticsSink.append("info", `image: upload path = ${filePath}`);
            if (!filePath) throw new Error("resolve_upload_path returned empty");
            const bytes = new Uint8Array(await current.arrayBuffer());
            await invoke("plugin:fs|write_file", bytes, {
              headers: { path: encodeURIComponent(filePath) },
            });
            diagnosticsSink.append("info", `image: wrote ${bytes.length} bytes`);
          }
          const msg = await this.core.sendMessage(session.chatId, { text: prefix + text, viewtype: "image", file: filePath, filename, quoteId, quoteText });
          if (!this._isCurrent(session)) return;
          this.appendOutgoing(msg);
          this.onChatsChanged();
        } catch (err) {
          diagnosticsSink.append("error", `image send failed: ${err?.message || err}`);
          if (this._isCurrent(session)) errToast("Could not send image: " + (err?.message || err));
        }
        return;
      }
      const cropUrl = URL.createObjectURL(act.blob);
      const cropped = await openImageCropper(cropUrl).finally(() => URL.revokeObjectURL(cropUrl));
      if (cropped) { current = cropped; outPath = null; } // cropped bytes need writing
    }
  }

  // Send/Crop preview with a caption field. Resolves null (dismissed),
  // { action: "send", blob, text } or { action: "crop", blob, text }.
  // Interactive elements are built explicitly (createElement + listeners),
  // keeping the modal click-testable without an HTML parser.
  _imagePreviewModal(blob, text = "") {
    return new Promise(resolve => {
      let settled = false;
      const url = URL.createObjectURL(blob);
      const finish = (v) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(v); };
      const body = document.createElement("div");
      const img = document.createElement("img");
      img.src = url; img.alt = "";
      img.style.cssText = "max-width:100%;max-height:40vh;border-radius:8px";
      const ta = document.createElement("textarea");
      ta.className = "text-field"; ta.dataset.caption = ""; ta.rows = 2;
      ta.placeholder = "Add a caption…"; ta.value = text;
      ta.style.cssText = "margin-top:10px";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;margin-top:10px;justify-content:center";
      const send = document.createElement("button");
      send.type = "button"; send.className = "btn-text";
      send.style.cssText = "background:var(--accent);color:#f4f4f4";
      send.textContent = "Send";
      const crop = document.createElement("button");
      crop.type = "button"; crop.className = "btn-text"; crop.textContent = "Crop";
      actions.append(send, crop);
      body.append(img, ta, actions);
      const { close } = showModal({ title: "Send image", body, onClose: () => finish(null) });
      send.addEventListener("click", () => { finish({ action: "send", blob, text: ta.value.trim() }); close(); });
      crop.addEventListener("click", () => { finish({ action: "crop", blob, text: ta.value }); close(); });
    });
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
    if (!this._isCurrent(session) || !text || !this.chat) return;
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
      const msg = await this.core.sendMessage(session.chatId, { text: sendText, quoteId, quoteText });
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
        const msg = await this.core.sendMessage(session.chatId, { text: "", viewtype: "voice", extra: { duration: 5 + Math.floor(Math.random() * 40) } });
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

      // Images go through the same preview/crop/caption flow as pastes.
      if (kind === "image" || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extOf(resolved))) {
        const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[extOf(resolved).toLowerCase()] || "image/png";
        const bytes = new Uint8Array(await invoke("plugin:fs|read_file", { path: resolved }));
        const blob = new Blob([bytes], { type: mime });
        if (!this._isCurrent(session)) return;
        return this._imageSendFlow(blob, session, resolved);
      }

      const name = resolved.replace(/\\/g, "/").split("/").pop() || "attachment";
      const ext = extOf(name);
      let viewtype = "file";
      if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) viewtype = "video";
      else if (["mp3", "m4a", "ogg", "wav", "flac"].includes(ext)) viewtype = "audio";
      const { quoteId, quoteText, prefix } = this._takeQuote();
      const msg = await this.core.sendMessage(session.chatId, { text: prefix, viewtype, file: resolved, filename: name, quoteId, quoteText });
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
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) {
      invoke("plugin:opener|open_path", { path }).catch(err => {
        if (this._isCurrent(session)) errToast("Could not open file: " + (err.message || err));
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
      const inject = `<style>html{color-scheme:${dark ? "dark" : "light"}}</style>`;
      const head = /<head[^>]*>/i.exec(html) || /<html[^>]*>/i.exec(html);
      return head
        ? html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length)
        : inject + html;
    };
    const closeViewer = () => {
      if (history.state?.velta === "html-view") history.back();
      else wrap.remove();
    };
    // Reopening replaces the stale entry instead of stacking a second one.
    if (history.state?.velta !== "html-view") history.pushState({ velta: "html-view" }, "");
    window.addEventListener("popstate", () => wrap.remove(), { once: true });
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
      if (this.scrollEl.scrollTop < 220) this._loadOlder();
      if (this._nearBottom()) this._hideGoDown();
    }, { passive: true });
    this.goDownBtn.addEventListener("click", () => {
      if (!this._isCurrent() || !this.chat) return;
      this._scrollBottom();
      this._hideGoDown();
      this.core.markRead(this.chat.id);
    });
    // Resize covers interface-scale (CSS zoom) changes: the virtual scroller
    // then re-measures and shifts its paddings for a few frames — re-pin to
    // the latest message if we were at the bottom.
    window.addEventListener("resize", () => {
      if (this._isCurrent() && this.chat && this._nearBottom()) this._scrollBottomSettling();
    });
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
    this._stopSettling?.();
    const session = this._session;
    let lastHeight = -1, stableFrames = 0, frames = 0, stopped = false, userScrolled = false;
    let frame;
    const onUserScroll = () => { userScrolled = true; stop(); };
    this.scrollEl.addEventListener("wheel", onUserScroll, { passive: true });
    this.scrollEl.addEventListener("touchstart", onUserScroll, { passive: true });
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (this._stopSettling === stop) this._stopSettling = null;
      // The virtual scroller re-lays out on its own ~100ms "scrolling stopped"
      // timer and shifts the paddings after we stop pinning — re-assert the
      // bottom once more after that settles (unless the user took over).
      setTimeout(() => {
        this.scrollEl.removeEventListener("wheel", onUserScroll);
        this.scrollEl.removeEventListener("touchstart", onUserScroll);
        if (!userScrolled && this._isCurrent(session) && this.chat) this._scrollBottom();
      }, 450);
    };
    this._stopSettling = stop;
    const tick = () => {
      if (stopped || !this._isCurrent(session) || !this.chat) { stop(); return; }
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
      this._hideGoDown();
      const height = this.scrollEl.scrollHeight;
      if (height === lastHeight) stableFrames++; else { stableFrames = 0; lastHeight = height; }
      frames++;
      if (stableFrames >= 4 || frames >= 90) { stop(); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  _bumpGoDown(chatId, background = false) {
    if (background) return;
    this._newWhileAway++;
    this.goDownBadge.textContent = this._newWhileAway;
    this.goDownBadge.hidden = false;
    this.goDownBtn.hidden = false;
  }

  _hideGoDown() {
    this._newWhileAway = 0;
    this.goDownBadge.hidden = true;
    this.goDownBtn.hidden = true;
  }

  _jumpToMessage(msgId) {
    const row = this.listEl.querySelector(`[data-msgid="${msgId}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.style.transition = "background .3s";
      row.style.background = "rgba(90,162,230,.25)";
      setTimeout(() => row.style.background = "", 900);
    } else {
      toast("Message is higher up in history — scroll up to load it");
    }
  }

  _bindCoreEvents() {
    this.core.addEventListener("msg-state", e => this.onMsgState(e.detail.chatId, e.detail.msgId, e.detail.state));
    this.core.addEventListener("msg-updated", e => this.onMsgUpdated(e.detail.chatId, e.detail.msg));
    this.core.addEventListener("msgs-deleted", e => this.onMsgsDeleted(e.detail.chatId, e.detail.ids));
    this.core.addEventListener("incoming-msg", e => this.onIncoming(e.detail.chatId, e.detail.msg));
    this.core.addEventListener("msgs-changed", e => this.onMsgsChanged(e.detail.chatId, { fresh: true }));
    this.core.addEventListener("msg-sent", e => { /* handled via sendMessage return */ });
    this.core.addEventListener("pinned-changed", e => {
      if (e.detail.chatId === this._session?.chatId) this._refreshPinnedBar();
    });
  }
}

// Inline text rendering (URLs, invite cards, markdown) lives in markdown.js.
