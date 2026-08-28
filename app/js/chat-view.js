// chat-view.js — virtualized message history (virtual-scroller) + composer
import { formatTime, formatDay, formatBytes } from "./mock-core.js";
import { escapeHtml, ticksSvg } from "./components.js";
import { showContextMenu, showModal, confirmModal, toast, showEmojiPop } from "./ui.js";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🎉", "👏"];

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

function fileUrl(path) {
  if (!path) return "";
  try {
    const tauri = window.__TAURI__;
    if (tauri?.core?.convertFileSrc) {
      let resolved = path.replace(/\\/g, "/");
      const isAbs = /^([a-zA-Z]:|\/)/.test(resolved);
      if (!isAbs && window.veltaAccountsDir) {
        const base = window.veltaAccountsDir.replace(/\\/g, "/").replace(/\/$/, "");
        resolved = `${base}/${resolved.replace(/^\/+/, "")}`;
      }
      const url = tauri.core.convertFileSrc(resolved);
      rustLog(`fileUrl path=${path} resolved=${resolved} url=${url}`);
      return url;
    }
  } catch (e) { rustLog(`fileUrl error: ${e}`); }
  return path;
}

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
    this.chat = await this.core.getChat(chatId);
    this.replyTo = null;
    this._renderReplyPreview();
    this.items = [];
    this.msgIndex.clear();
    this.vs?.stop();
    this.vs = null;
    this.listEl.replaceChildren();

    const { messages, hasMore } = await this.core.getMessages(chatId, { limit: 40 });
    this.hasMore = hasMore;
    this._rebuildItems(messages);
    this._createScroller();
    await this.core.markRead(chatId);
    requestAnimationFrame(() => this._scrollBottom(true));
    this.startLive();
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
    rustLog(`chat-view onMsgsChanged chatId=${chatId} current=${this.chat?.id} fresh=${fresh}`);
    if (!this.chat || (chatId && chatId !== this.chat.id)) return;
    let maxId = 0;
    for (const it of this.items) if (it.type === "msg" && it.msg.id > maxId) maxId = it.msg.id;
    let messages;
    try {
      ({ messages } = await this.core.getMessages(this.chat.id, { limit: 40, fresh }));
    } catch { return; }
    if (!this.chat) return;
    const newMsgs = messages.filter(m => m.id > maxId && !this.msgIndex.has(m.id));
    rustLog(`chat-view onMsgsChanged found ${newMsgs.length} new messages`);
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

  // Live tail polling while a chat is open — guarantees new messages appear
  // even if core events are delayed or dropped by the transport.
  startLive() {
    this.stopLive();
    rustLog(`chat-view startLive chat=${this.chat?.id}`);
    this._liveTimer = setInterval(() => {
      if (this.chat && !document.hidden) this.onMsgsChanged(0, { fresh: true });
    }, 2000);
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

  onMsgUpdated(chatId, msg) {
    if (!this.chat || chatId !== this.chat.id) return;
    const item = this.msgIndex.get(msg.id);
    if (!item) return;
    item.msg = msg;
    this.vs?.onItemHeightDidChange?.(item);
    const row = this.listEl.querySelector(`[data-msgid="${msg.id}"]`);
    if (row) row.replaceWith(this._renderMsgItem(item));
  }

  onMsgsDeleted(chatId, ids) {
    if (!this.chat || chatId !== this.chat.id) return;
    this.items = this.items.filter(it => !(it.type === "msg" && ids.includes(it.msg.id)));
    for (const id of ids) this.msgIndex.delete(id);
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
  }

  _renderItem(item) {
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
      inner += `<dc-avatar name="${escapeHtml(m.fromContact.name)}" color="${m.fromContact.color}" size="30"></dc-avatar>`;
    }

    let bubble = "";
    if (showAvatar) bubble += `<div class="msg-sender" style="color:${m.fromContact.color}">${escapeHtml(m.fromContact.name)}</div>`;
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
        bubble += `<div class="msg-video"><video data-src="video" controls preload="metadata" playsinline></video></div>`;
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

    if (m.text) bubble += `<div class="msg-text">${linkify(m.text)}`;
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

    // Wire up real local file URLs for images / video / audio.
    const mediaImg = row.querySelector('.msg-image img[data-src]');
    if (mediaImg) {
      mediaImg.src = fileUrl(m.filePath);
      mediaImg.onerror = () => rustLog(`media img error src=${mediaImg.src} original=${m.filePath}`);
    }
    const mediaVideo = row.querySelector('.msg-video video[data-src]');
    if (mediaVideo) {
      mediaVideo.src = fileUrl(m.filePath);
      mediaVideo.onloadedmetadata = () => rustLog(`media video loaded id=${m.id} src=${mediaVideo.src}`);
      mediaVideo.onerror = () => rustLog(`media video error src=${mediaVideo.src} original=${m.filePath}`);
      // On Android WebView the first frame is often not shown automatically;
      // forcing a seek helps generate the poster frame.
      mediaVideo.oncanplay = () => { try { mediaVideo.currentTime = 0.001; } catch {} };
    }
    const mediaAudio = row.querySelector('.msg-audio audio[data-src]');
    if (mediaAudio) {
      mediaAudio.src = fileUrl(m.filePath);
      mediaAudio.onerror = () => rustLog(`media audio error src=${mediaAudio.src} original=${m.filePath}`);
    }

    row.addEventListener("contextmenu", e => {
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
    const ok = await confirmModal("Delete messages", `Delete ${ids.length} message${ids.length > 1 ? "s" : ""}? This removes them for you and requests deletion at the relay.`);
    if (ok) {
      await this.core.deleteMessages(this.chat.id, ids);
      this.exitSelection();
      this.onChatsChanged();
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
      const path = await invoke("plugin:dialog|open", { options: { multiple: false, filters } });
      if (!path) return;
      const name = path.replace(/\\/g, "/").split("/").pop();
      const ext = extOf(path);
      let viewtype = "file";
      if (kind === "image" || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) viewtype = "image";
      else if (kind === "video" || ["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) viewtype = "video";
      else if (["mp3", "m4a", "ogg", "wav", "flac"].includes(ext)) viewtype = "audio";

      const resolved = await resolveAttachmentPath(path, name);
      const msg = await this.core.sendMessage(this.chat.id, { text: "", viewtype, file: resolved, filename: name });
      this.appendOutgoing(msg);
      this.onChatsChanged();
    } catch (err) {
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

function linkify(text) {
  const esc = escapeHtml(text);
  return esc.replace(/\bhttps?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}
