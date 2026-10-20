// group-call-signal.js — signaling + roster for group calls (Phase 2,
// docs/agents/group-calls.md). Pure: the core-facing calls are injected.
//
// Two transports, both scoped to ONE webxdc instance (the call room):
// - status updates (`sendUpdate`): persistent, reach every chat member over
//   email, slow (seconds). Carry the ROSTER (join/leave), the chat info line
//   and the summary, and are the fallback for SDP when realtime is missing
//   (the wasm PWA) or an offer went unanswered.
// - the realtime channel (iroh gossip, `sendRealtime`): fast, best-effort,
//   only members who joined it. Carries SDP and heartbeats.
// Every message is `{vgc: 1, t, from, sid, ...}`; realtime bytes are
// "VGC1" + UTF-8 JSON so the host can tell call traffic from app traffic.
// `from` is self-declared (core passes no sender for either transport); the
// DTLS fingerprint in the SDP authenticates the media session itself.

export const RT_MAGIC = "VGC1";
export const HEARTBEAT_RT_MS = 15000;      // realtime heartbeat
export const HEARTBEAT_UPDATE_MS = 90000;  // status-update heartbeat (fallback members only)
export const TTL_RT_MS = 50000;            // member considered gone after this silence
export const TTL_UPDATE_MS = 240000;
export const CALL_TYPES = new Set(["join", "leave", "hb", "offer", "answer"]);

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeRealtime(msg) {
  return enc.encode(RT_MAGIC + JSON.stringify(msg));
}
/** Bytes from the realtime channel -> call message, or null (app traffic). */
export function decodeRealtime(bytes) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (b.length < 5 || b[0] !== 0x56 || b[1] !== 0x47 || b[2] !== 0x43 || b[3] !== 0x31) return null;
    const m = JSON.parse(dec.decode(b.subarray(4)));
    return isCallMsg(m) ? m : null;
  } catch { return null; }
}
export function isCallMsg(m) {
  return !!m && typeof m === "object" && m.vgc === 1 && CALL_TYPES.has(m.t) && typeof m.from === "string" && m.from.length > 0 && m.from.length < 320;
}
/** A status update (core JSON) -> call message or null. */
export function fromStatusUpdate(u) {
  const m = u?.payload?.veltaCall;
  return isCallMsg(m) ? m : null;
}

export function summaryText(n) {
  return n > 0 ? `Group call · ${n} in call` : "Group call ended";
}

export class GroupCallSignal {
  constructor(opts) {
    this.selfId = opts.selfId;
    this.selfName = opts.selfName || "";
    this.sid = opts.sid;
    this.rt = !!opts.realtime;
    this.sendUpdate = opts.sendUpdate;         // ({payload, info?, summary?}) => Promise
    this.sendRealtime = opts.sendRealtime || (async () => {});
    this.onRoster = opts.onRoster || (() => {});
    this.onSignal = opts.onSignal || (() => {});
    this.isConnected = opts.isConnected || (() => false);
    this.now = opts.now || (() => Date.now());
    this.setInterval = opts.setInterval || ((f, ms) => setInterval(f, ms));
    this.clearInterval = opts.clearInterval || ((t) => clearInterval(t));
    this.log = opts.log || (() => {});
    this.members = new Map();   // id -> {id, name, sid, at, seen, rt}
    this.seenSig = new Set();   // de-dup of offer/answer by (from,sid,t,try)
    this.joined = false;
    this.timers = [];
    this.lastUpdateHb = 0;
    this.offerVia = new Map();  // peer id -> transport its last offer came on
  }

  /** Feed the instance's whole status-update history (before join) or new ones. */
  ingestUpdates(updates) {
    let changed = false;
    for (const u of updates || []) { const m = fromStatusUpdate(u); if (m) changed = this._ingest(m, "update") || changed; }
    if (changed) this._roster();
  }

  ingestRealtime(bytes) {
    const m = decodeRealtime(bytes);
    if (m && this._ingest(m, "rt")) this._roster();
    return !!m;
  }

  /** Live members (self included once joined), sorted by join time. */
  roster() {
    const now = this.now();
    const out = [];
    for (const m of this.members.values()) {
      const ttl = m.rt ? TTL_RT_MS : TTL_UPDATE_MS;
      if (m.id === this.selfId || now - m.seen < ttl || this.isConnected(m.id)) out.push({ id: m.id, name: m.name, sid: m.sid, at: m.at });
    }
    return out.sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
  }

