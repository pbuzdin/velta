// local-chat.js — Phase 1: P2P peers rendered as regular chats.
//
// A Proxy wrapper around whatever core object the app booted with (JsonRpc,
// MockCore, …). When local chat is enabled, peer devices surface in the chat
// list and open in the normal chat view; text messages ride the existing
// p2p_send/p2p_messages commands, or an in-page simulator when there is no
// Tauri shell (dev preview). Media over P2P is phase 2 — sendMessage rejects
// it cleanly for now.

import { typingText, SHOW_TTL_MS } from "./typing.js";

const P2P_PREFIX = "p2p:";
// Local groups (serverless group chats of up to 4 devices) live in their own
// id space: `p2pg:<gid>`. "p2pg:" does NOT start with "p2p:" (the `g` comes
// before the colon), so every `startsWith(P2P_PREFIX)` branch stays 1:1-only.
const P2PG_PREFIX = "p2pg:";
const isGroupId = id => String(id).startsWith(P2PG_PREFIX);
const gidOf = id => String(id).slice(P2PG_PREFIX.length);
// Any id that belongs to the local-chat adapter (never goes to the real core).
const isLocalId = id => String(id).startsWith(P2P_PREFIX) || isGroupId(id);

const isEnabled = () => {
  try { return localStorage.getItem("velta-p2p") === "1"; } catch { return false; }
};
// "Show and send typing hints" — default on; off means neither direction.
export const typingEnabled = () => {
  try { return localStorage.getItem("velta-p2p-typing") !== "0"; } catch { return true; }
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
  // gid -> { id, name, creator, epoch, closed, removed, canManage, members:
  //   [{id,name,self,online,introduced}], msgs: [], unread, acks: Map(nodeId ->
  //   highest own seq that member acknowledged), createdTs }
  groups: new Map(),
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
  if (isTauri()) {
    await invoke()("p2p_remove_peer", { peerId });
    // Groups the removed device created were deleted with it.
    pruneGroups(await engineGroups());
  }
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

// ---- history hydration (engine -> adapter store) ----
//
// The adapter store is memory-only; the engine keeps the real history in
// messages-<id>.jsonl. Without this a `p2p:` chat opened EMPTY after every app
// restart. Each peer is hydrated once per page lifetime (p2p_messages); a
// failed attempt (engine still starting, unknown peer) is not remembered, so
// the next call retries. Engine rows get fresh NUMERIC ids (1e9+seq, never the
// engine's string ids: the chat view's "append only new" filter compares ids
// with >) and keep the engine id in `engineId`, which is also how a live event
// that raced the hydration is de-duplicated.
const HYDRATE_LIMIT = 500;

function histFromEngine(r) {
  const out = r.dir === "out";
  const m = {
    id: nowId(), engineId: r.id, ts: r.ts || Date.now(), text: r.text || "",
    out, acked: out ? r.state === "acked" : true,
  };
  if (out && r.state === "queued") m.queued = true;
  if (r.reply_to) { m.reply_to = r.reply_to; m.reply_text = r.reply_text ?? null; }
  if (r.file) m.file = { name: r.file.name, size: r.file.size || 0, mime: r.file.mime || "", path: r.file.path };
  return m;
}

function mergeHistory(p, rows) {
  const known = new Set();
  for (const m of p.msgs) if (m.engineId != null) known.add(m.engineId);
  const hist = [];
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || known.has(r.id)) continue;
    known.add(r.id);
    const m = histFromEngine(r);
    // ack / msg-state events that arrived while the request was in flight
    // found no row to update; the snapshot may predate them.
    if (p.early?.sent.has(r.id)) delete m.queued;
    if (p.early?.acked.has(r.id)) { m.acked = true; delete m.queued; }
    hist.push(m);
  }
  p.early = null;
  // History is older than anything that arrived live in the meantime.
  if (hist.length) { p.msgs.splice(0, 0, ...hist); emitChanged(); }
}

async function hydratePeer(p) {
  if (!p || p.hydrated || !isTauri()) return;
  if (!p.hydrating) {
    p.early = { sent: new Set(), acked: new Set() };
    p.hydrating = invoke()("p2p_messages", { peerId: p.id, limit: HYDRATE_LIMIT })
      .then(rows => {
        if (!Array.isArray(rows)) return;
        mergeHistory(p, rows);
        p.hydrated = true;
      })
      .catch(() => {}) // engine not ready / peer unknown: retry on the next call
      .finally(() => { p.hydrating = null; p.early = null; });
  }
  await p.hydrating;
}


// ---------------- local groups (store, mapping, hydration) ----------------
//
// Same rules as 1:1: numeric ids from nowId() in ARRIVAL order (the chat
// view's "append only new" filter compares ids with >), engine ids only in
// `engineId`, the identity of a group message is (author node id, seq). A
// system line ("X added you…") is a `sys` row; it is always first and has no
// seq. Delivery state is never stored per message: it is derived from
// `acks` (cumulative per member) and the CURRENT roster, so a member who
// left or was removed stops counting immediately.

const HIDDEN_KEY = "velta-p2pg-hidden";
function hiddenGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")); } catch { return new Set(); }
}
function hideGroup(gid) {
  const h = hiddenGroups(); h.add(gid);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...h])); } catch {}
}

const selfIdOf = g => g.members.find(m => m.self)?.id || "self";

// A name for a member; two members that share a display name get a node-id
// suffix so bubbles stay distinguishable.
function memberLabel(g, id, fallback) {
  const m = g.members.find(x => x.id === id);
  let name = (m?.name || fallback || "").trim() || `Device ${String(id).slice(-4)}`;
  if (m && g.members.filter(x => x.name === m.name).length > 1) name += ` (${String(id).slice(-4)})`;
  return name;
}

