// mock-core.js — simulates the deltachat-rpc-server JSON-RPC API (chatmail core).
// Swap `MockCore` for a real stdio/WebSocket transport speaking the same
// method names (get_all_accounts, get_chatlist_entries, get_message_ids, ...)
// to run against the real core.

const CONTACTS = [
  { id: 2, name: "Ada Byron", addr: "ada@nine.testrun.org", color: "#c6853f", online: true, verified: true },
  { id: 3, name: "Kenji Sato", addr: "kenji@nine.testrun.org", color: "#3f8fc6", online: false, lastSeen: Date.now() - 32 * 60000, verified: false },
  { id: 4, name: "Mara Voss", addr: "mara@nine.testrun.org", color: "#6a5acd", online: true, verified: true },
  { id: 5, name: "Tariq Aziz", addr: "tariq@nine.testrun.org", color: "#4fae4f", online: false, lastSeen: Date.now() - 5 * 3600000, verified: false },
  { id: 6, name: "Lena Fischer", addr: "lena@nine.testrun.org", color: "#c65a8e", online: true, verified: false },
  { id: 7, name: "Delta Bot", addr: "bot@nine.testrun.org", color: "#7d8a99", online: true, verified: true, bot: true },
];

const LOREM = [
  "hey! did you see the new chatmail relay release?",
  "Yes!! message delivery is basically instant now 🚀",
  "Can you forward me the design doc when you get a chance?",
  "On my way, give me 10 minutes",
  "The nice thing is it's just email underneath — no phone number needed",
  "Exactly. Any SMTP server works, but chatmail relays are way faster",
  "lunch later? there's a new place near the office",
  "sure, 12:30 works for me",
  "I tested the webxdc app you sent, works flawlessly offline",
  "Check out this photo from the weekend hike",
  "voice messages on the train are a lifesaver honestly",
  "The group is getting big — should we pin the roadmap?",
  "Good idea, done 📌",
  "remember: everything here is end-to-end encrypted by default 🔒",
  "I sent the file, it's about 4 MB",
  "got it, thanks!",
  "see you tomorrow then 👋",
  "Haha that's perfect 😂",
  "Let me know when the APK build finishes",
  "CI passed, merging now ✅",
  "btw the sticker pack you made is amazing",
  "Ok final answer: we ship on Friday",
  "Can't believe how fast the sync is across devices now",
  "Multi-device just works — same account everywhere via relays",
];

const IMG_GRADIENTS = [
  "linear-gradient(135deg,#e96443,#904e95)",
  "linear-gradient(135deg,#396afc,#2948ff)",
  "linear-gradient(135deg,#11998e,#38ef7d)",
  "linear-gradient(135deg,#fc4a1a,#f7b733)",
  "linear-gradient(135deg,#8e2de2,#4a00e0)",
];