  async join() {
    const others = this.roster().filter((m) => m.id !== this.selfId);
    const at = this.now();
    this.members.set(this.selfId, { id: this.selfId, name: this.selfName, sid: this.sid, at, seen: at, rt: this.rt });
    this.joined = true;
    const msg = this._msg("join", { name: this.selfName, at, rt: this.rt });
    const first = others.length === 0;
    await this.sendUpdate({ payload: { veltaCall: msg }, summary: summaryText(others.length + 1),
      ...(first ? { info: `${this.selfName || "Someone"} started a group call` } : {}) });
    if (this.rt) await this._rt(msg);
    this.timers.push(this.setInterval(() => this._heartbeat(), HEARTBEAT_RT_MS));
    this._roster();
  }

  async leave() {
    if (!this.joined) return;
    this.joined = false;
    for (const t of this.timers) this.clearInterval(t);
    this.timers = [];
    this.members.delete(this.selfId);
    const left = this.roster().length;
    const msg = this._msg("leave", {});
    if (this.rt) await this._rt(msg).catch(() => {});
    await this.sendUpdate({ payload: { veltaCall: msg }, summary: summaryText(left),
      ...(left === 0 ? { info: "Group call ended" } : {}) }).catch(() => {});
  }

  /** From GroupCall.send: route an offer/answer. */
  async sendSignal(m) {
    const msg = { vgc: 1, ...m, from: this.selfId, sid: this.sid, ts: this.now() };
    const peer = this.members.get(m.to);
    const viaRt = this.rt && peer?.rt;
    // First try over realtime when both ends have it; retries (try >= 2),
    // answers to retried offers, and every PWA pair go over status updates.
    const viaUpdate = !viaRt || (m.try || 0) >= 2 || (m.t === "answer" && this.offerVia.get(m.to) === "update");
    if (viaRt) await this._rt(msg).catch((e) => this.log(`realtime send failed: ${e?.message || e}`));
    if (viaUpdate || !viaRt) await this.sendUpdate({ payload: { veltaCall: msg } });
  }

  _heartbeat() {
    if (!this.joined) return;
    const now = this.now();
    const me = this.members.get(this.selfId); if (me) me.seen = now;
    if (this.rt) this._rt(this._msg("hb", { at: me?.at })).catch(() => {});
    // Members without realtime only learn we're alive from status updates.
    const needUpdate = !this.rt || [...this.members.values()].some((m) => m.id !== this.selfId && !m.rt);
    if (needUpdate && now - this.lastUpdateHb >= HEARTBEAT_UPDATE_MS) {
      this.lastUpdateHb = now;
      this.sendUpdate({ payload: { veltaCall: this._msg("hb", { at: me?.at }) } }).catch(() => {});
    }
    this._roster();
  }

  _ingest(m, via) {
    if (m.from === this.selfId && m.sid === this.sid) return false; // our own echo
    const now = this.now();
    if (m.t === "offer" || m.t === "answer") {
      if (m.to !== this.selfId) return false;
      const key = `${m.from}|${m.sid}|${m.t}|${m.try || 0}|${via}`;
      if (this.seenSig.has(key)) return false;
      this.seenSig.add(key);
      // Stale signals from the history (an earlier call) are ignored.
      if (!this.joined) return false;
      const peer = this.members.get(m.from);
      if (peer && peer.sid !== m.sid) return false;
      if (peer) peer.seen = Math.max(peer.seen, now);
      if (m.t === "offer") this.offerVia.set(m.from, via); // answer the same way
      Promise.resolve(this.onSignal(m)).catch(() => {});
      return false;
    }
    const cur = this.members.get(m.from);
    if (m.t === "leave") {
      if (cur && cur.sid === m.sid) { this.members.delete(m.from); return true; }
      return false;
    }
    // join / hb. History replay uses the sender's timestamp; live realtime
    // traffic counts as seen now.
    const at = Number(m.at) || now;
    const seen = via === "rt" ? now : Math.min(now, Number(m.ts) || at);
    if (cur && cur.sid === m.sid) {
      cur.seen = Math.max(cur.seen, seen); if (m.name) cur.name = m.name; if (via === "rt") cur.rt = true;
      return m.t === "join";
    }
    if (cur && cur.at > at) return false; // an older session arriving late
    this.members.set(m.from, { id: m.from, name: m.name || cur?.name || "", sid: m.sid, at, seen, rt: !!m.rt || via === "rt" });
    return true;
  }

  _msg(t, extra) { return { vgc: 1, t, from: this.selfId, sid: this.sid, ts: this.now(), ...extra }; }
  _rt(msg) { return Promise.resolve(this.sendRealtime(encodeRealtime(msg))); }
  _roster() { try { this.onRoster(this.roster()); } catch {} }
}