function ensureGroup(gid) {
  let g = store.groups.get(gid);
  if (!g) {
    g = {
      id: gid, name: "Local group", creator: "", epoch: 0, closed: false, removed: false, canManage: false,
      members: [], msgs: [], unread: 0, acks: new Map(), createdTs: Date.now(), sysAdded: false,
    };
    store.groups.set(gid, g);
  }
  return g;
}

// Merges the engine's group description (status().groups / p2p_group_* result
// / group-state event). Returns the store entry.
function applyGroup(info) {
  if (!info || typeof info.gid !== "string") return null;
  const g = ensureGroup(info.gid);
  g.name = info.name || g.name;
  g.creator = info.creator || g.creator;
  g.epoch = info.epoch ?? g.epoch;
  g.closed = !!info.closed;
  g.removed = !!info.removed;
  g.canManage = !!info.canManage;
  g.members = (info.members || []).map(m => ({
    id: m.id, name: m.name || "", self: !!m.self, online: !!m.online, introduced: !!m.introduced,
  }));
  if (!g.sysAdded) {
    g.sysAdded = true;
    const creatorName = memberLabel(g, g.creator);
    g.msgs.unshift({
      id: nowId(), sys: true, lead: true, ts: g.createdTs,
      text: g.canManage ? "You created the group" : `${creatorName} added you to the group`,
    });
  }
  return g;
}

function seedAcks(g, rows) {
  for (const r of rows) {
    if (r.dir !== "out" || !Array.isArray(r.delivered)) continue;
    for (const by of r.delivered) {
      if ((g.acks.get(by) || 0) < r.seq) g.acks.set(by, r.seq);
    }
  }
}

// System lines the engine wrote ("X added Y", "Z left", ...).
const SYS_END_KINDS = new Set(["removed-me", "disbanded", "left-me"]);
const SYS_INTRO_KINDS = new Set(["created", "joined"]);

function sysLine(g, d) {
  return {
    id: nowId(), sys: true, engineId: d.id, sysKind: d.sysKind || null,
    ts: d.tsEff || d.ts || Date.now(), text: d.text || "",
  };
}

// The engine's own "created / X added you" line replaces the adapter-derived
// one (kept only for groups that predate the persisted lines).
function noteSysKind(g, kind) {
  if (SYS_INTRO_KINDS.has(kind)) {
    g.sysAdded = true;
    g.msgs = g.msgs.filter(m => !m.lead);
  }
}

function hasEndLine(g) {
  return g.msgs.some(m => m.sys && SYS_END_KINDS.has(m.sysKind));
}

// A finished group whose history has no end line (it ended before the engine
// wrote them) still says so, once.
function ensureEndLine(g) {
  if (!g.removed || hasEndLine(g) || g.msgs.some(m => m.sys && m.atEnd)) return;
  g.msgs.push({
    id: nowId(), sys: true, atEnd: true, ts: Date.now(),
    text: g.closed ? "The group was disbanded" : "You are no longer in this group",
  });
}

function histFromGroupRow(g, r) {
  if (r.dir === "sys") return sysLine(g, r);
  const out = r.dir === "out";
  const m = {
    id: nowId(), engineId: r.id, seq: r.seq, from: r.from,
    ts: r.tsEff || r.ts || Date.now(), text: r.text || "", out,
    reply_to: r.replyTo || null, reply_text: r.replyText ?? null,
  };
  if (r.file) {
    // A media message is outside the author's seq stream (seq 0): identified
    // by (author, transfer id), delivery tracked per member by the engine.
    m.seq = null;
    m.file = { name: r.file.name, size: r.file.size || 0, mime: r.file.mime || "", path: r.file.path };
    if (out && Array.isArray(r.fileMembers)) m.xfer = xferFrom(r.fileMembers);
  }
  return m;
}

// ---- group media: per-member transfer state (online-only delivery) ----
// xfer = Map(memberId -> { state: "sending"|"done"|"failed"|"offline", got })
const xferFrom = rows => new Map(rows.map(x => [x.id, { state: x.state, got: x.got || 0 }]));
const isFileMsg = m => !m.sys && !!m.file;
const fileKey = m => `f:${m.from}:${m.engineId}`;
const rowKey = r => (r.dir === "sys" ? r.id : r.file ? `f:${r.from}:${r.id}` : `${r.from}:${r.seq}`);

// Aggregated progress over the members the file is actually going to.
function xferSummary(g, m) {
  const x = m.xfer;
  if (!x) return null;
  const size = m.file?.size || 0;
  const rows = [...x.entries()].filter(([id]) => g.members.some(o => o.id === id && !o.self));
  const going = rows.filter(([, s]) => s.state !== "offline");
  const done = rows.filter(([, s]) => s.state === "done").length;
  const sending = rows.filter(([, s]) => s.state === "sending").length;
  const miss = rows.length - done;
  const frac = going.length && size
    ? going.reduce((a, [, s]) => a + (s.state === "done" ? 1 : Math.min(1, (s.got || 0) / size)), 0) / going.length
    : 0;
  return { rows: rows.length, done, sending, miss, pct: Math.min(100, Math.floor(frac * 100)) };
}

