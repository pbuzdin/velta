import { t } from "./i18n.js";
// webrtc-loop.js — Velta Loop over WebRTC data channels (#468).
//
// The PWA cannot open raw LAN sockets or iroh's direct paths, but browsers do
// speak WebRTC: on the same network two peers connect directly, DTLS-encrypted,
// with no server in the data path. This module is the PWA's Loop transport:
//
// - Signaling rides END-TO-END ENCRYPTED Velta messages (an injected
//   `sendSignal`; `createXdcSignal` below carries it as webxdc status updates
//   in the 1:1 chat, the same channel group calls fall back to). There is no
//   signaling server. Offer/answer are sent once with every ICE candidate
//   gathered (non-trickle): Velta messages take seconds, not milliseconds.
// - No TURN, and by default no STUN either (`iceServers: []`). A path that
//   fails is reported as "failed" with a reason, never silently relayed.
// - DTLS fingerprint pinning: the signal carries the sender's certificate
//   fingerprint next to the SDP. A signal whose SDP names another
//   fingerprint is rejected, and once the channel is open the certificate the
//   peer actually presented (getStats) must match the pin, or we hang up.
// - Opt-in per contact (`loopOptIn`): WebRTC shows the peer our local IPs.
// - Chats and small files: one reliable, ordered RTCDataChannel. Text frames
//   are JSON; file chunks are binary. Received files stream into the origin
//   private file system where `createWritable` exists (Chromium), and into
//   memory with a cap (MEM_CAP) elsewhere. Every file is SHA-256 checked.
//
// Pure: RTCPeerConnection, crypto, storage and the file sinks are injected or
// feature-detected, so node tests drive it with fakes and the e2e
// (scripts/e2e-webrtc-loop.mjs) with two real Chromium pages.

export const SIG_V = 1;
export const SIG_TYPES = new Set(["offer", "answer", "bye"]);
export const LABEL = "velta-loop";
export const CHUNK = 16 * 1024;              // safe data-channel message size in every browser
export const MEM_CAP = 150 * 1024 * 1024;    // receive-to-memory limit (no streaming to disk)
export const BUF_HIGH = 1024 * 1024;         // pause sending above this bufferedAmount
export const BUF_LOW = 256 * 1024;
export const CONNECT_TIMEOUT_MS = 20000;
export const GATHER_TIMEOUT_MS = 3000;
export const MAX_TEXT = 64 * 1024;
export const STATES = Object.freeze(["idle", "waiting", "connecting", "direct", "failed", "closed"]);

const enc = new TextEncoder();
const dec = new TextDecoder();

/** "sha-256 AB:CD:…" of an SDP, or null when it has none or several different ones. */
export function sdpFingerprint(sdp) {
  const fps = new Set();
  for (const line of String(sdp || "").split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/.exec(line);
    if (m) fps.add(normFp(m[1], m[2]));
  }
  return fps.size === 1 ? [...fps][0] : null;
}

export function normFp(alg, hex) {
  return `${String(alg).toLowerCase()} ${String(hex).toUpperCase()}`;
}

/** Validated signal or null. */
export function decodeSignal(m) {
  if (!m || typeof m !== "object" || m.vlw !== SIG_V || !SIG_TYPES.has(m.t)) return null;
  if (typeof m.from !== "string" || !m.from || m.from.length > 320) return null;
  if (typeof m.sid !== "string" || !/^[0-9a-f]{8,64}$/.test(m.sid)) return null;
  if (m.t !== "bye") {
    if (typeof m.sdp !== "string" || m.sdp.length > 64 * 1024) return null;
    if (typeof m.fp !== "string" || !/^[a-z0-9-]+ [0-9A-F:]+$/.test(m.fp)) return null;
  }
  return m;
}

export function makeSignal(t, from, sid, sdp) {
  const s = { vlw: SIG_V, t, from, sid };
  if (sdp != null) { s.sdp = sdp; s.fp = sdpFingerprint(sdp); }
  return s;
}

