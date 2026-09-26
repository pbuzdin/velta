// local-chat.js — Phase 1: P2P peers rendered as regular chats.
//
// A Proxy wrapper around whatever core object the app booted with (JsonRpc,
// MockCore, …). When local chat is enabled, peer devices surface in the chat
// list and open in the normal chat view; text messages ride the existing
// p2p_send/p2p_messages commands, or an in-page simulator when there is no
// Tauri shell (dev preview). Media over P2P is phase 2 — sendMessage rejects
// it cleanly for now.

const P2P_PREFIX = "p2p:";

const isEnabled = () => {
  try { return localStorage.getItem("velta-p2p") === "1"; } catch { return false; }
};
const isTauri = () => {
  const t = window.__TAURI__;
  return !!(t && (t.core?.invoke || t.invoke));
};
const invoke = () => {
  const t = window.__TAURI__;
  return t.core?.invoke || t.invoke;
};

function colorFor(name) {
  let h = 0;
  for (const ch of String(name || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

// ---------------- peer/message store (adapter state) ----------------

const store = {
  peers: new Map(), // peerId -> { id, name, msgs: [], unread, online }
  listeners: [],
  seeded: false,
  simName: "This browser",
};

// ---- device + peer management (engine commands in the shell, store in sim) ----

export async function renameDevice(name) {
  name = String(name || "").trim();
  if (!name) throw new Error("name must not be empty");
  if (isTauri()) await invoke()("p2p_set_name", { name });
  else store.simName = name;
  return name;
}

export async function removePeer(peerId) {
  if (isTauri()) await invoke()("p2p_remove_peer", { peerId });
  store.peers.delete(peerId);
  emitChanged();
}

function peer(id, name) {
  let p = store.peers.get(id);
  if (!p) {
    p = { id, name: name || `Device ${id.slice(-4)}`, msgs: [], unread: 0, online: false, queue: [] };
    store.peers.set(id, p);
  }
  if (name) p.name = name;
  return p;
}

// Numeric ids (offset base, no collision with core ids): the chat view's
// "append only new" tail refetch compares message ids with >, which silently
// drops everything when ids aren't numbers.
let msgSeq = 0;
const nowId = () => 1_000_000_000 + ++msgSeq;

function viewtypeFor(name, mime = "") {
  const ext = (name || "").split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "ogg", "opus", "wav", "flac"].includes(ext)) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function mapMsg(p, m) {
  const base = {
    id: m.id, engineId: m.engineId ?? null, chatId: P2P_PREFIX + p.id, kind: "msg",
    viewtype: m.file ? viewtypeFor(m.file.name, m.file.mime) : "text",
    from: m.out ? 1 : 0, text: m.text, ts: m.ts,
    state: m.out ? (m.failed ? "failed" : m.acked ? "read" : m.queued ? "pending" : "sent") : "read",
    fromContact: { name: m.out ? "" : p.name, color: colorFor(p.name) },
    starred: false, edited: false, quote: null, reactions: null, fwdFrom: null,
    filePath: null, fileName: null, fileSize: null, fileMime: null,
    downloadState: "Done",
  };
  if (m.reply_to) {
    const orig = p.msgs.find(x => x.id === m.reply_to);
    const author = orig ? (orig.out ? "You" : p.name) : p.name;
    base.quote = {
      id: m.reply_to,
      text: m.reply_text ?? (orig ? orig.text : ""),
      fromContact: { name: author, color: colorFor(author) },
    };
  }
  if (m.file) {
    base.filePath = m.file.path;
    base.fileName = m.file.name;
    base.fileSize = m.file.size || null;
    base.fileMime = m.file.mime || null;
  }
  if (m.transfer) base.transfer = m.transfer;
  if (m.queued) base.queued = true;
  return base;
}

function mapChat(p) {
  const last = p.msgs[p.msgs.length - 1];
  return {
    id: P2P_PREFIX + p.id, name: p.name, kind: "single", isP2p: true,
    lastMsg: last ? (last.file ? "📎 " + last.file.name : last.text) : "",
    lastTs: last ? last.ts : 0,
    lastFrom: last ? (last.out ? 1 : 0) : 0,
    lastState: last && last.out ? (last.acked ? "read" : last.queued ? "pending" : "sent") : null,
    unread: p.unread, encrypted: false, verified: false,
    pinned: p.msgs.length > 0,
    avatarColor: colorFor(p.name),
  };
}

function emitChanged() {
  core()?.dispatchEvent?.(new CustomEvent("msgs-changed", { detail: {} }));
}

// Called by the engine bridge / simulator whenever a message arrives.
function incoming(peerId, text, ts = Date.now()) {
  const p = peer(peerId);
  p.msgs.push({ id: nowId(), ts, text, out: false, acked: true });
  p.unread++;
  emitChanged();
}

// Simulator-only: an inbound media message (path is a page-served asset).
function incomingFile(peerId, path, size, mime, ts = Date.now()) {
  const p = peer(peerId);
  p.msgs.push({
    id: nowId(), ts, text: "", out: false, acked: true,
    file: { name: path.split("/").pop(), size, mime, path },
  });
  p.unread++;
  emitChanged();
}

// ---------------- simulator (no Tauri shell: dev preview) ----------------

const SIM_PEERS = [
  { id: "sim-1", name: "Ada (local)" },
  { id: "sim-2", name: "Kenji (local)" },
];
const SIM_DEVICE = { name: "This browser", nodeId: "sim0demo0node" };
const SIM_NEARBY = [
  { id: "nb-1", name: "Studio TV" },
  { id: "nb-2", name: "Pixel tablet" },
];
const SIM_REPLIES = [
  "got it 👍", "on the same network? speeds look great", "no servers involved — nice",
  "let's compare notes in a bit", "works offline too, tested in airplane mode",
];

function simInit() {
  if (store.seeded) return;
  store.seeded = true;
  const ada = peer("sim-1", SIM_PEERS[0].name);
  ada.online = true;
  ada.msgs.push(
    { id: nowId(), ts: Date.now() - 60_000, text: "hey! this message went straight over the Wi-Fi — no relay in between", out: false, acked: true },
  );
  peer("sim-2", SIM_PEERS[1].name); // offline until its presence event fires
}

async function simSend(peerId, text) {
  setTimeout(() => {
    const replies = SIM_REPLIES;
    incoming(peerId, replies[Math.floor(Math.random() * replies.length)], Date.now());
  }, 900);
}

// ---- queue tray API (offline media queuing) ----

// Queued (unsent) media items for a local chat, oldest first.
export function lcQueueItems(chatId) {
  if (!String(chatId).startsWith(P2P_PREFIX)) return [];
  const p = store.peers.get(String(chatId).slice(P2P_PREFIX.length));
  return p ? (p.queue || []).map(q => ({ id: q.id, name: q.name, size: q.size || null, caption: q.caption || "" })) : [];
}

// Retry a queued item now. In the simulator this always succeeds; with the
// real engine it re-invokes p2p_send_file (which still requires the peer).
export async function retryQueuedItem(chatId, itemId) {
  const peerId = String(chatId).slice(P2P_PREFIX.length);
  const p = store.peers.get(peerId);
  const item = p?.queue.find(x => x.id === itemId);
  if (!item) return;
  if (isTauri()) {
    const res = await invoke()("p2p_send_file", { peerId, path: item.path, name: item.name, caption: item.caption })
      .catch(err => { throw new Error(String(err?.message || err)); });
    p.queue = p.queue.filter(x => x.id !== itemId);
    const msg = {
      id: res.id, engineId: res.id, ts: item.ts, text: item.caption, out: true, acked: false,
      file: { name: item.name, size: item.size || 0, mime: item.mime || "", path: res.path },
    };
    p.msgs.push(msg);
  } else {
    p.queue = p.queue.filter(x => x.id !== itemId);
    p.msgs.push({
      id: nowId(), ts: Date.now(), text: item.caption, out: true, acked: true,
      file: { name: item.name, size: item.size || 0, mime: item.mime || "", path: item.path },
    });
  }
  emitChanged();
}

export function cancelQueuedItem(chatId, itemId) {
  const peerId = String(chatId).slice(P2P_PREFIX.length);
  const p = store.peers.get(peerId);
  if (p) p.queue = (p.queue || []).filter(x => x.id !== itemId);
  emitChanged();
}

// Retry an interrupted (failed) transfer: re-sends the stored copy of the
// file from byte zero (no resume) and swaps the failed message for the new
// one. The old message only leaves the store once the engine accepted the
// re-send — on failure it comes back, still showing its Retry button.
export async function lcRetryTransfer(chatId, msgId) {
  const peerId = String(chatId).slice(P2P_PREFIX.length);
  const p = store.peers.get(peerId);
  const msg = p?.msgs.find(x => x.id === msgId);
  if (!msg) return;
  if (!isTauri()) { delete msg.transfer; emitChanged(); return; } // sim preview: no real transfers
  const file = msg.file || {};
  if (!file.path) throw new Error("original file is gone");
  p.msgs = p.msgs.filter(x => x.id !== msgId);
  try {
    const res = await invoke()("p2p_send_file", { peerId, path: file.path, name: file.name || "file", caption: msg.text || "" });
    p.msgs.push({
      id: res.id, engineId: res.id, ts: Date.now(), text: msg.text || "", out: true, acked: false,
      file: { name: file.name || "file", size: file.size || 0, mime: file.mime || "", path: res.path },
    });
  } catch (err) {
    p.msgs.push(msg); // still offline — restore the failed card
    emitChanged();
    throw err;
  }
  emitChanged();
}

// Sends queued media when a peer comes back online, oldest first.
// Sequential: stop at the first failure — the peer may drop again mid-flush
// and the rest stay queued for the next presence event.
async function flushQueue(chatId) {
  for (const item of lcQueueItems(chatId)) {
    try { await retryQueuedItem(chatId, item.id); }
    catch { return; }
  }
}

// Hub card model: device identity + paired peers + nearby discoveries.
export async function hubModel() {
  if (!isEnabled()) return null;
  if (!isTauri()) {
    simInit();
    return {
      device: { name: store.simName || SIM_DEVICE.name, nodeId: SIM_DEVICE.nodeId },
      peers: [...store.peers.values()].map(p => ({ ...mapChat(p), rawId: p.id })),  // sim store keys are raw
      nearby: SIM_NEARBY,
    };
  }
  const st = await invoke()("p2p_status").catch(() => null);
  if (!st) return null;
  return {
    device: { name: st.name || "device", nodeId: st.nodeId || "" },
    peers: (st.peers || []).map(p => ({
      id: P2P_PREFIX + p.id, rawId: p.id, name: p.name || p.id.slice(0, 12),
      online: !!p.online, queued: p.queued || 0,
    })),
    nearby: st.nearby || [],
  };
}

// ---------------- engine bridge (real Tauri shell) ----------------

let engineHooked = false;

function engineInit() {
  if (engineHooked || !isTauri()) return;
  engineHooked = true;
  const listen = window.__TAURI__.event?.listen || window.__TAURI__.listen;
  listen?.("p2p-event", (ev) => {
    const d = ev?.payload || {};
    if (d.kind === "file-progress") {
      const p = peer(d.peerId);
      const msg = p.msgs.find(x => x.id === d.id || x.engineId === d.id);
      if (!msg) return;
      if (d.failed) {
        // Session died mid-transfer; there is no resume — the bubble shows a
        // Retry button (lcRetryTransfer re-sends from byte zero).
        msg.transfer = { failed: true, pct: msg.transfer?.pct || 0, dir: d.dir };
        emitChanged();
        return;
      }
      if (d.done) {
        delete msg.transfer; // swap the bar for the finished file card
        emitChanged();
        return;
      }
      if (d.size && msg.file && !msg.file.size) msg.file.size = d.size;
      const pct = d.size ? Math.min(100, Math.floor(d.got / d.size * 100)) : 0;
      // Re-render only on 2% steps — chunks arrive in rapid bursts.
      if (!msg.transfer || pct - (msg.transfer.pct || 0) >= 2 || pct >= 100) {
        msg.transfer = { pct, dir: d.dir };
        emitChanged();
      }
    } else if (d.kind === "message") {
      const p = peer(d.peerId);
      // Skip echoes of our own sends (the engine emits outgoing messages too).
      if (p.msgs.some(m => m.engineId === d.id)) return;
      p.msgs.push({
        id: nowId(), engineId: d.id, ts: d.ts || Date.now(), text: d.text, out: false, acked: true,
        reply_to: d.reply_to || null,
        reply_text: d.reply_text || null,
        file: d.file || null,
      });
      p.unread++;
      p.online = true;
      emitChanged();
    } else if (d.kind === "ack") {
      const p = store.peers.get(d.peerId);
      const m = p?.msgs.slice().reverse().find(x => x.out && x.engineId === d.id);
      if (m && !m.acked) { m.acked = true; emitChanged(); }
    } else if (d.kind === "msg-state") {
      // A text queued while the peer was offline went out on reconnect.
      const p = store.peers.get(d.peerId);
      const m = p?.msgs.find(x => x.engineId === d.id);
      if (m && m.queued) { delete m.queued; emitChanged(); }
    } else if (d.kind === "presence") {
      const p = peer(d.peerId);
      const wentOnline = !!d.online && !p.online;
      p.online = !!d.online;
      if (wentOnline && (p.queue || []).length) {
        flushQueue(P2P_PREFIX + p.id); // async, stops on first failure
      }
      emitChanged();
    }
  }).catch?.(() => {});
}

async function enginePeers() {
  const st = await invoke()("p2p_status").catch(() => null);
  if (!st) return [];
  return (st.peers || []).map(p => ({ id: p.id, name: p.name }));
}

// ---------------- core wrapper ----------------

let wrappedCore = null;
const core = () => wrappedCore;

const P2P_HANDLED = new Set([
  "getChatList", "getChat", "getMessages", "getMessage", "sendMessage",
  "markRead", "deleteMessages", "setChatFlags", "resendMessage", "downloadFullMessage",
]);

export function withLocalChat(inner) {
  wrappedCore = inner;
  engineInit();
  return new Proxy(inner, {
    get(target, prop) {
      if (P2P_HANDLED.has(prop)) {
        const fn = handler(prop);
        return (...args) => fn(target, ...args);
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function handler(prop) {
  const pass = (t, ...a) => t[prop](...a);
  if (!isEnabled()) return pass; // toggle off → everything falls through

  switch (prop) {
    case "getChatList":
      return async (t, opts = {}) => {
        const list = await t.getChatList(opts);
          if (!isTauri()) simInit();
          let peers = [...store.peers.values()];
          if (isTauri()) {
            try {
              for (const p of await enginePeers()) { peer(p.id, p.name); }
              peers = [...store.peers.values()];
            } catch {}
          }
          const q = (opts.query || "").trim().toLowerCase();
          const chats = peers
            .map(mapChat)
            .filter(c => !q || c.name.toLowerCase().includes(q));
        // pinned local chats float above everything; the stable sort keeps
        // the core's own ordering (incl. core-pinned chats) below them.
        return [...list, ...chats].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      };

    case "getChat":
      return async (t, id) => {
        if (!String(id).startsWith(P2P_PREFIX)) return t.getChat(id);
        const p = store.peers.get(String(id).slice(P2P_PREFIX.length));
        if (!p) return null;
        return { ...mapChat(p), isP2p: true };
      };

    case "getMessages":
      return async (t, id, opts = {}) => {
        if (!String(id).startsWith(P2P_PREFIX)) return t.getMessages(id, opts);
        const p = store.peers.get(String(id).slice(P2P_PREFIX.length));
        const msgs = p ? p.msgs.map(m => mapMsg(p, m)) : [];
        return { messages: msgs, hasMore: false };
      };

    case "getMessage":
      return async (t, id) => {
        for (const p of store.peers.values()) {
          const m = p.msgs.find(x => x.id === id);
          if (m) return mapMsg(p, m);
        }
        return t.getMessage(id);
      };

    case "sendMessage":
      return async (t, id, { text = "", viewtype = "text", file = null, filename = null, quoteId = null, quoteText = null } = {}) => {
        if (!String(id).startsWith(P2P_PREFIX)) return t.sendMessage(id, { text, viewtype, file, filename, quoteId, quoteText });
        const peerId = String(id).slice(P2P_PREFIX.length);
        const p = peer(peerId);

        // Media: hand the already-picked file to the engine's transfer, or
        // simulate one in the no-shell preview.
        if (file) {
          const name = filename || String(file).split(/[\/]/).pop() || "file";
          const viewtype = viewtypeFor(name);
          if (isTauri()) {
            if (p.online === false) {
              // Offline: queue the file — the tray sends it when the peer
              // is back on the network.
              const item = { id: nowId(), path: file, name, caption: text, ts: Date.now() };
              p.queue.push(item);
              const msg = {
                id: item.id, ts: item.ts, text, out: true, acked: false, queued: true,
                file: { name, size: null, mime: "", path: null },
              };
              p.msgs.push(msg);
              emitChanged();
              return mapMsg(p, msg);
            }
            const res = await invoke()("p2p_send_file", { peerId, path: file, name, caption: text })
              .catch(err => { throw new Error(String(err?.message || err)); });
            const msg = {
              id: res.id, engineId: res.id, ts: Date.now(), text, out: true, acked: false,
              file: { name, size: 0, mime: "", path: res.path },
            };
            p.msgs.push(msg);
            return mapMsg(p, msg);
          }
          if (p.online === false) {
            // Offline simulator peer: park the file in the queue tray.
            const item = { id: nowId(), name: "v-logo.svg", caption: text, path: SAMPLE, size: 9155, mime: "image/svg+xml" };
            p.queue.push(item);
            const msg = {
              id: nowId(), ts: Date.now(), text, out: true, acked: false, queued: true,
              file: { name: item.name, size: item.size, mime: item.mime, path: null },
            };
            p.msgs.push(msg);
            emitChanged();
            return mapMsg(p, msg);
          }
          const msg = {
            id: nowId(), ts: Date.now(), text, out: true, acked: true,
            file: { name: SAMPLE.split("/").pop(), size: 9155, mime: "image/svg+xml", path: SAMPLE },
          };
          p.msgs.push(msg);
          setTimeout(() => incomingFile(peerId, "icons/icon-192.png", 24564, "image/png"), 1400);
          return mapMsg(p, msg);
        }

        const msg = {
          id: nowId(), engineId: null, ts: Date.now(), text, out: true, acked: false,
          reply_to: quoteId, reply_text: quoteText,
        };
        p.msgs.push(msg);
        if (isTauri()) {
          invoke()("p2p_send", { peerId, text, replyTo: quoteId, replyText: quoteText }).then((res) => {
            msg.engineId = res.id;
            if (res.queued) {
              // Engine holds it until the peer reconnects — bubble shows a
              // pending clock, upgraded to ticks by the msg-state/ack events.
              msg.queued = true;
            } else {
              msg.acked = true; // single ack model for now; refine with delivery receipts
            }
            emitChanged();
          }).catch(err => { msg.failed = true; toast(String(err?.message || err)); });
        } else {
          msg.acked = true;
          simSend(peerId, text);
        }
        return mapMsg(p, msg);
      };

    case "markRead":
      return async (t, id) => {
        if (!String(id).startsWith(P2P_PREFIX)) return t.markRead(id);
        const p = store.peers.get(String(id).slice(P2P_PREFIX.length));
        if (p) p.unread = 0;
      };

    // Phase-1 scope: these actions are no-ops on local chats rather than
    // errors reaching the real core with a string id. Relay chats fall
    // through with ALL arguments — dropping them called
    // deleteMessages(chatId) with ids undefined, which hit the core as
    // delete_messages(account, null) → "invalid type: null, expected a
    // sequence" (every message deletion broke while local chat was on).
    case "deleteMessages":
    case "setChatFlags":
    case "downloadFullMessage":
      return async (t, id, ...rest) => {
        if (String(id).startsWith(P2P_PREFIX)) return;
        return t[prop](id, ...rest);
      };

    // Retry a failed text: swap the failed bubble for a fresh engine send
    // (same text and quote). On failure the failed bubble is restored —
    // same contract as lcRetryTransfer. Relay chats fall through.
    case "resendMessage":
      return async (t, id) => {
        for (const p of store.peers.values()) {
          const m = p.msgs.find(x => x.id === id && x.out && x.failed);
          if (!m) continue;
          if (!isTauri()) { // sim preview: no real sends to fail
            p.msgs = p.msgs.map(x => x.id === id ? { ...x, failed: false, acked: true } : x);
            emitChanged();
            return;
          }
          p.msgs = p.msgs.filter(x => x.id !== id);
          try {
            const res = await invoke()("p2p_send", { peerId: p.id, text: m.text || "", replyTo: m.reply_to ?? null, replyText: m.reply_text ?? null });
            const fresh = { id: nowId(), engineId: res.id, ts: Date.now(), text: m.text || "", out: true, acked: !res.queued };
            if (res.queued) fresh.queued = true;
            if (m.reply_to != null) { fresh.reply_to = m.reply_to; fresh.reply_text = m.reply_text ?? null; }
            p.msgs.push(fresh);
          } catch (err) {
            p.msgs.push(m); // still offline / unknown peer — the Retry button comes back
            emitChanged();
            throw err;
          }
          emitChanged();
          return;
        }
        return t.resendMessage(id);
      };

    default:
      return pass;
  }
}

function toast(text) {
  import("./ui.js").then(m => m.toast(text)).catch(() => {});
}