const REACTION_SET = ["👍", "❤️", "😂", "🎉", "😮", "👏"];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockCore extends EventTarget {
  constructor() {
    super();
    const rnd = mulberry32(20260808);
    this.rnd = rnd;
    this.account = {
      id: 1, addr: "you@nine.testrun.org", displayName: "You",
      color: "#5aa2e6", bio: "Delta Web user",
      relay: "nine.testrun.org",
    };
    this.contacts = CONTACTS;
    this.msgSeq = 0;
    this._buildChats();
    this._simulateIncoming();
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  _buildChats() {
    const rnd = this.rnd;
    const now = Date.now();
    const mk = (over) => Object.assign({
      id: 0, name: "", kind: "single", contactId: null, memberCount: 0,
      pinned: false, muted: false, archived: false, verified: false,
      unread: 0, draft: null, encrypted: true, messages: [],
    }, over);

    this.chats = [
      mk({ id: 10, kind: "saved", name: "Saved Messages" }),
      mk({ id: 11, kind: "device", name: "Device Messages" }),
      mk({ id: 12, name: "Ada Byron", contactId: 2, pinned: true, verified: true, unread: 2 }),
      mk({ id: 13, name: "Weekend Crew 🏕", kind: "group", memberCount: 6, pinned: true, unread: 14 }),
      mk({ id: 14, name: "Kenji Sato", contactId: 3, muted: true, unread: 5 }),
      mk({ id: 15, name: "Delta Web Devs", kind: "group", memberCount: 23, unread: 0 }),
      mk({ id: 16, name: "Mara Voss", contactId: 4 }),
      mk({ id: 17, name: "News · Delta Chat", kind: "channel", memberCount: 12800, muted: true, unread: 31 }),
      mk({ id: 18, name: "Tariq Aziz", contactId: 5, archived: true }),
      mk({ id: 19, name: "Lena Fischer", contactId: 6 }),
      mk({ id: 20, name: "Family", kind: "group", memberCount: 4, archived: true }),
      mk({ id: 21, kind: "deaddrop", name: "Contact Requests", unread: 1 }),
    ];

    // Per-chat message history. Chat 15 gets a huge history to showcase
    // the virtual scroller; others get a couple of screens worth.
    for (const chat of this.chats) {
      if (chat.kind === "deaddrop") {
        chat.messages = [this._mkMsg(chat, { from: 7, text: "unknown.sender@example.org wants to chat. Accept to move this to your chats.", ts: now - 3600e3 })];
        continue;
      }
      const count = chat.id === 15 ? 2400 : chat.id === 13 ? 240 : 36 + Math.floor(rnd() * 30);
      const span = chat.id === 15 ? 45 : 14; // days
      for (let i = 0; i < count; i++) {
        const ts = now - (rnd() * span * 86400e3);
        chat.messages.push(this._randomMsg(chat, ts));
      }
      chat.messages.sort((a, b) => a.ts - b.ts);
    }

    // A couple of concrete messages in the saved chat
    this.chats[0].messages = [
      this._mkMsg(this.chats[0], { from: 1, text: "Wi-Fi password: delta-2026!", ts: now - 86400e3 * 2, starred: true }),
      this._mkMsg(this.chats[0], { from: 1, text: "Ideas for the weekend:\n1. hike\n2. build a webxdc game\n3. sleep", ts: now - 86400e3 }),
    ];
    this.chats[1].messages = [
      this._mkMsg(this.chats[1], { kind: "service", text: "Messages are end-to-end encrypted.", ts: now - 86400e3 * 3 }),
      this._mkMsg(this.chats[1], { from: 1, text: "Welcome to Delta Web 🎉 This account is connected through the chatmail relay nine.testrun.org.", ts: now - 86400e3 * 3 + 60e3 }),
    ];
  }

  _randomMsg(chat, ts) {
    const rnd = this.rnd;
    const others = this.contacts.filter(c => !c.bot);
    const isOut = chat.kind === "channel" ? false : rnd() < 0.45;
    const from = isOut ? 1 : chat.contactId || others[Math.floor(rnd() * others.length)].id;
    const roll = rnd();
    const base = { from, ts };
    if (roll < 0.06) return this._mkMsg(chat, { ...base, viewtype: "image", text: rnd() < 0.6 ? LOREM[Math.floor(rnd() * LOREM.length)] : "", img: IMG_GRADIENTS[Math.floor(rnd() * IMG_GRADIENTS.length)] });
    if (roll < 0.09) return this._mkMsg(chat, { ...base, viewtype: "file", fileName: ["roadmap.pdf", "release-notes.md", "photo-pack.zip", "budget.ods"][Math.floor(rnd() * 4)], fileSize: 120e3 + Math.floor(rnd() * 8e6) });
    if (roll < 0.12) return this._mkMsg(chat, { ...base, viewtype: "voice", duration: 4 + Math.floor(rnd() * 48) });
    const m = this._mkMsg(chat, { ...base, text: LOREM[Math.floor(rnd() * LOREM.length)] });
    if (rnd() < 0.07 && chat.messages.length > 2) {
      const q = chat.messages[Math.floor(rnd() * chat.messages.length)];
      if (q && q.viewtype === "text") m.quote = { id: q.id, from: q.from, text: q.text };
    }
    if (rnd() < 0.08) {
      const n = 1 + Math.floor(rnd() * 2);
      m.reactions = [];
      for (let i = 0; i < n; i++) m.reactions.push({ emoji: REACTION_SET[Math.floor(rnd() * REACTION_SET.length)], count: 1 + Math.floor(rnd() * 4), mine: rnd() < 0.3 });
    }
    if (rnd() < 0.05 && isOut) m.state = rnd() < 0.5 ? "delivered" : "read";
    return m;
  }

  _mkMsg(chat, over) {
    const m = Object.assign({
      id: ++this.msgSeq,
      chatId: chat.id,
      kind: "msg",
      viewtype: "text",
      from: 1,
      text: "",
      ts: Date.now(),
      state: "read",
      starred: false,
      edited: false,
      quote: null,
      reactions: null,
      fwdFrom: null,
    }, over);
    if (m.viewtype === "voice") {
      const r = mulberry32(m.id);
      m.wave = Array.from({ length: 32 }, () => 4 + Math.floor(r() * 22));
    }
    return m;
  }

  _simulateIncoming() {
    // Live-feel: an incoming message every ~25s on the devs chat
    this._simTimer = setInterval(() => {
      const chat = this.chats.find(c => c.id === 13);
      const from = [2, 4, 6][Math.floor(Math.random() * 3)];
      const m = this._mkMsg(chat, { from, text: LOREM[Math.floor(Math.random() * LOREM.length)], ts: Date.now(), state: "received" });
      chat.messages.push(m);
      if (!chat.muted) chat.unread++;
      this._emit("incoming-msg", { chatId: chat.id, msg: m });
    }, 25000);
  }

  // ---- JSON-RPC-shaped async API ----
  async getAccount() { return structuredClone(this.account); }
  async setDisplayName(name) {
    this.account.displayName = (name || "").trim() || "You";
  }
  async getContacts() { return structuredClone(this.contacts); }

  async getChatList({ archived = false, query = "" } = {}) {
    const q = query.trim().toLowerCase();
    let list = this.chats.filter(c => !!c.archived === archived);
    if (q) list = list.filter(c => c.name.toLowerCase().includes(q));
    const rank = { saved: 3, device: 2, deaddrop: 1 };
    return list
      .map(c => {
        const last = c.messages[c.messages.length - 1];
        return {
          id: c.id, name: c.name, kind: c.kind, contactId: c.contactId,
          memberCount: c.memberCount, pinned: c.pinned, muted: c.muted,
          verified: c.verified, unread: c.unread, draft: c.draft,
          encrypted: c.encrypted, archived: c.archived,
          avatarColor: this._chatColor(c),
          lastMsg: last ? this._msgSummary(last) : null,
          lastTs: last ? last.ts : 0,
          lastState: last && last.from === 1 ? last.state : null,
          lastFrom: last ? last.from : null,
        };
      })
      .sort((a, b) => (b.pinned - a.pinned) || ((rank[b.kind] || 0) - (rank[a.kind] || 0)) || (b.lastTs - a.lastTs));
  }

  _chatColor(c) {
    if (c.kind === "saved" || c.kind === "device") return null;
    if (c.contactId) return this.contacts.find(x => x.id === c.contactId)?.color || "#888";
    const colors = ["#c6853f", "#3f8fc6", "#6a5acd", "#4fae4f", "#c65a8e", "#7d8a99"];
    return colors[c.id % colors.length];
  }

  _msgSummary(m) {
    if (m.kind === "service") return m.text;
    switch (m.viewtype) {
      case "image": return "📷 " + (m.text || "Photo");
      case "file": return "📎 " + m.fileName;
      case "voice": return "🎤 Voice message";
      default: return m.text;
    }
  }

  async getChat(chatId) {
    const c = this.chats.find(x => x.id === chatId);
    if (!c) return null;
    const contact = c.contactId ? this.contacts.find(x => x.id === c.contactId) : null;
    return {
      id: c.id, name: c.name, kind: c.kind, memberCount: c.memberCount,
      encrypted: c.encrypted, verified: c.verified, muted: c.muted,
      pinned: c.pinned, archived: c.archived, contact,
      avatarColor: this._chatColor(c),
    };
  }

  // Paged history: newest-first pages, like scrolling up through time.
  async getMessages(chatId, { beforeId = null, limit = 40 } = {}) {
    const c = this.chats.find(x => x.id === chatId);
    if (!c) return { messages: [], hasMore: false };
    let end = c.messages.length;
    if (beforeId != null) {
      const idx = c.messages.findIndex(m => m.id === beforeId);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - limit);
    const slice = c.messages.slice(start, end).map(m => this._decorate(m));
    return { messages: slice, hasMore: start > 0 };
  }

  _decorate(m) {
    const d = structuredClone(m);
    d.fromContact = m.from === 1
      ? { id: 1, name: this.account.displayName, color: this.account.color }
      : (this.contacts.find(c => c.id === m.from) || { id: m.from, name: "Unknown", color: "#888" });
    if (d.quote) d.quote.fromContact = d.quote.from === 1
      ? { name: this.account.displayName, color: this.account.color }
      : (this.contacts.find(c => c.id === d.quote.from) || { name: "Unknown", color: "#888" });
    return d;
  }

  async sendMessage(chatId, { text, quoteId = null, viewtype = "text", extra = {} }) {
    const c = this.chats.find(x => x.id === chatId);
    if (!c) throw new Error("no chat");
    let quote = null;
    if (quoteId != null) {
      const q = c.messages.find(m => m.id === quoteId);
      if (q) quote = { id: q.id, from: q.from, text: this._msgSummary(q) };
    }
    const m = this._mkMsg(c, { from: 1, text, viewtype, quote, ts: Date.now(), state: "pending", ...extra });
    c.messages.push(m);
    this._emit("msg-sent", { chatId, msg: this._decorate(m) });
    // simulate network -> delivered -> read
    setTimeout(() => { m.state = "sent"; this._emit("msg-state", { chatId, msgId: m.id, state: "sent" }); }, 350);
    setTimeout(() => { m.state = "delivered"; this._emit("msg-state", { chatId, msgId: m.id, state: "delivered" }); }, 1200);
    setTimeout(() => { m.state = "read"; this._emit("msg-state", { chatId, msgId: m.id, state: "read" }); }, 2600);
    // occasional auto-reply in single chats
    if (c.kind === "single" && Math.random() < 0.6) {
      setTimeout(() => {
        const reply = this._mkMsg(c, { from: c.contactId, text: LOREM[Math.floor(Math.random() * LOREM.length)], ts: Date.now() });
        c.messages.push(reply);
        if (!c.muted) c.unread++;
        this._emit("incoming-msg", { chatId, msg: this._decorate(reply) });
      }, 3200 + Math.random() * 3000);
    }
    return this._decorate(m);
  }

  async markRead(chatId) {
    const c = this.chats.find(x => x.id === chatId);
    if (c) { c.unread = 0; this._emit("chat-updated", { chatId }); }
  }

  async deleteMessages(chatId, ids) {
    const c = this.chats.find(x => x.id === chatId);
    if (!c) return;
    c.messages = c.messages.filter(m => !ids.includes(m.id));
    this._emit("msgs-deleted", { chatId, ids });
    this._emit("chat-updated", { chatId });
  }

  async starMessages(fromChatId, ids) {
    const src = this.chats.find(x => x.id === fromChatId);
    const saved = this.chats.find(x => x.kind === "saved");
    if (!src || !saved) return;
    for (const id of ids) {
      const m = src.messages.find(x => x.id === id);
      if (m) {
        m.starred = true;
        const copy = this._mkMsg(saved, { ...structuredClone(m), id: undefined, fwdFrom: m.from === 1 ? "You" : this._decorate(m).fromContact.name, ts: Date.now() });
        saved.messages.push(copy);
      }
    }
    this._emit("chat-updated", { chatId: fromChatId });
    this._emit("chat-updated", { chatId: saved.id });
  }

  async forwardMessages(fromChatId, ids, toChatId) {
    const src = this.chats.find(x => x.id === fromChatId);
    const dst = this.chats.find(x => x.id === toChatId);
    if (!src || !dst) return;
    for (const id of ids) {
      const m = src.messages.find(x => x.id === id);
      if (m) {
        const copy = this._mkMsg(dst, { ...structuredClone(m), id: undefined, from: 1, fwdFrom: m.from === 1 ? "You" : this._decorate(m).fromContact.name, ts: Date.now(), state: "sent", quote: null, reactions: null });
        dst.messages.push(copy);
      }
    }
    this._emit("chat-updated", { chatId: toChatId });
  }

  async addReaction(chatId, msgId, emoji) {
    const c = this.chats.find(x => x.id === chatId);
    const m = c?.messages.find(x => x.id === msgId);
    if (!m) return;
    m.reactions = m.reactions || [];
    const mine = m.reactions.find(r => r.mine);
    if (mine && mine.emoji === emoji) {
      m.reactions = m.reactions.filter(r => r !== mine);
    } else {
      if (mine) { mine.mine = false; mine.count--; if (mine.count <= 0) m.reactions = m.reactions.filter(r => r !== mine); }
      const r = m.reactions.find(x => x.emoji === emoji);
      if (r) { r.count++; r.mine = true; } else m.reactions.push({ emoji, count: 1, mine: true });
    }
    this._emit("msg-updated", { chatId, msg: this._decorate(m) });
  }

  async setChatFlags(chatId, { pinned, muted, archived }) {
    const c = this.chats.find(x => x.id === chatId);
    if (!c) return;
    if (pinned !== undefined) c.pinned = pinned;
    if (muted !== undefined) c.muted = muted;
    if (archived !== undefined) c.archived = archived;
    this._emit("chat-updated", { chatId });
  }

  async createChat(name, contactIds, kind = "group") {
    const id = 100 + this.chats.length;
    const chat = {
      id, name, kind, contactId: kind === "single" ? contactIds[0] : null,
      memberCount: contactIds.length + 1, pinned: false, muted: false,
      archived: false, verified: false, unread: 0, draft: null, encrypted: true,
      messages: [this._mkMsg({ id }, { kind: "service", text: kind === "group" ? `Group "${name}" created` : "Messages are end-to-end encrypted.", ts: Date.now() })],
    };
    this.chats.push(chat);
    this._emit("chat-updated", { chatId: id });
    return id;
  }
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatListTime(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return formatTime(ts);
  const diff = (now - d) / 86400e3;
  if (diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function formatDay(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now - 86400e3);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
