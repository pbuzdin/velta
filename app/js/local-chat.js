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
};

function peer(id, name) {
  let p = store.peers.get(id);
  if (!p) {
    p = { id, name: name || `Device ${id.slice(-4)}`, msgs: [], unread: 0, online: false };
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
    id: m.id, chatId: P2P_PREFIX + p.id, kind: "msg",
    viewtype: m.file ? viewtypeFor(m.file.name, m.file.mime) : "text",
    from: m.out ? 1 : 0, text: m.text, ts: m.ts,
    state: m.out ? (m.acked ? "read" : "sent") : "read",
    fromContact: { name: m.out ? "" : p.name, color: colorFor(p.name) },
    starred: false, edited: false, quote: null, reactions: null, fwdFrom: null,
    filePath: null, fileName: null, fileSize: null, fileMime: null,
    downloadState: "Done",
  };
  if (m.file) {
    base.filePath = m.file.path;
    base.fileName = m.file.name;
    base.fileSize = m.file.size || null;
    base.fileMime = m.file.mime || null;
  }
  return base;
}

function mapChat(p) {
  const last = p.msgs[p.msgs.length - 1];
  return {
    id: P2P_PREFIX + p.id, name: p.name, kind: "single",
    lastMsg: last ? (last.file ? "📎 " + last.file.name : last.text) : "",
    lastTs: last ? last.ts : 0,
    lastFrom: last ? (last.out ? 1 : 0) : 0,
    lastState: last && last.out ? (last.acked ? "read" : "sent") : null,
    unread: p.unread, encrypted: false, verified: false,
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
  peer("sim-1", SIM_PEERS[0].name).msgs.push(
    { id: nowId(), ts: Date.now() - 60_000, text: "hey! this message went straight over the Wi-Fi — no relay in between", out: false, acked: true },
  );
  peer("sim-2", SIM_PEERS[1].name);
}

async function simSend(peerId, text) {
  setTimeout(() => {
    const replies = SIM_REPLIES;
    incoming(peerId, replies[Math.floor(Math.random() * replies.length)], Date.now());
  }, 900);
}

// Hub card model: device identity + paired peers + nearby discoveries.
export async function hubModel() {
  if (!isEnabled()) return null;
  if (!isTauri()) {
    simInit();
    return {
      device: SIM_DEVICE,
      peers: [...store.peers.values()].map(p => mapChat(p)),
      nearby: SIM_NEARBY,
    };
  }
  const st = await invoke()("p2p_status").catch(() => null);
  if (!st) return null;
  return {
    device: { name: st.name || "device", nodeId: st.nodeId || "" },
    peers: (st.peers || []).map(p => ({
      id: P2P_PREFIX + p.id, name: p.name || p.id.slice(0, 12),
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
    if (d.kind === "message") {
      const p = peer(d.peerId);
      // Skip echoes of our own sends (the engine emits outgoing messages too).
      if (p.msgs.some(m => m.engineId === d.id)) return;
      p.msgs.push({
        id: nowId(), engineId: d.id, ts: d.ts || Date.now(), text: d.text, out: false, acked: true,
        file: d.file || null,
      });
      p.unread++;
      p.online = true;
      emitChanged();
    } else if (d.kind === "ack") {
      const p = store.peers.get(d.peerId);
      const m = p?.msgs.slice().reverse().find(x => x.out && x.engineId === d.id);
      if (m && !m.acked) { m.acked = true; emitChanged(); }
    } else if (d.kind === "presence") {
      peer(d.peerId).online = !!d.online;
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
        return [...list, ...chats];
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
      return async (t, id, { text = "", viewtype = "text", file = null, filename = null } = {}) => {
        if (!String(id).startsWith(P2P_PREFIX)) return t.sendMessage(id, { text, viewtype, file, filename });
        const peerId = String(id).slice(P2P_PREFIX.length);
        const p = peer(peerId);

        // Media: hand the already-picked file to the engine's transfer, or
        // simulate one in the no-shell preview.
        if (file) {
          const name = filename || String(file).split(/[\/]/).pop() || "file";
          if (isTauri()) {
            const res = await invoke()("p2p_send_file", { peerId, path: file, name })
              .catch(err => { throw new Error(String(err?.message || err)); });
            const msg = {
              id: res.id, engineId: res.id, ts: Date.now(), text, out: true, acked: false,
              file: { name, size: 0, mime: "", path: res.path },
            };
            p.msgs.push(msg);
            return mapMsg(p, msg);
          }
          const SAMPLE = "icons/v-logo.svg";
          const msg = {
            id: nowId(), ts: Date.now(), text, out: true, acked: true,
            file: { name: SAMPLE.split("/").pop(), size: 9155, mime: "image/svg+xml", path: SAMPLE },
          };
          p.msgs.push(msg);
          setTimeout(() => incomingFile(peerId, "icons/icon-192.png", 24564, "image/png"), 1400);
          return mapMsg(p, msg);
        }

        const msg = { id: nowId(), engineId: null, ts: Date.now(), text, out: true, acked: false };
        p.msgs.push(msg);
        if (isTauri()) {
          invoke()("p2p_send", { peerId, text }).then((engineId) => {
            if (engineId) msg.engineId = engineId;
            msg.acked = true; // single ack model for now; refine with delivery receipts
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
    // errors reaching the real core with a string id.
    case "deleteMessages":
    case "setChatFlags":
    case "resendMessage":
    case "downloadFullMessage":
      return async (t, id) => {
        if (String(id).startsWith(P2P_PREFIX)) return;
        return t[prop](id);
      };

    default:
      return pass;
  }
}

function toast(text) {
  import("./ui.js").then(m => m.toast(text)).catch(() => {});
}
