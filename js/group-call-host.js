// group-call-host.js — one live group call in the Velta host (Phase 2,
// docs/agents/group-calls.md). Binds GroupCall (media) and GroupCallSignal
// (roster + SDP) to the core for ONE webxdc instance, the call room.
//
// The call belongs to the host, not to the app frame: closing the app,
// switching chats or opening another app keeps it running (the in-call bar,
// group-call-ui.js, offers mute/leave/open). The host joins the instance's
// realtime channel itself; webxdc-manager.js routes "VGC1" realtime frames
// here and never into the app frame, and does not leave the channel on
// frame close while a call holds it.

import { GroupCall, randomId } from "./group-call.js";
import { GroupCallSignal, decodeRealtime, fromStatusUpdate, cleanTitle } from "./group-call-signal.js";
import { FALLBACK_ICE_SERVERS } from "./calls.js";

let current = null;
const listeners = new Set();

export function currentGroupCall() { return current; }
export function onGroupCallChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function notify() { const s = current ? current.snapshot() : null; for (const cb of listeners) { try { cb(s, current); } catch {} } }

/** Same rule as 1:1 calls: core TURN servers, else turn.delta.chat by hostname. */
export async function iceServersFrom(core) {
  try {
    const raw = await core.iceServers();
    const s = Array.isArray(raw) ? raw.filter((x) => x && x.urls) : [];
    if (s.length) return s;
  } catch {}
  return FALLBACK_ICE_SERVERS;
}

export class GroupCallSession {
  constructor({ core, msgId, chatId, chatName = "", selfId, selfName, realtime, relayOnly = true, env = {} }) {
    this.core = core; this.msgId = Number(msgId); this.chatId = chatId; this.chatName = chatName;
    this.realtime = !!realtime; this.env = env;
    this.serial = 0;
    this.sid = randomId();
    this.startedAt = 0;
    this.audioEls = new Map();
    const doc = env.document || (typeof document !== "undefined" ? document : null);
    this.call = new GroupCall({
      selfId, selfName, sid: this.sid, relayOnly,
      RTCPeerConnection: env.RTCPeerConnection || globalThis.RTCPeerConnection,
      getUserMedia: env.getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c)),
      iceServers: env.iceServers || (() => iceServersFrom(core)),
      send: (m) => this.signal.sendSignal(m),
      attachAudio: (id, stream) => {
        if (!doc) return;
        let a = this.audioEls.get(id);
        if (!a) { a = doc.createElement("audio"); a.autoplay = true; a.className = "group-call-audio"; a.hidden = true; doc.body.appendChild(a); this.audioEls.set(id, a); }
        if (a.srcObject !== stream) a.srcObject = stream;
        a.play?.()?.catch?.(() => {});
      },
      detachAudio: (id) => { const a = this.audioEls.get(id); if (a) { a.srcObject = null; a.remove(); this.audioEls.delete(id); } },
      onState: () => notify(),
      log: env.log,
    });
    this.signal = new GroupCallSignal({
      selfId, selfName, sid: this.sid, realtime: this.realtime,
      sendUpdate: (u) => core.sendWebxdcStatusUpdate(this.msgId, JSON.stringify(u), ""),
      sendRealtime: (bytes) => core.sendWebxdcRealtimeData(this.msgId, Array.from(bytes)),
      onRoster: (r) => this.call.setRoster(r),
      onSignal: (m) => this.call.handleSignal(m),
      isConnected: (id) => this.call.peers.get(id)?.state === "connected",
      log: env.log,
    });
  }

  snapshot() { return { ...this.call.snapshot(), title: this.title || "", msgId: this.msgId, chatId: this.chatId, chatName: this.chatName, startedAt: this.startedAt, realtime: this.realtime }; }

  async start() {
    // History first: who is already in the call (and how many: the cap).
    await this.pullUpdates();
    if (this.realtime) {
      try { await this.core.sendWebxdcRealtimeAdvertisement(this.msgId); }
      catch (e) { this.realtime = false; this.signal.rt = false; this.env.log?.(`realtime join failed, status updates only: ${e?.message || e}`); }
    }
    await this.call.join();
    this.startedAt = Date.now();
    await this.signal.join();
    try { await this.env.audioRoute?.start?.(true); } catch {}
    try { this.env.wakeLock?.acquire?.(); } catch {}
    notify();
  }

  async pullUpdates() {
    const raw = await this.core.getWebxdcStatusUpdates(this.msgId, this.serial);
    let updates = [];
    try { updates = JSON.parse(raw) || []; } catch {}
    for (const u of updates) {
      this.serial = Math.max(this.serial, u.serial || 0);
      const m = fromStatusUpdate(u);
      if (m?.t === "meta" && !this.title) this.title = cleanTitle(m.title);
    }
    this.signal.ingestUpdates(updates);
  }

  /** Core event for this instance. */
  onStatusUpdate(serial) {
    if (serial && serial <= this.serial) return;
    this.pullUpdates().catch(() => {});
  }

  /** Realtime bytes for this instance; true when they were call traffic. */
  onRealtime(data) {
    const bytes = Uint8Array.from(data || []);
    if (!decodeRealtime(bytes)) return false;
    this.signal.ingestRealtime(bytes);
    return true;
  }

  async leave() {
    this.call.leave();
    await this.signal.leave().catch(() => {});
    try { await this.env.audioRoute?.stop?.(); } catch {}
    try { this.env.wakeLock?.release?.(); } catch {}
    try { await this.env.releaseRealtime?.(this.msgId); } catch {}
  }
}

/** Start (or return) the call for webxdc instance `msgId`. One call at a time. */
export async function joinGroupCall(opts) {
  if (current && current.msgId === Number(opts.msgId)) return current;
  if (current) throw new Error("You are already in a group call");
  if (opts.busy?.()) throw new Error("Finish the current call first");
  const s = new GroupCallSession(opts);
  current = s;
  notify();
  try { await s.start(); }
  catch (e) { current = null; await s.leave().catch(() => {}); notify(); throw e; }
  return s;
}

export async function leaveGroupCall() {
  const s = current;
  if (!s) return;
  current = null;
  await s.leave();
  notify();
}

export function setGroupCallMuted(on) { current?.call.setMuted(on); }

/** Core events -> the live call (wired once by webxdc-manager.initWebxdc). */
export function routeStatusUpdate(msgId, serial) {
  if (current && current.msgId === Number(msgId)) current.onStatusUpdate(Number(serial) || 0);
}
export function routeRealtime(msgId, data) {
  if (current && current.msgId === Number(msgId)) return current.onRealtime(data);
  return !!decodeRealtime(Uint8Array.from(data || [])); // call traffic for a call we're not in: never to the app
}

export function _resetForTests() { current = null; listeners.clear(); }
