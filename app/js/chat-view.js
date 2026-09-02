// chat-view.js — virtualized message history (virtual-scroller) + composer
import { formatTime, formatDay, formatBytes } from "./mock-core.js";
import { escapeHtml, escapeAttr, ticksSvg } from "./components.js";
import { showContextMenu, showModal, confirmDeleteMessagesModal, toast, showEmojiPop, openImageLightbox } from "./ui.js";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🎉", "👏"];

import { diagnosticsSink, debugLog } from "./diagnostics.js";
import { fileUrl } from "./media.js";
import { renderMarkdown } from "./markdown.js";

function rustLog(msg) {
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
}


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
  mic: `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 11a7 7 0 0014 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  lock: `<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
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
    const absDest = await invoke("resolve_upload_path", { filename: `uploads/${destName}` });
    rustLog(`resolveAttachmentPath original=${originalPath} dest=${absDest}`);
    if (!absDest) throw new Error("resolve_upload_path returned empty");

    // Read original bytes and write to app-local destination.
    const bytes = await invoke("plugin:fs|read_file", { path: originalPath });
    await invoke("plugin:fs|write_file", { path: absDest, contents: bytes });
    return absDest;
  } catch (e) {
    rustLog(`resolveAttachmentPath failed: ${e}; falling back to original`);
    return originalPath;
  }
}

