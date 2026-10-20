// group-call.js — the media side of Velta group audio calls (full mesh,
// audio only). docs/research/webxdc-group-calls.md, docs/agents/group-calls.md.
//
// The HOST runs this, never the webxdc app: the trusted group-call app only
// draws the UI through webxdc.veltaCall (webxdc-manager.js). One
// RTCPeerConnection per remote participant; relay-only ICE by default
// (TURN from the core, so peers never see each other's IP addresses).
//
// Signaling is injected (`send(msg)` + `handleSignal(msg)`; see
// group-call-signal.js): the roster comes from outside via setRoster(), and
// for every pair the participant with the smaller id makes the offer.
// Non-trickle ICE (gather up to `gatherTimeout`, like 1:1 calls) so each
// pair needs exactly one offer and one answer — that also fits the slow
// status-update fallback. A negotiated data channel (id 3, "state")
// carries {muted} between peers.
//
// Everything platform-shaped is injected so the state machine runs in
// node tests; scripts/e2e-group-call.mjs runs it with real WebRTC.

export const GROUP_CALL_MAX = 6;
export const OFFER_RETRY_MS = 7000;   // resend an unanswered offer
export const MAX_OFFER_TRIES = 4;
export const RESTART_LIMIT = 3;       // ICE failure -> new connection, at most
export const SPEAKING_LEVEL = 0.04;   // RTCStats audioLevel (0..1) threshold
export const LEVEL_POLL_MS = 300;

export const GROUP_MIC_CONSTRAINTS = Object.freeze({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  video: false,
});