/** True when the SDP's fingerprint is the pinned one (and there is exactly one). */
export function fingerprintMatches(sdp, pinned) {
  const fp = sdpFingerprint(sdp);
  return !!fp && fp === pinned;
}

// Per-contact opt-in (WebRTC reveals local IPs to the peer). Stored as a JSON
// list of contact keys (e.g. the contact's address) under one storage key.
const OPT_KEY = "velta-loop-webrtc";
function readOpt(store) {
  try { const v = JSON.parse(store?.getItem(OPT_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function loopOptIn(store, contact) { return readOpt(store).includes(String(contact)); }
export function setLoopOptIn(store, contact, on) {
  const s = new Set(readOpt(store)); const k = String(contact);
  if (on) s.add(k); else s.delete(k);
  try { store?.setItem(OPT_KEY, JSON.stringify([...s])); } catch {}
}

/** User-facing line for a state (+ failure reason). No IPs, ever. */
export function stateText(state, reason) {
  switch (state) {
    case "waiting": return t("Waiting for your contact to open Velta");
    case "connecting": return t("Connecting directly…");
    case "direct": return t("Connected directly · no server in between");
    case "failed":
      if (reason === "pin") return t("Direct connection refused: security check failed");
      if (reason === "too-big") return t("File too large for this browser (limit {n} MB)", { n: Math.round(MEM_CAP / 1048576) });
      return t("No direct connection. The network may isolate devices (guest Wi-Fi) or block peer-to-peer. Velta does not relay Loop traffic.");
    case "closed": return t("Direct connection closed");
    default: return "";
  }
}

// Binary chunk: [id length u8][id ASCII][payload].
export function encodeChunk(id, bytes) {
  const ib = enc.encode(id);
  const out = new Uint8Array(1 + ib.length + bytes.length);
  out[0] = ib.length; out.set(ib, 1); out.set(bytes, 1 + ib.length);
  return out;
}
export function decodeChunk(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 2 || b[0] === 0 || b.length < 1 + b[0]) return null;
  return { id: dec.decode(b.subarray(1, 1 + b[0])), bytes: b.subarray(1 + b[0]) };
}

export function hex(buf) {
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomId(cryptoImpl = globalThis.crypto) {
  const b = new Uint8Array(8); cryptoImpl.getRandomValues(b); return hex(b);
}

/** Receive-to-memory sink with a hard cap. */
export function memorySink(meta, cap = MEM_CAP) {
  if (meta.size > cap) throw Object.assign(new Error("too big"), { code: "too-big" });
  const parts = []; let n = 0;
  return {
    kind: "memory",
    async write(u8) { n += u8.length; if (n > cap) throw Object.assign(new Error("too big"), { code: "too-big" }); parts.push(u8.slice()); },
    async close() { return new Blob(parts, { type: meta.mime || "application/octet-stream" }); },
    async abort() { parts.length = 0; },
  };
}

/** Streams to the origin private file system (Chromium: createWritable). Null when unsupported. */
export async function opfsSink(meta, storage = globalThis.navigator?.storage) {
  try {
    if (!storage?.getDirectory) return null;
    const root = await storage.getDirectory();
    const dir = await root.getDirectoryHandle("velta-loop-in", { create: true });
    const name = `${meta.id}.part`;
    const fh = await dir.getFileHandle(name, { create: true });
    if (typeof fh.createWritable !== "function") return null;
    const w = await fh.createWritable();
    return {
      kind: "opfs",
      async write(u8) { await w.write(u8); },
      async close() { await w.close(); const f = await fh.getFile(); return new File([f], meta.name, { type: meta.mime || f.type }); },
      async abort() { try { await w.abort(); } catch {} try { await dir.removeEntry(name); } catch {} },
    };
  } catch { return null; }
}

/** Default sink: stream to disk where the browser can, else memory with the cap. */
export async function defaultSink(meta) {
  return (await opfsSink(meta)) || memorySink(meta);
}

async function sha256Hex(blob, subtle = globalThis.crypto?.subtle) {
  return hex(await subtle.digest("SHA-256", await blob.arrayBuffer()));
}

/**
 * One Loop link to one contact over a WebRTC data channel.
 * opts: { selfId, peerId, sendSignal(sig), RTCPeerConnection, iceServers?,
 *   onState(state, reason), onText({id,text,ts}), onAck(id),
 *   onFileProgress({id, dir, done, size, name}), onFile({id, name, mime, size, file}),
 *   sink?(meta) -> sink, connectTimeout?, gatherTimeout?, setTimeout?, clearTimeout? }
 */
export class LoopLink {
  constructor(opts) {
    this.o = opts;
    this.selfId = opts.selfId;
    this.peerId = opts.peerId;
    this.RTCPeerConnection = opts.RTCPeerConnection;
    this.iceServers = opts.iceServers || [];     // no TURN by default; STUN only if configured
    this.sink = opts.sink || defaultSink;
    this.setTimeout = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = opts.clearTimeout || ((h) => clearTimeout(h));
    this.state = "idle"; this.reason = null;
    this.pc = null; this.dc = null; this.sid = null; this.pin = null;
    this.outQ = [];                     // text frames queued until open
    this.rx = new Map();                // id -> {meta, sink, got}
    this.tx = new Map();                // id -> {cancelled}
  }

  _set(state, reason = null) {
    if (this.state === state && this.reason === reason) return;
    this.state = state; this.reason = reason;
    this.o.onState?.(state, reason);
  }

  _newPc() {
    const pc = new this.RTCPeerConnection({ iceServers: this.iceServers });
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === "failed") this._fail("network");
      else if (pc.connectionState === "closed" && this.state !== "failed") this._set("closed");
    };
    pc.ondatachannel = (e) => { if (pc === this.pc && e.channel.label === LABEL) this._wire(e.channel); };
    return pc;
  }

  async _gather(pc) {
    if (pc.iceGatheringState === "complete") return;
    await new Promise((res) => {
      const h = this.setTimeout(res, this.o.gatherTimeout ?? GATHER_TIMEOUT_MS);
      const done = () => { if (pc.iceGatheringState === "complete") { this.clearTimeout(h); res(); } };
      pc.addEventListener?.("icegatheringstatechange", done);
      pc.onicecandidate = (e) => { if (!e.candidate) { this.clearTimeout(h); res(); } };
    });
  }

  _armTimeout() {
    this.clearTimeout(this._to);
    this._to = this.setTimeout(() => { if (this.state === "connecting" || this.state === "waiting") this._fail("network"); },
      this.o.connectTimeout ?? CONNECT_TIMEOUT_MS);
  }

  /** Caller side: create the channel and send the offer. */
  async connect() {
    this._reset();
    this.sid = randomId();
    const pc = this.pc = this._newPc();
    this._wire(pc.createDataChannel(LABEL, { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await this._gather(pc);
    this._set("waiting");
    this._armTimeout();
    await this.o.sendSignal(makeSignal("offer", this.selfId, this.sid, pc.localDescription.sdp));
  }

  /** Feed a signal that arrived over the encrypted Velta channel. */
  async handleSignal(raw) {
    const s = decodeSignal(raw);
    if (!s || s.from !== this.peerId) return false;
    if (s.t === "bye") { if (s.sid === this.sid) this.close(false); return true; }
    if (!fingerprintMatches(s.sdp, s.fp)) { this._fail("pin"); return true; }
    if (s.t === "offer") {
      // Glare (both tapped at once): the lower id keeps its own offer.
      if (this.state === "waiting" && this.sid !== s.sid && this.selfId < this.peerId) return true;
      this._reset();
      this.sid = s.sid; this.pin = s.fp;
      const pc = this.pc = this._newPc();
      this._set("connecting");
      this._armTimeout();
      await pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await this._gather(pc);
      await this.o.sendSignal(makeSignal("answer", this.selfId, this.sid, pc.localDescription.sdp));
      return true;
    }
    if (s.t === "answer" && s.sid === this.sid && this.pc && !this.pin) {
      this.pin = s.fp;
      this._set("connecting");
      await this.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
      return true;
    }
    return false;
  }

  /** The DTLS certificate the peer presented, as "sha-256 AB:…", or null if the browser can't tell. */
  async remoteCertFingerprint() {
    try {
      const stats = await this.pc.getStats();
      let certId = null;
      stats.forEach((r) => { if (r.type === "transport" && r.remoteCertificateId) certId = r.remoteCertificateId; });
      if (!certId) return null;
      const c = stats.get ? stats.get(certId) : null;
      return c ? normFp(c.fingerprintAlgorithm, c.fingerprint) : null;
    } catch { return null; }
  }

  _wire(dc) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUF_LOW;
    dc.onopen = async () => {
      // The browser already checked the cert against the SDP we pinned; this
      // re-checks what was actually presented against the encrypted pin.
      const seen = await this.remoteCertFingerprint();
      if (seen && seen !== this.pin) { this._fail("pin"); return; }
      this.clearTimeout(this._to);
      this.verified = !!seen;
      this._set("direct");
      for (const f of this.outQ.splice(0)) dc.send(f);
    };
    dc.onclose = () => { if (dc === this.dc && this.state === "direct") this._set("closed"); };
    // Frames are handled strictly in order: a file's sink opens (async)
    // before its first chunk is written.
    let chain = Promise.resolve();
    dc.onmessage = (e) => { chain = chain.then(() => this._onFrame(e.data)).catch(() => {}); };
  }

  async _onFrame(data) {
    if (typeof data === "string") {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.t === "msg" && typeof m.text === "string" && m.text.length <= MAX_TEXT) {
        this.o.onText?.({ id: String(m.id), text: m.text, ts: Number(m.ts) || 0 });
        this._sendRaw(JSON.stringify({ t: "ack", id: String(m.id) }));
      } else if (m.t === "ack") this.o.onAck?.(String(m.id));
      else if (m.t === "file-begin") await this._rxBegin(m);
      else if (m.t === "file-end") await this._rxEnd(String(m.id));
      else if (m.t === "file-cancel") await this._rxAbort(String(m.id), "cancelled");
      else if (m.t === "file-reject") { const x = this.tx.get(String(m.id)); if (x) x.cancelled = m.reason || "rejected"; }
      return;
    }
    const c = decodeChunk(data);
    const r = c && this.rx.get(c.id);
    if (!r) return;
    r.got += c.bytes.length;
    if (r.got > r.meta.size) { await this._rxAbort(c.id, "size"); return; }
    try { await r.sink.write(c.bytes); } catch (e) { await this._rxAbort(c.id, e.code || "write"); this._sendRaw(JSON.stringify({ t: "file-reject", id: c.id, reason: e.code || "write" })); return; }
    this.o.onFileProgress?.({ id: c.id, dir: "in", done: r.got, size: r.meta.size, name: r.meta.name });
  }

  async _rxBegin(m) {
    const meta = { id: String(m.id), name: String(m.name || "file").slice(0, 255), mime: String(m.mime || ""), size: Number(m.size), sha256: String(m.sha256 || "") };
    if (!/^[0-9a-f]{16}$/.test(meta.id) || !Number.isSafeInteger(meta.size) || meta.size < 0 || !/^[0-9a-f]{64}$/.test(meta.sha256) || this.rx.has(meta.id)) return;
    let sink;
    try { sink = await this.sink(meta); } catch (e) {
      this._sendRaw(JSON.stringify({ t: "file-reject", id: meta.id, reason: e.code || "sink" }));
      if (e.code === "too-big") this.o.onState?.(this.state, "too-big");
      return;
    }
    this.rx.set(meta.id, { meta, sink, got: 0 });
  }

  async _rxEnd(id) {
    const r = this.rx.get(id); if (!r) return;
    this.rx.delete(id);
    if (r.got !== r.meta.size) { await r.sink.abort(); return; }
    const file = await r.sink.close();
    if ((await sha256Hex(file)) !== r.meta.sha256) { this.o.onFileProgress?.({ id, dir: "in", error: "hash", size: r.meta.size }); return; }
    this.o.onFile?.({ id, name: r.meta.name, mime: r.meta.mime, size: r.meta.size, file, sink: r.sink.kind });
  }

  async _rxAbort(id, why) {
    const r = this.rx.get(id); if (!r) return;
    this.rx.delete(id);
    await r.sink.abort();
    this.o.onFileProgress?.({ id, dir: "in", error: why, size: r.meta.size });
  }

  _sendRaw(f) {
    if (this.dc && this.dc.readyState === "open") this.dc.send(f); else this.outQ.push(f);
  }

  /** Send a Loop chat line; delivery is confirmed by onAck(id). */
  sendText(text) {
    const s = String(text);
    if (!s || s.length > MAX_TEXT) throw new Error("bad text");
    const id = randomId();
    this._sendRaw(JSON.stringify({ t: "msg", id, text: s, ts: Date.now() }));
    return id;
  }

  async _drain() {
    const dc = this.dc;
    if (dc.bufferedAmount <= BUF_HIGH) return;
    await new Promise((res) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; res(); }; });
  }

  /** Send a Blob/File in chunks with progress; `cancelFile(id)` stops it. Resolves to the id. */
  async sendFile(blob, name = blob.name || "file") {
    if (this.state !== "direct") throw new Error("not connected");
    const id = randomId();
    const x = { cancelled: null }; this.tx.set(id, x);
    const sha256 = await sha256Hex(blob);
    this.dc.send(JSON.stringify({ t: "file-begin", id, name, mime: blob.type || "", size: blob.size, sha256 }));
    let off = 0;
    try {
      while (off < blob.size) {
        if (x.cancelled) { this.dc.send(JSON.stringify({ t: "file-cancel", id })); throw new Error(x.cancelled); }
        if (this.dc.readyState !== "open") throw new Error("closed");
        const part = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
        await this._drain();
        this.dc.send(encodeChunk(id, part));
        off += part.length;
        this.o.onFileProgress?.({ id, dir: "out", done: off, size: blob.size, name });
      }
      this.dc.send(JSON.stringify({ t: "file-end", id }));
      return id;
    } finally { this.tx.delete(id); }
  }

  cancelFile(id) { const x = this.tx.get(id); if (x) x.cancelled = "cancelled"; }

  _fail(reason) {
    this.clearTimeout(this._to);
    try { this.pc?.close(); } catch {}
    this._set("failed", reason);
  }

  _reset() {
    this.clearTimeout(this._to);
    for (const [, r] of this.rx) r.sink.abort().catch?.(() => {});
    this.rx.clear();
    try { this.pc?.close(); } catch {}
    this.pc = null; this.dc = null; this.pin = null; this.verified = false;
  }

  /** Hang up; tells the peer unless `notify` is false. */
  close(notify = true) {
    const sid = this.sid;
    this._reset();
    this._set("closed");
    if (notify && sid) Promise.resolve(this.o.sendSignal(makeSignal("bye", this.selfId, sid))).catch(() => {});
  }
}

/**
 * Signaling over Velta: webxdc status updates of one app instance in the 1:1
 * chat (end-to-end encrypted like any message; only chat members see them).
 * Returns { send(sig), ingest(updates) } — `ingest` hands each Loop signal
 * from the peer to `onSignal`. Updates carry no `info`, so nothing shows in
 * the chat.
 */
export function createXdcSignal({ core, msgId, selfId, onSignal }) {
  return {
    send: (sig) => core.sendWebxdcStatusUpdate(msgId, JSON.stringify({ payload: { veltaLoop: sig } }), ""),
    ingest(updates) {
      for (const u of updates || []) {
        const s = decodeSignal(u?.payload?.veltaLoop);
        if (s && s.from !== selfId) onSignal(s);
      }
    },
  };
}
