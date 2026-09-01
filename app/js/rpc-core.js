// rpc-core.js — drop-in replacement for MockCore that talks to the real
// deltachat core over a pluggable JSON-RPC transport:
//   • Tauri IPC (inside the desktop/Android Tauri shell)
//   • WebSocket to a local background core (the service APK on 127.0.0.1:20808)
// Same interface + events as mock-core.js, so app.js doesn't care which one is active.
//
// Method names, parameter order and response shapes follow
// deltachat-jsonrpc/src/api.rs and api/types/*.

let nextId = 1;

import { debugLog } from "./diagnostics.js";

function rustLog(msg) {
  try {
    console.log("[velta]", msg);
  } catch {}
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
}

export class JsonRpcCore extends EventTarget {
  /**
   * transport: {
   *   name: string,                  // "tauri" | "websocket"
   *   send(line: string): void,      // deliver one JSON-RPC request line
   *   setReceiver(fn): Promise|void, // register handler for incoming lines
   * }
   */
  constructor(transport) {
    super();
    this.transport = transport;
    this.accountId = null;
    this.pending = new Map();     // rpc id -> {resolve, reject}
    this.msgIdCache = new Map();  // chatId -> [msgIds ascending]
    this._onLine = this._onLine.bind(this);
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  /* ---------------- low-level JSON-RPC over the transport ---------------- */

  async init() {
    await this.transport.setReceiver(this._onLine);

    // Fail fast during the handshake: a socket that accepted but doesn't
    // answer RPC within a few seconds is a broken/stale service — better to
    // fall back quickly than to hang the whole app on 30s timeouts.
    const ids = await this._callWithTimeout(10000, "get_all_account_ids");
    if (ids.length === 0) {
      this.accountId = await this._callWithTimeout(4000, "add_account");
    } else {
      this.accountId = await this._callWithTimeout(4000, "get_selected_account_id");
      if (!this.accountId || !ids.includes(this.accountId)) this.accountId = ids[0];
    }
    await this._callWithTimeout(4000, "select_account", this.accountId);
    await this._callWithTimeout(4000, "start_io_for_all_accounts");
    this._pollEvents();
    return this;
  }

  // Re-establish the transport (e.g. after the service APK was restarted)
  // without dropping this core instance, so all UI listeners stay bound.
  async reconnect() {
    if (!this.transport.reconnect) return false;
    const ok = await this.transport.reconnect();
    if (!ok) return false;
    // fail all pending calls from the dead connection
    for (const { reject } of this.pending.values()) reject(new Error("reconnecting"));
    this.pending.clear();
    await this.transport.setReceiver(this._onLine);
    await this._call("select_account", this.accountId);
    await this._call("start_io_for_all_accounts");
    this.msgIdCache.clear();
    this._emit("chat-updated", { chatId: 0 });
    return true;
  }

  async restartIo() {
    await this._call("stop_io_for_all_accounts");
    await this._call("start_io_for_all_accounts");
    await this._call("maybe_network");
    this._emit("diagnostic", { level: "info", message: "Core network I/O restarted" });
    return true;
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  _call(method, ...params) {
    return this._callWithTimeout(30000, method, ...params);
  }

  _callWithTimeout(timeoutMs, method, ...params) {
    const id = nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const result = this.transport.send(line);
        // Tauri IPC returns a promise; catch invoke errors immediately
        if (result && typeof result.then === "function") {
          result.catch(e => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(e);
            }
          });
        }
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("rpc timeout: " + method));
        }
      }, timeoutMs);
    });
  }

  async _pollEvents() {
    if (this._polling) return; // don't start a second loop on reconnect
    this._polling = true;
    // The core queues events; poll like deltachat-desktop does.
    // Event shape: { event: { kind: "IncomingMsg", chat_id, msg_id }, context_id }
    for (;;) {
      try {
        const ev = await this._call("get_next_event");
        debugLog(`event raw: ${JSON.stringify(ev).slice(0, 400)}`);
        if (ev?.event) this._handleCoreEvent(ev.event).catch(() => {});
      } catch (error) {
        this._emit("diagnostic", { level: "warning", message: `Event polling failed: ${error?.message || error}` });
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  async _handleCoreEvent(ev) {
    // deltachat-jsonrpc serializes event payloads with camelCase ("chatId"),
    // but hand-rolled transports may deliver snake_case — accept both.
    const chatId = ev.chatId ?? ev.chat_id;
    const msgId = ev.msgId ?? ev.msg_id;
    debugLog(`event kind=${ev.kind} chatId=${chatId ?? "null"} msgId=${msgId ?? "null"}`);
    switch (ev.kind) {
      case "Info":
      case "Warning":
      case "Error":
      case "ImapConnected":
      case "SmtpConnected":
      case "SmtpMessageSent":
      case "ImapInboxIdle":
      case "ConnectivityChanged":
        this._emit("diagnostic", {
          level: ev.kind === "Error" ? "error" : ev.kind === "Warning" ? "warning" : "info",
          message: ev.msg || ev.comment || ev.kind,
        });
        break;
      case "IncomingMsg":
      case "IncomingMsgBunch": {
        // IncomingMsgBunch carries no chat_id/msg_id — use 0 ("any chat").
        const cid = chatId || 0;
        this._invalidateChat(cid);
        // Fallback signal so an open chat can reload its tail even if the
        // decorated fast-path below fails or carries no ids.
        this._emit("msgs-changed", { chatId: cid });
        if (msgId) {
          const m = await this._getDecoratedMessage(msgId);
          if (m) this._emit("incoming-msg", { chatId: m.chatId, msg: m });
        }
        break;
      }
      case "MsgsChanged": {
        const cid = chatId || 0;
        this._invalidateChat(cid);
        this._emit("msgs-changed", { chatId: cid });
        if (msgId) {
          const m = await this._getDecoratedMessage(msgId);
          if (m) this._emit("msg-updated", { chatId: m.chatId, msg: m });
        }
        break;
      }
      case "MsgDelivered":
        this._emit("msg-state", { chatId, msgId, state: "delivered" });
        break;
      case "MsgRead":
      case "MsgReadCountChanged":
        this._emit("msg-state", { chatId, msgId, state: "read" });
        break;
      case "MsgFailed":
        this._emit("msg-state", { chatId, msgId, state: "failed" });
        break;
      case "ConfigureProgress":
        this._emit("configure-progress", { progress: ev.progress || 0, comment: ev.comment || "" });
        break;
      case "ChatlistChanged":
      case "ChatlistItemChanged":
      case "ChatModified":
      case "MsgsNoticed":
        this._invalidateChat(chatId || 0);
        break;
    }
  }

  _invalidateChat(chatId) {
    if (chatId) this.msgIdCache.delete(chatId);
    else this.msgIdCache.clear(); // 0 = unknown/any chat: drop all cached id lists
    this._emit("chat-updated", { chatId });
  }

  /* ---------------- mapping: core → UI shapes ---------------- */

  _chatKind(c) {
    if (c.isSelfTalk) return "saved";
    if (c.isDeviceTalk) return "device";
    if (c.isContactRequest) return "deaddrop";
    switch (c.chatType) {
      case "Group": return "group";
      case "Mailinglist":
      case "OutBroadcast":
      case "InBroadcast": return "channel";
      default: return "single";
    }
  }

  // ChatListItemFetchResult { kind: "ChatListItem", ...flat fields }
  _mapChatListItem(c) {
    const kind = this._chatKind(c);
    const lastType = c.lastMessageType;
    let lastMsg = [c.summaryText1, c.summaryText2].filter(Boolean).join(": ");
    if (lastType === "Image" || lastType === "Gif") lastMsg = "📷 " + (c.summaryText2 || "Photo");
    else if (lastType === "Voice" || lastType === "Audio") lastMsg = "🎤 " + (c.summaryText2 || "Voice message");
    else if (lastType === "File" || lastType === "Video") lastMsg = "📎 " + (c.summaryText2 || "File");
    else if (lastType === "Sticker") lastMsg = c.summaryText2 || "Sticker";
    const outgoing = c.summaryStatus >= 18 && c.summaryStatus <= 28;
    return {
      id: c.id,
      name: c.name || "?",
      kind,
      contactId: c.dmChatContact ?? null,
      memberCount: 0,
      pinned: !!c.isPinned,
      muted: !!c.isMuted,
      archived: !!c.isArchived,
      verified: false,
      encrypted: !!c.isEncrypted,
      unread: c.freshMessageCounter ?? 0,
      draft: null,
      avatarColor: c.color || null,
      avatar: c.avatarPath || null,
      lastMsg: lastMsg || null,
      lastTs: c.lastUpdated ? c.lastUpdated * 1000 : 0,
      lastFrom: outgoing ? 1 : null,
      lastState: outgoing ? this._mapState(c.summaryStatus) : null,
    };
  }

  _mapState(state) {
    // deltachat::message::MessageState
    if (state == null) return "sent";
    if (state === 18 || state === 19 || state === 20) return "pending"; // OutPreparing/OutDraft/OutPending
    if (state === 24) return "failed";                                  // OutFailed
    if (state === 26) return "delivered";                               // OutDelivered
    if (state === 28) return "read";                                    // OutMdnRcvd
    return "received";
  }

  _mapViewtype(v) {
    switch (v) {
      case "Image": case "Gif": case "Sticker": return "image";
      case "Voice": return "voice";
      case "Audio": return "audio";
      case "Video": return "video";
      case "File": return "file";
      case "Webxdc": return "webxdc";
      default: return "text";
    }
  }

  _toCoreViewtype(v) {
    switch (v) {
      case "image": return "Image";
      case "video": return "Video";
      case "file": return "File";
      case "voice": return "Voice";
      case "audio": return "Audio";
      case "gif": return "Gif";
      case "sticker": return "Sticker";
      default: return "Text";
    }
  }

  _mapQuote(q) {
    if (!q) return null;
    if (q.kind === "JustText") {
      return { id: 0, from: 0, text: q.text || "", fromContact: { name: "", color: "#888" } };
    }
    return {
      id: q.messageId ?? 0,
      from: 0,
      text: q.text || "",
      fromContact: { name: q.overrideSenderName || q.authorDisplayName || "", color: q.authorDisplayColor || "#888" },
    };
  }

  _mapContact(c) {
    return {
      id: c.id,
      name: c.displayName || c.name || c.address || "?",
      addr: c.address,
      color: c.color || "#888",
      avatar: c.profileImage || null,
      online: c.wasSeenRecently ?? false,
      lastSeen: c.lastSeen ? c.lastSeen * 1000 : Date.now(),
      verified: !!c.isVerified,
      bot: false,
    };
  }

  _mapMessage(m) {
    if (m.isInfo) {
      return {
        id: m.id, chatId: m.chatId, kind: "service", viewtype: "text",
        from: 0, text: m.text || "", ts: (m.sortTimestamp || m.timestamp) * 1000,
        state: "read", fromContact: { name: "", color: "#888" },
      };
    }
    const out = m.fromId === 1; // ContactId::SELF
    const sender = m.sender || {};
    const vt = this._mapViewtype(m.viewType);
    const msg = {
      id: m.id,
      chatId: m.chatId,
      kind: "msg",
      viewtype: vt,
      from: out ? 1 : 0,
      text: m.text || "",
      ts: (m.sortTimestamp || m.timestamp) * 1000,
      state: this._mapState(m.state),
      starred: !!m.savedMessageId,
      edited: !!m.isEdited,
      quote: this._mapQuote(m.quote),
      reactions: this._mapReactions(m.reactions),
      fwdFrom: m.isForwarded ? (m.overrideSenderName || sender.displayName || "") : null,
      filePath: m.file || null,
      fileName: m.fileName || (m.file ? m.file.split("/").pop() : null),
      fileSize: m.fileBytes ?? null,
      fileMime: m.fileMime || null,
      downloadState: m.downloadState || "Done",
      img: null, // real blobs need blob-dir serving; placeholder for now
      duration: m.duration ? Math.round(m.duration / 1000) : undefined,
      fromContact: out
        ? { id: 1, name: "You", color: "#5aa2e6" }
        : this._mapContact(sender),
    };
    if (vt === "voice" && msg.duration) {
      msg.wave = Array.from({ length: 32 }, () => 4 + Math.floor(Math.random() * 22));
    }
    return msg;
  }

  _mapReactions(r) {
    const list = r?.reactions;
    if (!Array.isArray(list) || !list.length) return null;
    return list.map(x => ({ emoji: x.emoji, count: x.count, mine: !!x.isFromSelf }));
  }

  async _getDecoratedMessage(msgId) {
    try {
      const m = await this._call("get_message", this.accountId, msgId);
      return this._mapMessage(m);
    } catch { return null; }
  }

  /* ---------------- MockCore-compatible API ---------------- */

  async getAccount() {
    const acc = await this._call("get_account_info", this.accountId);
    if (acc.kind === "Unconfigured") {
      return {
        id: this.accountId, addr: "not configured", displayName: "New account",
        color: "#5aa2e6", bio: "", relay: "", configured: false,
      };
    }
    return {
      id: this.accountId,
      addr: acc.addr || "",
      displayName: acc.displayName || acc.addr || "Account",
      color: acc.color || "#5aa2e6",
      bio: "",
      relay: (acc.addr || "").split("@")[1] || "",
      configured: true,
    };
  }

  async getContacts() {
    const list = await this._call("get_contacts", this.accountId, 0, null);
    return list.map(c => this._mapContact(c));
  }

  async getChatList({ query = "" } = {}) {
    // (account_id, list_flags, query_string, query_contact_id)
    const ids = await this._call("get_chatlist_entries", this.accountId, null, query || null, null);
    if (!ids.length) return [];
    const items = await this._call("get_chatlist_items_by_entries", this.accountId, ids);
    const chats = [];
    for (const item of Object.values(items)) {
      if (item?.kind === "ChatListItem") {
        chats.push(this._mapChatListItem(item));
      } else if (item?.kind === "Error") {
        rustLog(`getChatList item error: ${JSON.stringify(item)}`);
      }
    }
    // keep the core's order (ids are already sorted by the chatlist)
    const order = new Map(ids.map((id, i) => [id, i]));
    chats.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return chats;
  }

  async getChat(chatId) {
    const list = await this.getChatList({});
    const found = list.find(c => c.id === chatId);
    if (found) return found;
    // fallback: minimal info for chats not in the default list
    const info = await this._call("get_basic_chat_info", this.accountId, chatId).catch(() => null);
    if (!info) return null;
    return {
      id: chatId, name: info.name || "?", kind: "single",
      encrypted: true, verified: false, muted: false, pinned: false,
      archived: false, avatarColor: info.color || null, avatar: info.avatarPath || null, contact: null, memberCount: 0,
    };
  }

  async getMessages(chatId, { beforeId = null, limit = 40, fresh = false } = {}) {
    if (fresh) this.msgIdCache.delete(chatId);
    let ids = this.msgIdCache.get(chatId);
    if (!ids) {
      ids = await this._call("get_message_ids", this.accountId, chatId, false, false);
      this.msgIdCache.set(chatId, ids);
    }
    let end = ids.length;
    if (beforeId != null) {
      const idx = ids.indexOf(beforeId);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - limit);
    const page = ids.slice(start, end);
    if (!page.length) return { messages: [], hasMore: start > 0 };
    const loaded = await this._call("get_messages", this.accountId, page);
    const messages = [];
    for (const id of page) {
      const entry = loaded[String(id)];
      // NB: MessageLoadResult uses serde rename_all camelCase on its tag,
      // so the variant arrives as "message" (NOT "Message").
      if (entry?.kind === "message" || entry?.kind === "Message") {
        messages.push(this._mapMessage(entry));
      }
    }
    return { messages, hasMore: start > 0 };
  }

  async sendMessage(chatId, { text = "", quoteId = null, viewtype = "text", file = null, filename = null } = {}) {
    const data = { text: text || "", quotedMessageId: quoteId ?? null };
    if (viewtype && viewtype !== "text") data.viewType = this._toCoreViewtype(viewtype);
    if (file) {
      data.file = file;
      if (filename) data.filename = filename;
    }
    const msgId = await this._call("send_msg", this.accountId, chatId, data);
    this.msgIdCache.get(chatId)?.push(msgId);

    // Outgoing media messages start in OutPreparing (18). Wait briefly until the
    // core has finished copying/processing the blob so get_message returns the
    // correct viewType and file path instead of plain text.
    const raw = await this._waitForPreparedMessage(msgId);
    const msg = raw ? this._mapMessage(raw) : await this._getDecoratedMessage(msgId);
    if (msg) this._emit("msg-sent", { chatId, msg });
    return msg;
  }

  async _waitForPreparedMessage(msgId, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const m = await this._call("get_message", this.accountId, msgId);
        // 18 = OutPreparing. Keep polling while the blob is still being copied.
        if (m.state !== 18) {
          rustLog(`sendMessage prepared id=${msgId} state=${m.state} viewType=${m.viewType}`);
          return m;
        }
      } catch (e) {
        rustLog(`sendMessage prepare poll error: ${e}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    rustLog(`sendMessage prepare timeout for id=${msgId}`);
    return null;
  }

  async getMessage(msgId) {
    const m = await this._call("get_message", this.accountId, msgId);
    return this._mapMessage(m);
  }

  async downloadFullMessage(msgId) {
    await this._call("download_full_message", this.accountId, msgId);
  }

  // Accept a contact request — unblocks the chat so it becomes a normal
  // conversation and the contact can be replied to.
  async acceptChat(chatId) {
    await this._call("accept_chat", this.accountId, chatId);
    this._invalidateChat(chatId);
    this._emit("chat-updated", { chatId: 0 });
  }

  async blockChat(chatId) {
    await this._call("block_chat", this.accountId, chatId);
    this._emit("chat-updated", { chatId: 0 });
  }

  async markRead(chatId) {
    try {
      const ids = this.msgIdCache.get(chatId)
        || await this._call("get_message_ids", this.accountId, chatId, false, false);
      if (ids?.length) await this._call("markseen_msgs", this.accountId, ids.slice(-50));
    } catch { /* nothing to mark */ }
    this._emit("chat-updated", { chatId });
  }

  async deleteMessages(chatId, ids) {
    await this._call("delete_messages", this.accountId, ids);
    const cache = this.msgIdCache.get(chatId);
    if (cache) this.msgIdCache.set(chatId, cache.filter(id => !ids.includes(id)));
    this._emit("msgs-deleted", { chatId, ids });
    this._emit("chat-updated", { chatId });
  }

  async starMessages(chatId, ids) {
    await this._call("save_msgs", this.accountId, ids);
    this._emit("chat-updated", { chatId });
  }

  async forwardMessages(fromChatId, ids, toChatId) {
    await this._call("forward_messages", this.accountId, ids, toChatId);
    this._emit("chat-updated", { chatId: toChatId });
  }

  async addReaction(chatId, msgId, emoji) {
    await this._call("send_reaction", this.accountId, msgId, [emoji]);
    const m = await this._getDecoratedMessage(msgId);
    if (m) this._emit("msg-updated", { chatId, msg: m });
  }

  async setChatFlags(chatId, { pinned, muted, archived }) {
    if (pinned !== undefined || archived !== undefined) {
      const visibility = archived ? "Archived" : pinned ? "Pinned" : "Normal";
      await this._call("set_chat_visibility", this.accountId, chatId, visibility);
    }
    if (muted !== undefined) {
      await this._call("set_chat_mute_duration", this.accountId, chatId, muted ? "Forever" : "NotMuted");
    }
    this._emit("chat-updated", { chatId });
  }

  async createChat(name, contactIds, kind = "group") {
    let chatId;
    if (kind === "single") {
      chatId = await this._call("create_chat_by_contact_id", this.accountId, contactIds[0]);
    } else {
      chatId = await this._call("create_group_chat", this.accountId, name, false);
      for (const cid of contactIds) {
        await this._call("add_contact_to_chat", this.accountId, chatId, cid);
      }
    }
    this._emit("chat-updated", { chatId });
    return chatId;
  }

  // --- onboarding: configure the account (not in MockCore) ---
  async configureWithCredentials(addr, password) {
    await this._call("add_transport", this.accountId, { addr, password });
    this._emit("chat-updated", { chatId: 0 });
  }

  async configureWithQr(qrContent) {
    // Account creation involves network round trips + key generation — allow 3 min.
    await this._callWithTimeout(180000, "set_config_from_qr", this.accountId, qrContent);
    // The account was unconfigured when init() started IO, so start it now.
    await this._call("start_io", this.accountId);
  }

  async startIo() {
    await this._call("start_io", this.accountId);
  }

  // Group members as mapped contacts (empty list for 1:1 chats).
  async getChatMembers(chatId) {
    const full = await this._call("get_full_chat_by_id", this.accountId, chatId);
    // Keep self (ContactId::SELF = 1) so the member count and list include
    // this account; only skip the other reserved ids (info, archived link, …).
    const ids = (full.contactIds || []).filter(id => id > 9 || id === 1);
    if (!ids.length) return [];
    const byId = await this._call("get_contacts_by_ids", this.accountId, ids);
    return ids.map(id => byId[String(id)]).filter(Boolean).map(c => this._mapContact(c));
  }

  // SecureJoin invite QR for this account (chatId=null) or a group chat.
  // Returns { text, svg, link } — the core renders the SVG itself.
  async getInviteQr(chatId = null) {
    const [text, svg] = await this._call("get_chat_securejoin_qr_code_svg", this.accountId, chatId);
    return { text, svg, link: text };
  }

  // Join a 1:1 or group chat from an i.delta.chat invite link / QR text.
  // The handshake runs in background; returns the chat to open.
  async secureJoin(qr) {
    const chatId = await this._call("secure_join", this.accountId, qr);
    this._invalidateChat(0);
    return chatId;
  }

  // Add a profile from a dcaccount: / relay invite link.
  // Configures the current account if it's still empty, otherwise creates
  // a new account on the relay and switches to it.
  async addAccountWithQr(qrContent) {
    if (!/^dcaccount:/i.test(qrContent) && !/^https?:\/\//i.test(qrContent)) {
      throw new Error("not a relay invite link");
    }
    const acc = await this._call("get_account_info", this.accountId);
    if (acc.kind === "Unconfigured") {
      await this._callWithTimeout(180000, "set_config_from_qr", this.accountId, qrContent);
    } else {
      const newId = await this._call("add_account");
      await this._call("select_account", newId);
      this.accountId = newId;
      await this._callWithTimeout(180000, "set_config_from_qr", newId, qrContent);
      await this._call("start_io", newId);
      this.msgIdCache.clear();
    }
    this._emit("chat-updated", { chatId: 0 });
    return this.accountId;
  }
}