// The bubble's transfer strip: a bar while any member is receiving, the
// failed card only when nobody got the file; otherwise the finished card.
function refreshTransfer(g, m) {
  const s = xferSummary(g, m);
  if (!s) { delete m.transfer; return; }
  if (s.sending > 0) m.transfer = { pct: s.pct, dir: "send", members: s.rows };
  else if (s.done === 0 && s.rows > 0) m.transfer = { failed: true, pct: m.transfer?.pct || 0, dir: "send" };
  else delete m.transfer;
}

// Tick for an outgoing file: clock while it is on its way, double when every
// current member has it, single when some do, failed when nobody got it.
function groupFileState(g, m) {
  if (m.failed) return "failed";
  const s = xferSummary(g, m);
  if (!s) return "sent";
  if (s.sending > 0) return "pending";
  if (s.rows && s.done === s.rows) return "read";
  if (s.done > 0) return "sent";
  return s.rows ? "failed" : "sent";
}

function applyFileProgress(d) {
  const g = store.groups.get(d.gid);
  if (!g || d.dir !== "send") return;
  const m = g.msgs.find(x => isFileMsg(x) && x.out && x.engineId === d.id);
  const upd = { state: d.state, got: d.got || 0 };
  if (!m) {
    // Raced the send command's reply: applied when the message is created.
    if (!g.earlyXfer) g.earlyXfer = new Map();
    const e = g.earlyXfer.get(d.id) || new Map();
    e.set(d.member, upd);
    g.earlyXfer.set(d.id, e);
    return;
  }
  if (!m.xfer) m.xfer = new Map();
  if (d.size && m.file && !m.file.size) m.file.size = d.size;
  const prev = m.xfer.get(d.member);
  const before = m.transfer?.pct ?? -1;
  const tickBefore = groupFileState(g, m);
  m.xfer.set(d.member, upd);
  refreshTransfer(g, m);
  const after = m.transfer?.pct ?? -1;
  // Chunks arrive in bursts: re-render on 2% steps and on any state change.
  if (prev?.state !== upd.state || Math.abs(after - before) >= 2 || after >= 100 || tickBefore !== groupFileState(g, m)) {
    emitChanged(); chatUpdated(g.id);
  }
}

function mergeGroupHistory(g, rows) {
  seedAcks(g, rows);
  const known = new Set(g.msgs.filter(m => m.seq != null).map(m => `${m.from}:${m.seq}`));
  for (const m of g.msgs) {
    if (m.sys && m.engineId) known.add(m.engineId);
    else if (isFileMsg(m)) known.add(fileKey(m));
  }
  const hist = [];
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || typeof r.seq !== "number") continue;
    const key = rowKey(r);
    if (known.has(key)) continue;
    known.add(key);
    if (r.dir === "sys") noteSysKind(g, r.sysKind);
    hist.push(histFromGroupRow(g, r));
  }
  if (hist.length) {
    // History is older than anything that arrived live meanwhile, and the
    // leading system line stays the first row.
    let at = 0;
    while (at < g.msgs.length && g.msgs[at].lead) at++;
    g.msgs.splice(at, 0, ...hist);
    emitChanged();
  }
  ensureEndLine(g);
}

async function hydrateGroup(g) {
  if (!g || g.hydrated || !isTauri()) return;
  if (!g.hydrating) {
    g.hydrating = invoke()("p2p_group_messages", { gid: g.id, limit: HYDRATE_LIMIT })
      .then(rows => {
        if (!Array.isArray(rows)) return;
        mergeGroupHistory(g, rows);
        g.hydrated = true;
      })
      .catch(() => {}) // engine not ready / unknown group: retry on the next call
      .finally(() => { g.hydrating = null; });
  }
  await g.hydrating;
}

// out message state: "failed" | "pending" (nobody has it and nobody is
// online) | "sent" | "read" (every CURRENT other member acknowledged).
function groupMsgState(g, m) {
  if (!m.out) return "read";
  if (m.failed) return "failed";
  if (isFileMsg(m)) return groupFileState(g, m);
  if (m.seq == null) return "pending";
  const others = g.members.filter(x => !x.self);
  const acked = o => (g.acks.get(o.id) || 0) >= m.seq;
  if (others.length && others.every(acked)) return "read";
  if (others.some(acked) || others.some(o => o.online)) return "sent";
  return "pending";
}

function mapGroupMsg(g, m) {
  const chatId = P2PG_PREFIX + g.id;
  if (m.sys) {
    const first = g.msgs.find(x => !x.sys);
    return {
      id: m.id, chatId, kind: "service", viewtype: "text", from: 0, text: m.text,
      ts: m.lead && first ? Math.min(m.ts, first.ts - 1) : m.ts, state: "read",
      fromContact: { name: "", color: "#888" },
    };
  }
  const name = m.out ? "" : memberLabel(g, m.from, m.fromName);
  const base = {
    id: m.id, engineId: m.engineId ?? null, chatId, kind: "msg", viewtype: "text",
    from: m.out ? 1 : 0, text: m.text, ts: m.ts,
    state: groupMsgState(g, m),
    // id stays null so <velta-avatar contact-id> never looks a core contact up.
    fromContact: { id: null, name, color: colorFor(m.from || name) },
    starred: false, edited: false, quote: null, reactions: null, fwdFrom: null,
    filePath: null, fileName: null, fileSize: null, fileMime: null, downloadState: "Done",
  };
  if (m.file) {
    base.viewtype = viewtypeFor(m.file.name, m.file.mime);
    base.filePath = m.file.path;
    base.fileName = m.file.name;
    base.fileSize = m.file.size || null;
    base.fileMime = m.file.mime || null;
    if (m.transfer) base.transfer = m.transfer;
  }
  if (m.reply_to != null) {
    const orig = g.msgs.find(x => !x.sys && (x.engineId === m.reply_to || x.id === m.reply_to));
    const author = orig ? (orig.out ? "You" : memberLabel(g, orig.from, orig.fromName)) : "";
    base.quote = {
      id: orig ? orig.id : m.reply_to,
      text: m.reply_text ?? (orig ? orig.text : ""),
      fromContact: { name: author, color: colorFor(orig?.from || author) },
    };
  }
  if (m.queued) base.queued = true;
  if (m.out) {
    // Per-member delivery for the message-info sheet: a member has it once its
    // cumulative ack reached this message's seq.
    base.delivery = g.members.filter(x => !x.self).map(o => {
      if (isFileMsg(m)) {
        const st = m.xfer?.get(o.id)?.state;
        return {
          id: o.id, name: memberLabel(g, o.id), delivered: st === "done",
          sending: st === "sending", retryable: !!m.xfer && (st === "failed" || st === "offline" || st == null),
        };
      }
      return {
        id: o.id, name: memberLabel(g, o.id),
        delivered: m.seq != null && (g.acks.get(o.id) || 0) >= m.seq,
      };
    });
  }
  return base;
}