function extOf(path) {
  if (!path) return "";
  const base = path.replace(/\\/g, "/").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export class ChatView {
  constructor(core, { onChatsChanged, onForward }) {
    this.core = core;
    this.onChatsChanged = onChatsChanged;
    this.onForward = onForward;
    this.chat = null;
    this.items = [];        // flattened items for the virtual scroller
    this.msgIndex = new Map();
    this._rowCache = new Map();  // item.key → rendered element (reused across setItems)
    this._rowSigCache = new Map();  // item.key → render signature of the cached row
    this.hasMore = false;
    this.loadingMore = false;
    this.selection = new Set();
    this.replyTo = null;

    this.scrollEl = document.getElementById("history-scroll");
    this.listEl = document.getElementById("history");
    this.goDownBtn = document.getElementById("btn-go-down");
    this.goDownBadge = document.getElementById("go-down-badge");
    this._newWhileAway = 0;

    this._bindComposer();
    this._bindScroll();
    this._bindSelectionBar();
    this._bindCoreEvents();
  }

  /* ================= public ================= */

  async open(chatId) {
    this.exitSelection();
    // Always render from scratch here. "Already open" is guarded in
    // App.openChat; a DOM-state shortcut is not safe because other surfaces
    // (the Diagnostics chat writes rows into #history directly) can replace
    // the scroller's content while this.chat/items still look current.
    this.chat = await this.core.getChat(chatId);
    this.replyTo = null;
    this._renderReplyPreview();
    this.items = [];
    this.msgIndex.clear();
    this._rowCache.clear();
    this._rowSigCache.clear();
    this.vs?.stop();
    this.vs = null;
    this.listEl.replaceChildren();
    // Drop everything the previous scroller session left on the persistent
    // containers: stale inline paddings (the scroller's virtual space) and a
    // stale scrollTop make the new scroller start from a mid-history
    // position, from which it never recovers to the bottom.
    this.listEl.style.paddingTop = "";
    this.listEl.style.paddingBottom = "";
    this.scrollEl.scrollTop = 0;

    const { messages, hasMore } = await this.core.getMessages(chatId, { limit: 40 });
    this.hasMore = hasMore;
    this._rebuildItems(messages);
    this._createScroller();
    await this.core.markRead(chatId);
    this._scrollBottomSettling();
    this.startLive();
  }

  // Full teardown: stop polling, dispose the virtual scroller, drop cached
  // rows and leave #history empty. Used when another surface takes over the
  // history area (Diagnostics chat) and when the chat is closed.
  close() {
    this.stopLive();
    this.chat = null;
    this.vs?.stop();
    this.vs = null;
    this.items = [];
    this.msgIndex.clear();
    this._rowCache.clear();
    this._rowSigCache.clear();
    this.replyTo = null;
    this._renderReplyPreview();
    this.exitSelection();
    this.listEl.replaceChildren();
    this.listEl.style.paddingTop = "";
    this.listEl.style.paddingBottom = "";
    this.scrollEl.scrollTop = 0;
  }

  async appendOutgoing(msg) {
    if (!this.chat || msg.chatId !== this.chat.id) return;
    this._insertItems(this._withSeparatorsAppend([msg]));
    this.vs?.setItems(this.items);
    if (this._nearBottom()) requestAnimationFrame(() => this._scrollBottom());
  }

  async onIncoming(chatId, msg) {
    rustLog(`chat-view onIncoming chatId=${chatId} current=${this.chat?.id}`);
    if (!this.chat || chatId !== this.chat.id) { this._bumpGoDown(chatId, true); return; }
    // The same message id can arrive twice (e.g. appended as a download
    // placeholder first, then re-notified once the full content merged).
    // Update the existing row in place instead of appending a duplicate.
    if (this.msgIndex.has(msg.id)) { this.onMsgUpdated(chatId, msg); return; }
    this._insertItems(this._withSeparatorsAppend([msg]));
    this.vs?.setItems(this.items);
    if (this._nearBottom()) {
      requestAnimationFrame(() => this._scrollBottom());
      this.core.markRead(chatId);
    } else {
      this._bumpGoDown(chatId);
    }
  }

  // Fallback refresh: the core signals "messages changed" (IncomingMsgBunch
  // carries no ids, and the decorated fast-path may fail). Reload the tail
  // and append only what's actually new, preserving scroll/history paging.
  async onMsgsChanged(chatId, { fresh = false } = {}) {
    debugLog(`chat-view onMsgsChanged chatId=${chatId} current=${this.chat?.id} fresh=${fresh}`);
    if (!this.chat || (chatId && chatId !== this.chat.id)) return;
    let maxId = 0;
    for (const it of this.items) if (it.type === "msg" && it.msg.id > maxId) maxId = it.msg.id;
    let messages;
    try {
      ({ messages } = await this.core.getMessages(this.chat.id, { limit: 40, fresh }));
    } catch { return; }
    if (!this.chat) return;
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
    // playable player once its Post-Message arrives).
    let updated = 0;
    for (const m of messages) {
      const item = this.msgIndex.get(m.id);
      if (item?.msg && item.msg !== m
        && (item.msg.downloadState !== m.downloadState || item.msg.viewtype !== m.viewtype)) {
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
    this._insertItems(this._withSeparatorsAppend(newMsgs));
    this.vs?.setItems(this.items);
    if (this._nearBottom()) {
      requestAnimationFrame(() => this._scrollBottom());
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
    debugLog(`chat-view startLive chat=${this.chat?.id}`);
    this._liveTicks = 0;
    this._liveTimer = setInterval(() => {
      if (this.chat && !document.hidden) {
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
    if (!this.chat || chatId !== this.chat.id) return;
    const item = this.msgIndex.get(msgId);
    if (item) item.msg.state = state;
    const row = this.listEl.querySelector(`[data-msgid="${msgId}"]`);
    const ticks = row?.querySelector(".msg-meta .ticks-slot");
    if (ticks) ticks.innerHTML = ticksSvg(state, "ticks");
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
    if (!this.chat || chatId !== this.chat.id) return;
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
    this.vs?.onItemHeightDidChange?.(item);
    const row = this.listEl.querySelector(`[data-msgid="${msg.id}"]`);
    if (row) {
      const fresh = this._renderMsgItem(item);
      row.replaceWith(fresh);
      this._rowCache.set(item.key, fresh);
      this._rowSigCache.set(item.key, sig);
    } else {
      this._rowCache.delete(item.key);
      this._rowSigCache.delete(item.key);
    }
  }

  onMsgsDeleted(chatId, ids) {
    if (!this.chat || chatId !== this.chat.id) return;
    this.items = this.items.filter(it => !(it.type === "msg" && ids.includes(it.msg.id)));
    for (const id of ids) {
      this.msgIndex.delete(id);
      this._rowCache.delete("m" + id);
      this._rowSigCache.delete("m" + id);
    }
    this.vs?.setItems(this.items);
  }

  /* ================= items & separators ================= */

  _rebuildItems(messages) {
    this.items = [];
    this.msgIndex.clear();
    this._insertItems(this._withSeparatorsAppend(messages), true);
  }

  _withSeparatorsAppend(messages) {
    const out = [];
    let lastDay = this.items.length ? this.items[this.items.length - 1].dayKey : null;
    let firstUnreadPlaced = this._unreadPlaced;
    for (const m of messages) {
      const dayKey = new Date(m.ts).toDateString();
      if (dayKey !== lastDay) {
        out.push({ type: "day", key: "day-" + dayKey, dayKey, ts: m.ts });
        lastDay = dayKey;
      }
      if (!firstUnreadPlaced && this.chat?.unread > 0 && m.from !== 1 && this._isFirstUnread(m)) {
        out.push({ type: "unread", key: "unread-sep", dayKey });
        firstUnreadPlaced = true;
      }
      const item = { type: "msg", key: "m" + m.id, msg: m, dayKey };
      this.msgIndex.set(m.id, item);
      out.push(item);
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
    if (this.loadingMore || !this.hasMore || !this.items.length) return;
    this.loadingMore = true;
    const firstMsg = this.items.find(i => i.type === "msg");
    const beforeId = firstMsg?.msg.id ?? null;
    const { messages, hasMore } = await this.core.getMessages(this.chat.id, { beforeId, limit: 40 });
    this.hasMore = hasMore;
    if (messages.length) {
      const firstDayKey = this.items[0]?.dayKey;
      const out = [];
      let lastDay = null;
      for (const m of messages) {
        const dayKey = new Date(m.ts).toDateString();
        if (dayKey !== lastDay) {
          out.push({ type: "day", key: "day-" + dayKey, dayKey, ts: m.ts });
          lastDay = dayKey;
        }
        const item = { type: "msg", key: "m" + m.id, msg: m, dayKey };
        this.msgIndex.set(m.id, item);
        out.push(item);
      }
      // drop a now-duplicated day separator at the seam
      if (this.items[0]?.type === "day" && this.items[0].dayKey === lastDay) this.items = this.items.slice(1);
      this.items = [...out, ...this.items];
      this.vs?.setItems(this.items, { preserveScrollPositionOnPrependItems: true });
    }
    this.loadingMore = false;
  }

  /* ================= virtual scroller ================= */

  _createScroller() {
    this.vs = new VirtualScroller(this.listEl, this.items, (item) => this._renderItem(item), {
      getScrollableContainer: () => this.scrollEl,
      getItemId: (item) => item.key,
      getEstimatedItemHeight: () => 48,
    });
    // Debug: trace what drives the scroller (re-render loop investigation).
    window.__vs = this.vs;
    if (!debugLog.enabled) return;
    for (const name of ["setItems", "onItemHeightDidChange", "update", "renderItem", "rerender", "stop", "start"]) {
      const orig = this.vs[name];
      if (typeof orig === "function") {
        this.vs[name] = (...args) => {
          debugLog(`vs.${name} n=${args[0]?.length ?? ""} t=${Date.now() % 100000}`);
          return orig.apply(this.vs, args);
        };
      }
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
      case "day": {
        const el = document.createElement("div");
        el.className = "day-sep";
        el.textContent = formatDay(item.ts);
        return el;
      }
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

  _renderMsgItem(item) {
    const m = item.msg;
    if (m.kind === "service") {
      const row = document.createElement("div");
      row.className = "msg-row service";
      row.dataset.msgid = m.id;
      row.innerHTML = `<div class="service-msg">${escapeHtml(m.text)}</div>`;
      return row;
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
    if (this.selection.size) {
      inner += `<div class="msg-checkbox">${this.selection.has(m.id) ? ICO.check : ""}</div>`;
    }
    if (showAvatar) {
      inner += `<dc-avatar name="${escapeHtml(fc.name)}" color="${fc.color}" size="30" contact-id="${fc.id ?? ""}" addr="${escapeAttr(fc.addr || "")}"${fc.avatar ? ` avatar="${escapeAttr(fileUrl(fc.avatar))}"` : ""}></dc-avatar>`;
    }

    let bubble = "";
    if (showAvatar) bubble += `<div class="msg-sender" style="color:${fc.color}">${escapeHtml(fc.name)}</div>`;
    if (m.fwdFrom) bubble += `<div class="msg-fwd">Forwarded from ${escapeHtml(m.fwdFrom)}</div>`;
    if (m.quote) {
      bubble += `<div class="msg-quote" data-quote="${m.quote.id}">
        <span class="q-name">${escapeHtml(m.quote.fromContact?.name || "")}</span>
        <span class="q-text">${escapeHtml(m.quote.text || "")}</span></div>`;
    }
    if (m.viewtype === "image" || m.viewtype === "gif" || m.viewtype === "sticker") {
      if (m.downloadState === "Done" && m.filePath) {
        bubble += `<div class="msg-image"><img data-src="image" alt=""></div>`;
      } else {
        const size = m.fileSize ? formatBytes(m.fileSize) : "";
        bubble += `<div class="msg-file download-btn" role="button" data-act="download">
          <div class="file-ico">${ICO.download}</div>
          <div><div class="file-name">${escapeHtml(m.fileName || "Photo")}</div><div class="file-size">${m.downloadState === "InProgress" ? "Downloading…" : size || "Tap to download"}</div></div>
        </div>`;
      }
    } else if (m.viewtype === "video") {
      if (m.downloadState === "Done" && m.filePath) {
        // Click-to-load: <dc-video> renders a static placeholder; the real
        // <video> (decoder + media requests) is only created on tap. `file`
        // carries the raw path for poster extraction; `src` is served.
        const size = m.fileSize ? formatBytes(m.fileSize) : "";
        bubble += `<div class="msg-video"><dc-video src="${escapeAttr(fileUrl(m.filePath))}" file="${escapeAttr(m.filePath)}" size="${escapeAttr(size)}" duration="${m.duration || ""}" name="${escapeHtml(m.fileName || "Video")}"></dc-video></div>`;
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
    } else if (m.viewtype === "file") {
      const isDownloaded = m.downloadState === "Done";
      bubble += `<div class="msg-file${isDownloaded ? "" : " download-btn"}" role="button" data-act="${isDownloaded ? "open" : "download"}">
        <div class="file-ico">${ICO.download}</div>
        <div><div class="file-name">${escapeHtml(m.fileName || "File")}</div><div class="file-size">${m.downloadState === "InProgress" ? "Downloading…" : (m.fileSize ? formatBytes(m.fileSize) : "Tap to download")}</div></div>
      </div>`;
    }

    if (m.text) bubble += `<div class="msg-text">${renderMarkdown(m.text)}`;
    else bubble += `<div class="msg-text">`;
    const edited = m.edited ? `<span class="edited">edited</span>` : "";
    const star = m.starred ? `<svg class="star-ico" viewBox="0 0 24 24"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2 1.3-6.2L3 9.5l6.3-.7z" fill="currentColor"/></svg>` : "";
    const ticks = out ? `<span class="ticks-slot">${ticksSvg(m.state, "ticks")}</span>` : "";
    bubble += `<span class="msg-meta">${edited}${star}${formatTime(m.ts)}${ticks}</span></div>`;
    if (m.reactions?.length) {
      bubble += `<div class="msg-reactions">${m.reactions.map(r =>
        `<span class="reaction-chip${r.mine ? " mine" : ""}" data-react="${r.emoji}">${r.emoji} ${r.count}</span>`).join("")}</div>`;
    }
    inner += `<div class="bubble">${bubble}</div>`;
    row.innerHTML = inner;

    // One-click reply (desktop hover): a small pill at the bubble's top-right
    // corner — the same _setReply the context menu uses, plus composer focus
    // so the reply really is a single click.
    const hoverReply = document.createElement("button");
    hoverReply.type = "button";
    hoverReply.className = "msg-hover-reply";
    hoverReply.title = "Reply";
    hoverReply.innerHTML = `${ICO.reply}<span>Reply</span>`;
    hoverReply.addEventListener("click", e => {
      e.stopPropagation();
      this._setReply(item);
      document.getElementById("composer-input")?.focus();
    });
    row.querySelector(".bubble")?.appendChild(hoverReply);

    // Wire up real local file URLs for images / video / audio. When media
    // can't load, show a clear placeholder instead of a broken element.
    // Media rows change height when their content loads (image decodes,
    // video metadata sets the aspect ratio) — the virtual scroller must be
    // told about each change, otherwise its layout math goes stale and the
    // list jitters while scrolling ("Item index N height changed
    // unexpectedly" console warnings).
    const notifyHeight = () => this.vs?.onItemHeightDidChange?.(item);
    const mediaImg = row.querySelector('.msg-image img[data-src]');
    if (mediaImg) {
      mediaImg.src = fileUrl(m.filePath);
      mediaImg.addEventListener("load", notifyHeight);
      mediaImg.addEventListener("click", e => {
        e.stopPropagation();
        if (mediaImg.naturalWidth) openImageLightbox(mediaImg.src, m.fileName || "photo");
      });
      mediaImg.onerror = () => {
        rustLog(`media img error src=${mediaImg.src} original=${m.filePath}`);
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
        rustLog(`media audio error src=${mediaAudio.src} original=${m.filePath}`);
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
      if (e.altKey) return;
      e.preventDefault();
      this._msgContextMenu(item, e.clientX, e.clientY);
    });
    let pressTimer;
    row.addEventListener("touchstart", () => { pressTimer = setTimeout(() => this._msgContextMenu(item, innerWidth / 2, innerHeight / 2), 500); }, { passive: true });
    row.addEventListener("touchend", () => clearTimeout(pressTimer));
    row.addEventListener("touchmove", () => clearTimeout(pressTimer));
    row.addEventListener("click", e => {
      if (this.selection.size) { this._toggleSelect(m.id, row); return; }
      const chip = e.target.closest("[data-react]");
      if (chip) { this.core.addReaction(this.chat.id, m.id, chip.dataset.react); return; }
      const quote = e.target.closest("[data-quote]");
      if (quote) { this._jumpToMessage(Number(quote.dataset.quote)); return; }
      const mediaAction = e.target.closest("[data-act]");
      if (mediaAction) {
        e.stopPropagation();
        if (mediaAction.dataset.act === "download") this._downloadMedia(m.id);
        else if (mediaAction.dataset.act === "open") this._openFile(m.filePath);
        return;
      }
    });
    return row;
  }

  /* ================= message actions ================= */

  _msgContextMenu(item, x, y) {
    const m = item.msg;
    if (m.kind === "service") return;
    const items = [
      { label: "Reply", icon: ICO.reply, onClick: () => this._setReply(item) },
    ];
    if (m.viewtype === "text" && m.text) items.push({ label: "Copy text", icon: ICO.copy, onClick: () => { navigator.clipboard?.writeText(m.text); toast("Copied"); } });
    items.push(
      { label: "Forward", icon: ICO.forward, onClick: () => this._forward([m.id]) },
      { label: "Save to Saved Messages", icon: ICO.star, onClick: async () => { await this.core.starMessages(this.chat.id, [m.id]); toast("Saved"); this.onChatsChanged(); } },
      { label: "React", icon: QUICK_REACTIONS[0], onClick: () => this._reactionMenu(item, x, y) },
      { label: "Select", icon: ICO.select, onClick: () => this._enterSelection(m.id) },
      { label: "Info", icon: ICO.info, onClick: () => this._showInfo(item) },
      "-",
      { label: "Delete", icon: ICO.trash, danger: true, onClick: () => this._delete([m.id]) },
    );
    showContextMenu(items, x, y);
  }

  _reactionMenu(item, x, y) {
    showContextMenu(QUICK_REACTIONS.map(e => ({
      label: e, onClick: () => this.core.addReaction(this.chat.id, item.msg.id, e),
    })), x, y - 10);
  }

  _showInfo(item) {
    const m = item.msg;
    const stateNames = { pending: "Sending…", sent: "Sent", delivered: "Delivered", read: "Read", received: "Received" };
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
    // Mirror the official Delta Chat desktop dialog: "Delete for everyone"
    // is offered only when the core can honor it — self-sent messages in an
    // encrypted chat that isn't self-talk (delete_messages_for_all rules).
    const msgs = ids.map(id => this.msgIndex.get(id)?.msg).filter(Boolean);
    const canForAll = msgs.length === ids.length
      && this.chat.kind !== "saved"
      && this.chat.encrypted !== false
      && msgs.every(m => m.from === 1);
    const choice = await confirmDeleteMessagesModal(ids.length, canForAll);
    if (!choice) return;
    try {
      await this.core.deleteMessages(this.chat.id, ids, { forAll: choice === "everyone" });
      this.exitSelection();
      this.onChatsChanged();
    } catch (err) {
      toast("Couldn't delete messages: " + (err.message || err), 4500);
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
        await this.core.starMessages(this.chat.id, ids);
        toast("Saved to Saved Messages");
        this.exitSelection();
        this.onChatsChanged();
      } else if (act === "delete") this._delete(ids);
      else if (act === "info") {
        const item = this.msgIndex.get(ids[0]);
        if (item) this._showInfo(item);
      }
    });
  }

  /* ================= reply ================= */

  _setReply(item) {
    this.replyTo = item.msg;
    this._renderReplyPreview();
    document.getElementById("composer-input").focus();
  }

  _renderReplyPreview() {
    const bar = document.getElementById("reply-preview");
    if (!this.replyTo) { bar.hidden = true; return; }
    bar.hidden = false;
    document.getElementById("reply-name").textContent = this.replyTo.fromContact?.name || "You";
    document.getElementById("reply-text").textContent = this.replyTo.text || this.replyTo.viewtype;
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
    send.addEventListener("click", () => this._send());
    document.getElementById("btn-reply-close").addEventListener("click", () => { this.replyTo = null; this._renderReplyPreview(); });
    document.getElementById("btn-emoji").addEventListener("click", e => {
      showEmojiPop(e.currentTarget, emoji => {
        input.value += emoji;
        input.focus();
        grow();
      });
    });
    document.getElementById("btn-attach").addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      const menuHeight = 210; // approximate height of the attach menu
      // Prefer showing above the button; fall back to below when near the top.
      const y = r.top > menuHeight + 16 ? r.top - menuHeight : r.bottom + 8;
      const x = Math.min(r.left, window.innerWidth - 220);
      const menu = showContextMenu([
        { label: "Photo", icon: ICO.photo, onClick: () => this._sendAttachment("image") },
        { label: "Video", icon: ICO.photo, onClick: () => this._sendAttachment("video") },
        { label: "File", icon: ICO.file, onClick: () => this._sendAttachment("file") },
        { label: "Voice message", icon: ICO.mic, onClick: () => this._sendAttachment("voice") },
      ], x, y);
      menu.classList.add("attach-pop");
    });
  }

  async _send() {
    const input = document.getElementById("composer-input");
    const text = input.value.trim();
    if (!text || !this.chat) return;
    input.value = "";
    input.style.height = "auto";
    const quoteId = this.replyTo?.id ?? null;
    this.replyTo = null;
    this._renderReplyPreview();
    const msg = await this.core.sendMessage(this.chat.id, { text, quoteId });
    this.appendOutgoing(msg);
    this.onChatsChanged();
  }

  async _sendAttachment(kind) {
    if (!this.chat) return;

    // Voice recording is not implemented yet — keep the old demo placeholder.
    if (kind === "voice") {
      const msg = await this.core.sendMessage(this.chat.id, { text: "", viewtype: "voice", extra: { duration: 5 + Math.floor(Math.random() * 40) } });
      this.appendOutgoing(msg);
      this.onChatsChanged();
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
      toast("File picker is only available in the Tauri app");
      return;
    }

    try {
      let picked = await invoke("plugin:dialog|open", { options: { multiple: false, filters } });
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
        diagnosticsSink.append("info", `attachment copied to ${resolved}`);
      } else {
        resolved = await resolveAttachmentPath(picked, picked.replace(/\\/g, "/").split("/").pop());
      }

      const name = resolved.replace(/\\/g, "/").split("/").pop() || "attachment";
      const ext = extOf(name);
      let viewtype = "file";
      if (kind === "image" || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) viewtype = "image";
      else if (kind === "video" || ["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) viewtype = "video";
      else if (["mp3", "m4a", "ogg", "wav", "flac"].includes(ext)) viewtype = "audio";
      const msg = await this.core.sendMessage(this.chat.id, { text: "", viewtype, file: resolved, filename: name });
      this.appendOutgoing(msg);
      this.onChatsChanged();
    } catch (err) {
      diagnosticsSink.append("error", `send ${kind} failed: ${err.message || err}`);
      toast("Could not send file: " + (err.message || err), 4000);
      console.error(err);
    }
  }

  async _downloadMedia(msgId) {
    try {
      await this.core.downloadFullMessage(msgId);
      const msg = await this.core.getMessage(msgId);
      this.onMsgUpdated(this.chat.id, msg);
    } catch (err) {
      toast("Download failed: " + (err.message || err), 4000);
      console.error(err);
    }
  }

  _openFile(path) {
    if (!path) return;
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) {
      invoke("plugin:opener|open_path", { path }).catch(err => {
        toast("Could not open file: " + (err.message || err), 3000);
      });
    } else {
      toast("File opening is only available in the Tauri app");
    }
  }

  /* ================= scrolling ================= */

  _bindScroll() {
    this.scrollEl.addEventListener("scroll", () => {
      if (this.scrollEl.scrollTop < 220) this._loadOlder();
      if (this._nearBottom()) this._hideGoDown();
    }, { passive: true });
    this.goDownBtn.addEventListener("click", () => { this._scrollBottom(); this._hideGoDown(); if (this.chat) this.core.markRead(this.chat.id); });
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
    let lastHeight = -1, stableFrames = 0, frames = 0, stopped = false;
    const onUserScroll = () => { stopped = true; };
    this.scrollEl.addEventListener("wheel", onUserScroll, { passive: true, once: true });
    this.scrollEl.addEventListener("touchstart", onUserScroll, { passive: true, once: true });
    const cleanup = () => {
      this.scrollEl.removeEventListener("wheel", onUserScroll);
      this.scrollEl.removeEventListener("touchstart", onUserScroll);
      this._stopSettling = null;
    };
    this._stopSettling = () => { stopped = true; };
    const tick = () => {
      if (stopped || !this.chat) { cleanup(); return; }
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
      this._hideGoDown();
      const height = this.scrollEl.scrollHeight;
      if (height === lastHeight) stableFrames++; else { stableFrames = 0; lastHeight = height; }
      frames++;
      if (stableFrames >= 4 || frames >= 90) { cleanup(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
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
  }
}

// Inline text rendering (URLs, invite cards, markdown) lives in markdown.js.