/** Opus for a voice mesh: mono, ~32 kbps, DTX + in-band FEC. */
export function tuneOpus(sdp, bitrate = 32000) {
  const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp || "");
  if (!m) return sdp;
  const pt = m[1];
  const want = { maxaveragebitrate: String(bitrate), usedtx: "1", useinbandfec: "1", stereo: "0" };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (_all, params) => {
      const kv = new Map(params.split(";").map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
      for (const [k, v] of Object.entries(want)) kv.set(k, v);
      return `a=fmtp:${pt} ${[...kv].map(([k, v]) => `${k}=${v}`).join(";")}`;
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(";")}`);
}

/** Who offers in a pair: the smaller id (stable on both sides). */
export function isOfferer(selfId, peerId) {
  return String(selfId) < String(peerId);
}

/**
 * Roster -> who is in the call, capped: the first GROUP_CALL_MAX by join
 * time (ties by id). Everyone computes the same set from the same roster.
 */
export function admitted(roster, max = GROUP_CALL_MAX) {
  return [...roster].sort((a, b) => (a.at - b.at) || (String(a.id) < String(b.id) ? -1 : 1)).slice(0, max);
}

export class GroupCall {
  constructor(opts) {
    this.selfId = opts.selfId;
    this.selfName = opts.selfName || "";
    this.send = opts.send;                      // (msg) => Promise|void
    this.getUserMedia = opts.getUserMedia;      // (constraints) => Promise<MediaStream>
    this.RTCPeerConnection = opts.RTCPeerConnection;
    this.iceServers = opts.iceServers || (async () => []);
    this.relayOnly = opts.relayOnly !== false;
    this.gatherTimeout = opts.gatherTimeout ?? 3000;
    this.offerRetryMs = opts.offerRetryMs ?? OFFER_RETRY_MS;
    this.attachAudio = opts.attachAudio || (() => {});
    this.detachAudio = opts.detachAudio || (() => {});
    this.onState = opts.onState || (() => {});
    this.log = opts.log || (() => {});
    this.setTimeout = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = opts.clearTimeout || ((t) => clearTimeout(t));
    this.setInterval = opts.setInterval || ((f, ms) => setInterval(f, ms));
    this.clearInterval = opts.clearInterval || ((t) => clearInterval(t));
    this.max = opts.max ?? GROUP_CALL_MAX;
    this.sid = opts.sid || randomId();          // this join session
    this.peers = new Map();                     // id -> peer record
    this.roster = [];                           // [{id, name, sid, at}]
    this.state = "idle";                        // idle|joining|active|full|ended
    this.muted = false;
    this.stream = null;
    this.selfLevel = 0;
    this.levelTimer = null;
    this._ice = null;
  }

  /** Open the mic and start connecting to the current roster. */
  async join() {
    if (this.state !== "idle") return;
    this.state = "joining";
    this._emit();
    try {
      this.stream = await this.getUserMedia(GROUP_MIC_CONSTRAINTS);
    } catch (e) {
      this.state = "ended"; this.error = "microphone: " + (e?.message || e?.name || e);
      this._emit();
      throw e;
    }
    if (!this.stream?.getAudioTracks?.().length) {
      this.state = "ended"; this.error = "no microphone track";
      this._emit();
      throw new Error(this.error);
    }
    this._ice = await this.iceServers();
    this.state = "active";
    this.levelTimer = this.setInterval(() => this._pollLevels(), LEVEL_POLL_MS);
    this._reconcile();
    this._emit();
  }

  /** Leave: close every connection and release the mic. Idempotent. */
  leave(reason = "left") {
    if (this.state === "ended") return;
    this.state = "ended";
    this.reason = reason;
    for (const id of [...this.peers.keys()]) this._dropPeer(id);
    if (this.levelTimer) this.clearInterval(this.levelTimer);
    this.levelTimer = null;
    for (const t of this.stream?.getTracks?.() || []) { try { t.stop(); } catch {} }
    this.stream = null;
    this._emit();
  }

  setMuted(on) {
    this.muted = !!on;
    for (const t of this.stream?.getAudioTracks?.() || []) t.enabled = !this.muted; // KEEP: never remove the sender
    for (const p of this.peers.values()) this._sendState(p);
    this._emit();
  }

  /** The roster changed (signaling layer): [{id, name, sid, at}], self included. */
  setRoster(list) {
    this.roster = Array.isArray(list) ? list.filter((m) => m && m.id) : [];
    if (this.state === "active" || this.state === "full") this._reconcile();
    this._emit();
  }

  _reconcile() {
    const inCall = admitted(this.roster, this.max);
    const me = inCall.find((m) => m.id === this.selfId);
    if (!me && this.roster.some((m) => m.id === this.selfId)) {
      // Joined after the call was full: stay connected to nobody.
      if (this.state !== "full") { this.state = "full"; this.log("call is full"); }
      for (const id of [...this.peers.keys()]) this._dropPeer(id);
      return;
    }
    if (this.state === "full") this.state = "active";
    const want = new Map(inCall.filter((m) => m.id !== this.selfId).map((m) => [m.id, m]));
    for (const [id, p] of this.peers) {
      const m = want.get(id);
      if (!m || (m.sid && p.sid && m.sid !== p.sid)) this._dropPeer(id); // gone, or rejoined with a new session
    }
    for (const [id, m] of want) {
      if (this.peers.has(id)) { this.peers.get(id).name = m.name || this.peers.get(id).name; continue; }
      const p = this._newPeer(id, m);
      if (isOfferer(this.selfId, id)) this._offer(p);
    }
  }

  _newPeer(id, m) {
    const pc = new this.RTCPeerConnection({
      iceServers: this._ice || [],
      iceTransportPolicy: this.relayOnly ? "relay" : "all",
      bundlePolicy: "max-bundle",
    });
    const p = { id, name: m?.name || "", sid: m?.sid || "", pc, state: "connecting", muted: false,
      level: 0, tries: 0, restarts: p0(this.peers.get(id)), retry: null, answered: false, stream: null, dc: null };
    for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
    try {
      p.dc = pc.createDataChannel("state", { negotiated: true, id: 3 });
      p.dc.onopen = () => this._sendState(p);
      p.dc.onmessage = (e) => {
        try { const s = JSON.parse(e.data); if (typeof s.muted === "boolean") { p.muted = s.muted; this._emit(); } } catch {}
      };
    } catch {}
    pc.ontrack = (e) => {
      p.stream = e.streams?.[0] || (typeof MediaStream !== "undefined" ? new MediaStream([e.track]) : null);
      this.attachAudio(id, p.stream);
    };
    pc.onconnectionstatechange = () => this._onConn(p);
    this.peers.set(id, p);
    return p;
  }

  async _offer(p) {
    try {
      if (!p.localSdp) {
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription({ type: "offer", sdp: tuneOpus(offer.sdp) });
        await this._gathered(p.pc);
        p.localSdp = p.pc.localDescription.sdp;
      }
      if (this.peers.get(p.id) !== p || p.answered) return;
      p.tries++;
      await this.send({ t: "offer", from: this.selfId, to: p.id, sid: this.sid, toSid: p.sid, sdp: p.localSdp, try: p.tries });
      if (p.tries < MAX_OFFER_TRIES) p.retry = this.setTimeout(() => { if (!p.answered && this.peers.get(p.id) === p) this._offer(p); }, this.offerRetryMs);
    } catch (e) {
      this.log(`offer to ${p.id} failed: ${e?.message || e}`);
    }
  }

  /** A signaling message for us (the signaling layer filters `to`). */
  async handleSignal(msg) {
    if (!msg || msg.to !== this.selfId || msg.from === this.selfId) return;
    if (this.state !== "active") return;
    if (msg.toSid && msg.toSid !== this.sid) return; // for an earlier session of ours
    if (msg.t === "offer") return this._onOffer(msg);
    if (msg.t === "answer") return this._onAnswer(msg);
  }

  async _onOffer(msg) {
    if (isOfferer(this.selfId, msg.from)) return; // we are the offerer of this pair
    const inCall = admitted(this.roster, this.max);
    if (!inCall.some((m) => m.id === msg.from) || !inCall.some((m) => m.id === this.selfId)) return;
    let p = this.peers.get(msg.from);
    if (p && p.remoteSid === msg.sid && p.localSdp) {
      // Duplicate (retry or the other transport): repeat our answer.
      return this.send({ t: "answer", from: this.selfId, to: msg.from, sid: this.sid, toSid: msg.sid, sdp: p.localSdp });
    }
    if (p && p.remoteSid && p.remoteSid !== msg.sid) { this._dropPeer(msg.from); p = null; }
    if (!p) p = this._newPeer(msg.from, inCall.find((m) => m.id === msg.from));
    if (p.answering) return;
    p.answering = true;
    p.remoteSid = msg.sid;
    try {
      await p.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      const ans = await p.pc.createAnswer();
      await p.pc.setLocalDescription({ type: "answer", sdp: tuneOpus(ans.sdp) });
      await this._gathered(p.pc);
      p.localSdp = p.pc.localDescription.sdp;
      p.answered = true;
      if (this.peers.get(p.id) !== p) return;
      await this.send({ t: "answer", from: this.selfId, to: msg.from, sid: this.sid, toSid: msg.sid, sdp: p.localSdp });
    } catch (e) {
      this.log(`answer to ${msg.from} failed: ${e?.message || e}`);
    } finally { p.answering = false; }
  }

  async _onAnswer(msg) {
    const p = this.peers.get(msg.from);
    if (!p || p.answered || !isOfferer(this.selfId, msg.from)) return;
    p.answered = true;
    p.remoteSid = msg.sid;
    if (p.retry) this.clearTimeout(p.retry);
    try {
      await p.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    } catch (e) {
      p.answered = false;
      this.log(`answer from ${msg.from} rejected: ${e?.message || e}`);
    }
  }

  _onConn(p) {
    const s = p.pc.connectionState;
    p.state = s === "connected" ? "connected" : s === "failed" ? "failed" : s === "closed" ? "closed" : "connecting";
    if (s === "failed" && this.state === "active" && this.peers.get(p.id) === p) {
      // ICE failed (TURN down, network switch): rebuild once more from scratch.
      if (p.restarts < RESTART_LIMIT) {
        const m = this.roster.find((x) => x.id === p.id);
        this._dropPeer(p.id);
        const n = this._newPeer(p.id, m);
        n.restarts = p.restarts + 1;
        if (isOfferer(this.selfId, p.id)) this._offer(n);
      }
    }
    this._emit();
  }

  _dropPeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    if (p.retry) this.clearTimeout(p.retry);
    try { p.dc?.close?.(); } catch {}
    try { p.pc.close(); } catch {}
    this.detachAudio(id);
  }

  _sendState(p) {
    try { if (p.dc?.readyState === "open") p.dc.send(JSON.stringify({ muted: this.muted })); } catch {}
  }

  _gathered(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const t = this.setTimeout(done, this.gatherTimeout);
      const prev = pc.onicegatheringstatechange;
      function done() { pc.onicegatheringstatechange = prev; resolve(); }
      pc.onicegatheringstatechange = (e) => {
        prev?.(e);
        if (pc.iceGatheringState === "complete") { this.clearTimeout(t); done(); }
      };
    });
  }

  async _pollLevels() {
    let changed = false;
    for (const p of this.peers.values()) {
      try {
        const stats = await p.pc.getStats();
        let lvl = 0;
        stats.forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio" && typeof r.audioLevel === "number") lvl = r.audioLevel; });
        if (Math.abs(lvl - p.level) > 0.005) { p.level = lvl; changed = true; }
      } catch {}
    }
    const first = this.peers.values().next().value;
    if (first && !this.muted) {
      try {
        const stats = await first.pc.getStats();
        stats.forEach((r) => { if (r.type === "media-source" && r.kind === "audio" && typeof r.audioLevel === "number") { if (Math.abs(r.audioLevel - this.selfLevel) > 0.005) { this.selfLevel = r.audioLevel; changed = true; } } });
      } catch {}
    } else if (this.selfLevel) { this.selfLevel = 0; changed = true; }
    if (changed) this._emit();
  }

  /** Plain snapshot for the UI (webxdc.veltaCall.onState). */
  snapshot() {
    const parts = [{ id: this.selfId, name: this.selfName, self: true, muted: this.muted, state: this.state === "active" ? "connected" : this.state, level: this.selfLevel, speaking: !this.muted && this.selfLevel > SPEAKING_LEVEL }];
    for (const p of this.peers.values()) parts.push({ id: p.id, name: p.name, self: false, muted: p.muted, state: p.state, level: p.level, speaking: !p.muted && p.level > SPEAKING_LEVEL });
    const loud = parts.filter((x) => x.speaking).sort((a, b) => b.level - a.level)[0];
    const inCall = admitted(this.roster, this.max);
    return { state: this.state, muted: this.muted, participants: parts, activeSpeaker: loud ? loud.id : null,
      inCall: inCall.length, waiting: Math.max(0, this.roster.length - inCall.length), max: this.max, relayOnly: this.relayOnly, error: this.error || null };
  }

  _emit() { try { this.onState(this.snapshot()); } catch {} }
}

function p0(prev) { return prev ? prev.restarts : 0; }

export function randomId() {
  const b = new Uint8Array(8);
  (globalThis.crypto || {}).getRandomValues?.(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("") || String(Math.random()).slice(2);
}