function mapGroupChat(g) {
  const last = [...g.msgs].reverse().find(m => !m.sys);
  const onlineCount = g.members.filter(m => m.self || m.online).length;
  const sender = last ? (last.out ? "You" : memberLabel(g, last.from, last.fromName)) : "";
  return {
    ...typingFields(P2PG_PREFIX + g.id),
    id: P2PG_PREFIX + g.id, name: g.name, kind: "group", isP2p: true, isP2pGroup: true,
    memberCount: g.members.length, onlineCount, canManage: g.canManage,
    readOnly: g.removed, closed: g.closed,
    lastMsg: last ? `${sender}: ${last.file ? "📎 " + last.file.name : last.text}` : "",
    lastTs: last ? last.ts : g.createdTs,
    lastFrom: last ? (last.out ? 1 : 0) : 0,
    lastState: last && last.out ? groupMsgState(g, last) : null,
    unread: g.unread, encrypted: false, verified: false, pinned: true,
    avatarColor: colorFor(g.id),
  };
}

function groupMembers(g) {
  return g.members.map(m => ({
    id: m.id, name: memberLabel(g, m.id), addr: "", color: colorFor(m.id),
    self: m.self, online: m.self || m.online, introduced: m.introduced, isCreator: m.id === g.creator,
  }));
}

function chatUpdated(gid) {
  core()?.dispatchEvent?.(new CustomEvent("chat-updated", { detail: { chatId: P2PG_PREFIX + gid } }));
}

// Local group chats the UI can show (hidden = the user deleted the chat).
export function lcGroupName(gid) {
  return store.groups.get(gid)?.name || "Local group";
}

async function engineGroups() {
  const st = await invoke()("p2p_status").catch(() => null);
  return st?.groups || [];
}

// ---- group management (engine commands; store follows the result) ----

async function groupCmd(cmd, args) {
  if (!isTauri()) throw new Error("Local groups need the Velta app shell");
  const info = await invoke()(cmd, args).catch(err => { throw new Error(String(err?.message || err)); });
  const g = applyGroup(info);
  if (g) { emitChanged(); chatUpdated(g.id); }
  return info;
}

export async function createLocalGroup(name, memberIds) {
  const info = await groupCmd("p2p_group_create", { name, memberIds });
  return P2PG_PREFIX + info.gid;
}
export const groupAddMember = (gid, nodeId) => groupCmd("p2p_group_add", { gid, nodeId });
export const groupRemoveMember = (gid, nodeId) => groupCmd("p2p_group_remove", { gid, nodeId });
export const groupRename = (gid, name) => groupCmd("p2p_group_rename", { gid, name });

// Leave (member) or disband (creator). The chat stays in the list, read-only,
// with its history; `dismissLocalGroup` removes it from the list.
export async function leaveLocalGroup(gid) {
  const g = store.groups.get(gid);
  const cmd = g?.canManage ? "p2p_group_disband" : "p2p_group_leave";
  return groupCmd(cmd, { gid });
}

// "Delete chat" on a group: leave/disband it if it is still active, then have
// the engine forget it (log and record). If the engine can't, fall back to
// hiding it from the list.
export async function dismissLocalGroup(gid) {
  const g = store.groups.get(gid);
  if (g && !g.removed) await leaveLocalGroup(gid);
  try {
    await invoke()("p2p_group_delete", { gid });
  } catch {
    hideGroup(gid);
  }
  store.groups.delete(gid);
  emitChanged();
}

// Groups deleted before the engine could (they were only hidden in the list):
// forget them for real now. Best effort, once per group.
async function migrateHiddenGroups(engineList) {
  const hidden = hiddenGroups();
  if (!hidden.size) return;
  for (const gid of [...hidden]) {
    const info = engineList.find(x => x.gid === gid);
    if (info && !info.removed) continue; // still active: leave it hidden
    if (info) { try { await invoke()("p2p_group_delete", { gid }); } catch { continue; } }
    hidden.delete(gid);
  }
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch {}
}

// What unpairing a device does to groups: `created` are deleted here,
// `member` ones keep it as an introduced member.
export async function peerGroupImpact(peerId) {
  if (!isTauri()) return { created: [], member: [] };
  try {
    const r = await invoke()("p2p_peer_groups", { peerId });
    return { created: r?.created || [], member: r?.member || [] };
  } catch { return { created: [], member: [] }; }
}

// ---- info-sheet model (pure; app.js renders it) ----

// Buttons of a local group's info sheet. Only the creator can rename, add and
// remove (the signed roster has a single writer); every member can leave, the
// creator disbands; a finished group can only be deleted.
export function groupActionsModel(chat) {
  if (chat.readOnly) return [{ key: "delete", label: "Delete chat", danger: true, disabled: false }];
  const full = (chat.memberCount || 0) >= GROUP_MAX_OTHERS + 1;
  const out = [];
  if (chat.canManage) {
    out.push({ key: "rename", label: "Rename", danger: false, disabled: false });
    out.push({ key: "add", label: full ? "Add member (group is full)" : "Add member", danger: false, disabled: full });
  }
  out.push({ key: "leave", label: chat.canManage ? "Disband group" : "Leave group", danger: true, disabled: false });
  return out;
}

// The member list's footnote, in plain words.
export function groupMemberHint(chat, members) {
  const parts = [];
  if (chat.readOnly) parts.push("This group is over: nobody can write in it any more. The history stays on this device.");
  else if (chat.canManage) parts.push(`You created this group, so only you can rename it and add or remove members (${members.length}/${GROUP_MAX_OTHERS + 1}).`);
  else parts.push("Only the group's creator can rename it and add or remove members. You can leave at any time.");
  if (members.some(m => m.introduced && !m.self)) {
    parts.push("\u201cNot paired\u201d members joined through the group: you can talk to them only here. Pair with them (Local chat \u2192 Add contact) to message them directly.");
  }
  return parts.join(" ");
}

// Confirm text for unpairing a device, spelling out what happens to groups:
// ones it created are deleted here, ones it is merely in keep it as a member
// you can't message directly.
export function removePeerImpactText(name, impact) {
  const list = gs => gs.map(g => `"${g.name}"`).join(", ");
  const created = impact?.created || [], member = impact?.member || [];
  let text = `Forget "${name}"? Its chat history and received files will be deleted. The device can re-pair with a new invite.`;
  if (created.length) {
    text += ` ${name} created ${list(created)}: ${created.length === 1 ? "that group" : "those groups"} will be deleted from this device too.`;
  }
  if (member.length) {
    text += ` ${name} is also in ${list(member)}: it stays there as a member you can't message directly any more. To take it out of a group you created, remove it from the group first.`;
  }
  return text;
}

// Drops store groups the engine no longer has (deleted, or cascaded away by
// unpairing their creator).
function pruneGroups(engineList) {
  const live = new Set(engineList.map(x => x.gid));
  let changed = false;
  for (const gid of [...store.groups.keys()]) {
    if (!live.has(gid)) { store.groups.delete(gid); changed = true; }
  }
  return changed;
}

// Limits mirrored from the engine (groups.rs) for the create-group modal.
export const GROUP_MAX_OTHERS = 3;   // MAX_GROUP_MEMBERS (4) minus the creator
export const GROUP_MAX_GROUPS = 16;
export const GROUP_NAME_MAX = 64;

// Who can be picked for a new group, from a p2p_status snapshot: only paired
// peers that speak protocol v2 AND are online right now (the engine would
// accept offline ones, but the first sync is far more reliable with everyone
// reachable). Disabled rows carry the reason shown to the user.
export function groupPickerModel(status) {
  const peers = (status?.peers || []).map(p => {
    let reason = "";
    if ((p.proto || 0) < 2) reason = "needs the latest Velta (no group support)";
    else if (!p.online) reason = "offline";
    return { id: p.id, name: p.name || String(p.id).slice(0, 12), disabled: !!reason, reason };
  });
  const active = (status?.groups || []).filter(g => !g.removed).length;
  return { peers, atLimit: active >= GROUP_MAX_GROUPS, active };
}

// An existing active group with exactly this member set (plus me), if any.
export function findDuplicateGroup(status, memberIds) {
  const want = [...new Set(memberIds)].sort().join(",");
  for (const g of status?.groups || []) {
    if (g.removed) continue;
    const others = (g.members || []).filter(m => !m.self).map(m => m.id).sort().join(",");
    if (others === want) return g;
  }
  return null;
}

export function lcGroupInfo(gid) {
  const g = store.groups.get(gid);
  return g ? mapGroupChat(g) : null;
}

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

// ---- typing indicator (receiver side) ----
// chatId -> Map(senderId -> { name, until, timer }). A hint lives SHOW_TTL_MS
// after the last one; a message from the sender or an explicit stop clears it.
const typers = new Map();

function typingNames(chatId) {
  const m = typers.get(chatId);
  if (!m) return [];
  const now = Date.now();
  return [...m.values()].filter(t => t.until > now).map(t => t.name);
}

function setTyping(chatId, sender, name, on) {
  let m = typers.get(chatId);
  if (!on) {
    const t = m?.get(sender);
    if (!t) return;
    clearTimeout(t.timer);
    m.delete(sender);
  } else {
    if (!typingEnabled()) return;
    if (!m) { m = new Map(); typers.set(chatId, m); }
    const old = m.get(sender);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => { setTyping(chatId, sender, name, false); touchChat(chatId); }, SHOW_TTL_MS);
    timer.unref?.();
    m.set(sender, { name, until: Date.now() + SHOW_TTL_MS, timer });
  }
  touchChat(chatId);
}

function typingFields(chatId) {
  const t = typingText(typingNames(chatId));
  return t ? { typingText: t } : {};
}

function touchChat(chatId) {
  core()?.dispatchEvent?.(new CustomEvent("chat-updated", { detail: { chatId } }));
}

function mapChat(p) {
  const last = p.msgs[p.msgs.length - 1];
  return {
    ...typingFields(P2P_PREFIX + p.id),
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
      id: nowId(), engineId: res.id, ts: item.ts, text: item.caption, out: true, acked: false,
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
export async function lcRetryTransfer(chatId, msgId, memberId = null) {
  if (isGroupId(chatId)) return lcRetryGroupFile(chatId, msgId, memberId);
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
      id: nowId(), engineId: res.id, ts: Date.now(), text: msg.text || "", out: true, acked: false,
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
      groups: [], // local groups need the real engine
    };
  }
  const st = await invoke()("p2p_status").catch(() => null);
  if (!st) return null;
  return {
    device: { name: st.name || "device", nodeId: st.nodeId || "" },
    peers: (st.peers || []).map(p => ({
      id: P2P_PREFIX + p.id, rawId: p.id, name: p.name || p.id.slice(0, 12),
      online: !!p.online, queued: p.queued || 0, proto: p.proto || 0,
    })),
    nearby: st.nearby || [],
    groups: (st.groups || []).filter(g => !hiddenGroups().has(g.gid)).map(g => ({
      id: P2PG_PREFIX + g.gid, name: g.name, removed: !!g.removed,
      members: (g.members || []).length,
      online: (g.members || []).filter(m => m.self || m.online).length,
    })),
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
    } else if (d.kind === "group-file-progress") {
      applyFileProgress(d);
    } else if (d.kind === "typing") {
      // 1:1 hint from a paired peer.
      const p = store.peers.get(d.peerId);
      if (p) setTyping(P2P_PREFIX + p.id, p.id, p.name, !!d.on);
    } else if (d.kind === "group-typing") {
      const g = store.groups.get(d.gid);
      if (g) setTyping(P2PG_PREFIX + g.id, d.from, memberLabel(g, d.from, d.name), !!d.on);
    } else if (d.kind === "message") {
      setTyping(P2P_PREFIX + d.peerId, d.peerId, "", false); // a message ends "typing"
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
      p?.early?.acked.add(d.id);
    } else if (d.kind === "msg-state") {
      // A text queued while the peer was offline went out on reconnect.
      const p = store.peers.get(d.peerId);
      const m = p?.msgs.find(x => x.engineId === d.id);
      if (m && m.queued) { delete m.queued; emitChanged(); }
      p?.early?.sent.add(d.id);
    } else if (d.kind === "group-state") {
      const g = applyGroup(d.group);
      if (g) { emitChanged(); chatUpdated(g.id); }
    } else if (d.kind === "group-message") {
      onGroupMessage(d);
    } else if (d.kind === "group-ack") {
      const g = store.groups.get(d.gid);
      if (g && Number.isFinite(d.have) && (g.acks.get(d.by) || 0) < d.have) {
        g.acks.set(d.by, d.have);
        emitChanged(); chatUpdated(g.id);
      }
    } else if (d.kind === "group-system") {
      // A persisted system line ("X added Y", "Z left", ...).
      const g = ensureGroup(d.gid);
      noteSysKind(g, d.sysKind); // before the roster arrives: no derived intro line
      if (!g.msgs.some(m => m.sys && m.engineId === d.id)) {
        g.msgs.push(sysLine(g, d));
        emitChanged(); chatUpdated(g.id);
      }
    } else if (d.kind === "group-deleted") {
      if (store.groups.delete(d.gid)) { emitChanged(); chatUpdated(d.gid); }
    } else if (d.kind === "group-removed") {
      const g = store.groups.get(d.gid);
      if (g && !g.removed) {
        g.removed = true;
        g.closed = g.closed || d.reason === "closed";
        // The engine's own end line ("You were removed", "X disbanded") came
        // first; without one (an older log) say it here.
        ensureEndLine(g);
        emitChanged(); chatUpdated(g.id);
      } else if (g) { chatUpdated(g.id); }
    } else if (d.kind === "group-presence") {
      // The only presence an introduced member ever produces: it updates the
      // roster dots and must never create a `p2p:` chat.
      for (const gid of d.gids || []) {
        const g = store.groups.get(gid);
        const m = g?.members.find(x => x.id === d.peerId);
        if (m && m.online !== !!d.online) { m.online = !!d.online; chatUpdated(gid); emitChanged(); }
      }
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

function onGroupMessage(d) {
  setTyping(P2PG_PREFIX + d.gid, d.from, "", false);
  const g = ensureGroup(d.gid);
  if (!g.members.length) {
    // The message beat the roster to the page (cold start): learn it now.
    engineGroups().then(list => { for (const info of list) applyGroup(info); emitChanged(); chatUpdated(d.gid); }).catch(() => {});
  }
  // A message that raced the hydration is already in the store.
  if (d.file) {
    if (g.msgs.some(m => isFileMsg(m) && m.from === d.from && m.engineId === d.id)) return;
  } else if (g.msgs.some(m => m.seq === d.seq && m.from === d.from)) return;
  g.msgs.push({
    id: nowId(), engineId: d.id, seq: d.file ? null : d.seq, from: d.from, fromName: d.name,
    ts: d.tsEff || d.ts || Date.now(), text: d.text, out: false,
    reply_to: d.replyTo || null, reply_text: d.replyText ?? null,
    ...(d.file ? { file: { name: d.file.name, size: d.file.size || 0, mime: d.file.mime || "", path: d.file.path } } : {}),
  });
  g.unread++;
  const m = g.members.find(x => x.id === d.from);
  if (m) m.online = true;
  emitChanged();
  chatUpdated(g.id);
}

// ---------------- core wrapper ----------------

let wrappedCore = null;
const core = () => wrappedCore;

const P2P_HANDLED = new Set([
  "getChatList", "getChat", "getMessages", "getMessageIds", "getMessage", "sendMessage",
  "markRead", "deleteMessages", "setChatFlags", "resendMessage", "downloadFullMessage",
  "getChatMembers", "leaveGroup", "sendTyping",
]);

// Composer typing hint → engine. Live-only and best effort: any failure, an
// off setting, a non-engine chat or a missing shell is a silent no-op.
async function sendTypingHint(t, id, on) {
  if (!isEnabled() || !typingEnabled() || !isTauri()) return;
  try {
    if (isGroupId(id)) await invoke()("p2p_typing", { gid: gidOf(id), on: !!on });
    else if (String(id).startsWith(P2P_PREFIX)) await invoke()("p2p_typing", { peerId: String(id).slice(P2P_PREFIX.length), on: !!on });
  } catch { /* ignore */ }
}

export function withLocalChat(inner) {
  wrappedCore = inner;
  engineInit();
  return new Proxy(inner, {
    get(target, prop) {
      // Members/leave only exist on cores that implement them (app.js feature-
      // detects `core.getChatMembers`): never invent them for a core without.
      if ((prop === "getChatMembers" || prop === "leaveGroup") && typeof Reflect.get(target, prop) !== "function") {
        return undefined;
      }
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
  if (prop === "sendTyping") return sendTypingHint;
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
              const st = await invoke()("p2p_status").catch(() => null);
              for (const p of st?.peers || []) { peer(p.id, p.name); }
              if (st) {
                await migrateHiddenGroups(st.groups || []);
                pruneGroups(st.groups || []);
              }
              const hidden = hiddenGroups();
              for (const info of st?.groups || []) { if (!hidden.has(info.gid)) applyGroup(info); }
              peers = [...store.peers.values()];
              await Promise.all([
                ...peers.map(hydratePeer), // previews survive a restart
                ...[...store.groups.values()].map(hydrateGroup),
              ]);
            } catch {}
          }
          const q = (opts.query || "").trim().toLowerCase();
          const hiddenNow = hiddenGroups();
          const groupChats = isTauri()
            ? [...store.groups.values()].filter(g => !hiddenNow.has(g.id)).map(mapGroupChat)
            : [];
          const chats = [...peers.map(mapChat), ...groupChats]
            .filter(c => !q || c.name.toLowerCase().includes(q));
        // pinned local chats float above everything; the stable sort keeps
        // the core's own ordering (incl. core-pinned chats) below them.
        return [...list, ...chats].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      };

    case "getChat":
      return async (t, id) => {
        if (isGroupId(id)) {
          const g = store.groups.get(gidOf(id));
          if (!g) return null;
          await hydrateGroup(g);
          return { ...mapGroupChat(g), isP2p: true };
        }
        if (!String(id).startsWith(P2P_PREFIX)) return t.getChat(id);
        const p = store.peers.get(String(id).slice(P2P_PREFIX.length));
        if (!p) return null;
        await hydratePeer(p);
        return { ...mapChat(p), isP2p: true };
      };

    case "getMessages":
      return async (t, id, opts = {}) => {
        if (isGroupId(id)) {
          const g = store.groups.get(gidOf(id));
          await hydrateGroup(g);
          return { messages: g ? g.msgs.map(m => mapGroupMsg(g, m)) : [], hasMore: false };
        }
        if (!String(id).startsWith(P2P_PREFIX)) return t.getMessages(id, opts);
        const p = store.peers.get(String(id).slice(P2P_PREFIX.length));
        await hydratePeer(p);
        const msgs = p ? p.msgs.map(m => mapMsg(p, m)) : [];
        return { messages: msgs, hasMore: false };
      };

    case "getMessageIds":
      return async (t, id) => {
        if (isGroupId(id)) {
          const g = store.groups.get(gidOf(id));
          await hydrateGroup(g);
          return g ? g.msgs.map(m => m.id) : [];
        }
        if (!String(id).startsWith(P2P_PREFIX)) return t.getMessageIds(id);
        const p = store.peers.get(String(id).slice(P2P_PREFIX.length));
        await hydratePeer(p);
        return p ? p.msgs.map(m => m.id) : [];
      };

    case "getMessage":
      return async (t, id) => {
        for (const p of store.peers.values()) {
          const m = p.msgs.find(x => x.id === id);
          if (m) return mapMsg(p, m);
        }
        for (const g of store.groups.values()) {
          const m = g.msgs.find(x => x.id === id);
          if (m) return mapGroupMsg(g, m);
        }
        return t.getMessage(id);
      };

    case "sendMessage":
      return async (t, id, { text = "", viewtype = "text", file = null, filename = null, quoteId = null, quoteText = null } = {}) => {
        if (isGroupId(id)) return sendGroupMessage(gidOf(id), { text, viewtype, file, filename, quoteId, quoteText });
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
              id: nowId(), engineId: res.id, ts: Date.now(), text, out: true, acked: false,
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
        if (isGroupId(id)) {
          const g = store.groups.get(gidOf(id));
          if (g) g.unread = 0;
          return;
        }
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
        if (isLocalId(id)) return;
        return t[prop](id, ...rest);
      };

    // Retry a failed text: swap the failed bubble for a fresh engine send
    // (same text and quote). On failure the failed bubble is restored —
    // same contract as lcRetryTransfer. Relay chats fall through.
    case "resendMessage":
      return async (t, id) => {
        for (const g of store.groups.values()) {
          const m = g.msgs.find(x => x.id === id && x.out && x.failed);
          if (!m) continue;
          return resendGroupMessage(g, m);
        }
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

    // Members of a local group (the relay-group member list shape). Every
    // other chat falls through with ALL arguments.
    case "getChatMembers":
      return async (t, id, ...rest) => {
        if (!isGroupId(id)) return t.getChatMembers(id, ...rest);
        const g = store.groups.get(gidOf(id));
        return g ? groupMembers(g) : [];
      };

    // "Leave group" from the chat menu: a member leaves, the creator
    // disbands. The chat turns read-only in place.
    case "leaveGroup":
      return async (t, id, ...rest) => {
        if (!isGroupId(id)) return t.leaveGroup(id, ...rest);
        await leaveLocalGroup(gidOf(id));
      };

    default:
      return pass;
  }
}

// Media goes to the members that are online right now (the engine streams a
// copy to each; offline ones can be sent it later with Retry). A reply quote
// does not travel with a file. Fails (no bubble) when nobody can be reached.
async function sendGroupFile(g, { text, file, filename }) {
  const name = filename || String(file).split(/[\\/]/).pop() || "file";
  const res = await invoke()("p2p_group_send_file", { gid: g.id, path: file, name, caption: text || "" })
    .catch(err => { throw new Error(String(err?.message || err)); });
  const msg = {
    id: nowId(), engineId: res.id, seq: null, from: selfIdOf(g), ts: res.tsEff || res.ts || Date.now(),
    text: text || "", out: true,
    file: { name: res.file?.name || name, size: res.file?.size || 0, mime: res.file?.mime || "", path: res.file?.path || null },
    xfer: xferFrom(res.members || []),
  };
  // Progress events that beat this reply.
  const early = g.earlyXfer?.get(res.id);
  if (early) { for (const [k, v] of early) msg.xfer.set(k, v); g.earlyXfer.delete(res.id); }
  refreshTransfer(g, msg);
  g.msgs.push(msg);
  emitChanged(); chatUpdated(g.id);
  return mapGroupMsg(g, msg);
}

// Send a group file again to members that missed it (or to one member).
// Online members only; an offline member still says "not yet".
export async function lcRetryGroupFile(chatId, msgId, memberId = null) {
  const g = store.groups.get(gidOf(chatId));
  const m = g?.msgs.find(x => x.id === msgId);
  if (!g || !m || !isFileMsg(m) || !m.out) return;
  if (!isTauri()) return;
  const targets = memberId
    ? [memberId]
    : g.members.filter(o => !o.self && m.xfer?.get(o.id)?.state !== "done" && m.xfer?.get(o.id)?.state !== "sending").map(o => o.id);
  let firstErr = null, ok = 0;
  for (const member of targets) {
    try {
      await invoke()("p2p_group_file_retry", { gid: g.id, id: m.engineId, member });
      ok++;
    } catch (err) { firstErr ??= new Error(String(err?.message || err)); }
  }
  if (!ok && firstErr) throw firstErr;
  emitChanged(); chatUpdated(g.id);
}

async function sendGroupMessage(gid, { text = "", viewtype = "text", file = null, filename = null, quoteId = null, quoteText = null } = {}) {
  const g = store.groups.get(gid);
  if (!g) throw new Error("Unknown local group");
  if (viewtype === "voice") throw new Error("Voice messages aren't available in local groups");
  if (g.removed) throw new Error(g.closed ? "This group was disbanded" : "You are not in this group any more");
  if (!isTauri()) throw new Error("Local groups need the Velta app shell");
  if (file) return sendGroupFile(g, { text, file, filename });
  // The composer quotes by the adapter's numeric id; the wire carries the
  // engine id of the quoted message.
  const target = quoteId != null ? g.msgs.find(x => !x.sys && x.id === quoteId) : null;
  const replyTo = target?.engineId ?? null;
  const replyText = replyTo != null ? (quoteText ?? target?.text ?? null) : null;
  const msg = {
    id: nowId(), engineId: null, seq: null, from: selfIdOf(g), ts: Date.now(), text, out: true,
    reply_to: replyTo, reply_text: replyText,
  };
  g.msgs.push(msg);
  invoke()("p2p_group_send", { gid, text, replyTo, replyText }).then(res => {
    msg.engineId = res.id;
    msg.seq = res.seq;
    msg.ts = res.tsEff || res.ts || msg.ts;
    msg.queued = !!res.queued;
    emitChanged(); chatUpdated(gid);
  }).catch(err => { msg.failed = true; emitChanged(); toast(String(err?.message || err)); });
  return mapGroupMsg(g, msg);
}

// Same swap-on-failure contract as the 1:1 resend: the failed bubble leaves
// only once the engine accepted the fresh send; on failure it comes back.
async function resendGroupMessage(g, m) {
  if (!isTauri()) return;
  g.msgs = g.msgs.filter(x => x.id !== m.id);
  try {
    const res = await invoke()("p2p_group_send", { gid: g.id, text: m.text || "", replyTo: m.reply_to ?? null, replyText: m.reply_text ?? null });
    g.msgs.push({
      id: nowId(), engineId: res.id, seq: res.seq, from: selfIdOf(g), ts: res.tsEff || res.ts || Date.now(),
      text: m.text || "", out: true, queued: !!res.queued, reply_to: m.reply_to ?? null, reply_text: m.reply_text ?? null,
    });
  } catch (err) {
    g.msgs.push(m);
    emitChanged();
    throw err;
  }
  emitChanged();
}

function toast(text) {
  import("./ui.js").then(m => m.toast(text)).catch(() => {});
}
