// transfer.js — "Velta Beam" webxdc app protocol (#138 part 2).
// Pure logic (no DOM): runs in the app and under node tests.
//
// Everything rides the webxdc realtime channel (iroh gossip, broadcast to
// every peer that joined this app instance, lossy, ≤128 000 B/message):
//   frame = [type u8][header length u32 BE][header JSON][payload bytes]
//   OFFER  {id, name, size, sha256, chunk, n}      sender, every few seconds
//   REQ    {id, idx:[chunk indices]}               receiver asks for missing
//   CHUNK  {id, i} + bytes                         sender answers (broadcast:
//                                                  every receiver may use it)
//   PROG   {id, peer, name, have, n, done, ok}     receiver, every ~1 s and on
//                                                  completion (progress list)
// Receivers keep a small window of requested chunks and re-ask after a
// timeout, so a lost gossip message only costs a retry. Integrity: the
// assembled file must match the offer's sha256 before it can be saved.

export const T_OFFER = 1, T_REQ = 2, T_CHUNK = 3, T_PROG = 4;
export const PROG_MS = 1000;   // receiver progress broadcast period
export const SILENT_MS = 10000; // receiver considered gone/stale after this
export const CHUNK = 48 * 1024; // + header, and the RPC carries it as a JSON number array
export const WINDOW = 8;
export const RETRY_MS = 1500;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(type, header, payload) {
  const h = enc.encode(JSON.stringify(header));
  const p = payload || new Uint8Array(0);
  const out = new Uint8Array(5 + h.length + p.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, h.length);
  out.set(h, 5);
  out.set(p, 5 + h.length);
  return out;
}

export function decodeFrame(bytes) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 5) return null;
    const hl = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1);
    if (5 + hl > b.length) return null;
    const header = JSON.parse(dec.decode(b.subarray(5, 5 + hl)));
    if (!header || typeof header !== "object") return null;
    return { type: b[0], header, payload: b.subarray(5 + hl) };
  } catch { return null; }
}

// ---- SHA-256 (pure JS: crypto.subtle is not guaranteed in the sandboxed,
// opaque-origin webxdc frame) ----
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

export function sha256Hex(data) {
  const msg = data instanceof Uint8Array ? data : new Uint8Array(data);
  const len = msg.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const tail = new Uint8Array(total - (len & ~63));
  tail.set(msg.subarray(len & ~63));
  tail[len & 63] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, Math.floor(len / 0x20000000));
  tv.setUint32(tail.length - 4, (len << 3) >>> 0);
  const mv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const block = (view, off) => {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = W[t - 15], b = W[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };
  const full = len & ~63;
  for (let off = 0; off < full; off += 64) block(mv, off);
  for (let off = 0; off < tail.length; off += 64) block(tv, off);
  return Array.from(H, x => x.toString(16).padStart(8, "0")).join("");
}

export function newId(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return Array.from(rand(8), b => b.toString(16).padStart(2, "0")).join("");
}

// ---- sender ----
export class Sender {
  constructor({ name, bytes, send, id = newId(), chunk = CHUNK, now = () => Date.now() }) {
    this.bytes = bytes;
    this.chunk = chunk;
    this.now = now;
    this.send = send;
    this.offer = { id, name, size: bytes.length, sha256: sha256Hex(bytes), chunk, n: Math.max(1, Math.ceil(bytes.length / chunk)) };
    this.recent = new Map(); // chunk index -> last sent ms (several receivers ask at once)
    this.served = 0;
  }
  announce() { this.send(encodeFrame(T_OFFER, this.offer)); }
  handle(frame) {
    if (!frame || frame.type !== T_REQ || frame.header.id !== this.offer.id) return;
    const idx = Array.isArray(frame.header.idx) ? frame.header.idx.slice(0, 64) : [];
    for (const i of idx) {
      if (!Number.isInteger(i) || i < 0 || i >= this.offer.n) continue;
      const t = this.recent.get(i);
      if (t != null && this.now() - t < 300) continue;
      this.recent.set(i, this.now());
      this.send(encodeFrame(T_CHUNK, { id: this.offer.id, i }, this.bytes.subarray(i * this.chunk, (i + 1) * this.chunk)));
      this.served++;
    }
  }
}

// ---- receiver ----
export class Receiver {
  constructor({ offer, send, now = () => Date.now(), window = WINDOW, retryMs = RETRY_MS }) {
    this.offer = offer;
    this.send = send;
    this.now = now;
    this.window = window;
    this.retryMs = retryMs;
    this.parts = new Array(offer.n);
    this.got = 0;
    this.asked = new Map(); // index -> ms asked
    this.done = false;
    this.ok = null; // sha256 verdict once complete
  }
  get progress() { return this.got / this.offer.n; }
  get receivedBytes() { return Math.min(this.offer.size, this.got * this.offer.chunk); }
  // Ask for missing chunks: fill the window, re-ask timed-out ones.
  pump() {
    if (this.done) return;
    const t = this.now();
    for (const [i, at] of this.asked) if (t - at > this.retryMs) this.asked.delete(i);
    const want = [];
    for (let i = 0; i < this.offer.n && this.asked.size + want.length < this.window; i++) {
      if (!this.parts[i] && !this.asked.has(i)) want.push(i);
    }
    if (!want.length) return;
    for (const i of want) this.asked.set(i, t);
    this.send(encodeFrame(T_REQ, { id: this.offer.id, idx: want }));
  }
  handle(frame) {
    if (this.done || !frame || frame.type !== T_CHUNK || frame.header.id !== this.offer.id) return false;
    const i = frame.header.i;
    if (!Number.isInteger(i) || i < 0 || i >= this.offer.n || this.parts[i]) return false;
    const want = i === this.offer.n - 1 ? this.offer.size - i * this.offer.chunk : this.offer.chunk;
    if (frame.payload.length !== want) return false;
    this.parts[i] = new Uint8Array(frame.payload); // own copy
    this.asked.delete(i);
    this.got++;
    if (this.got === this.offer.n) this.finish();
    else this.pump();
    return true;
  }
  finish() {
    this.done = true;
    const out = new Uint8Array(this.offer.size);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    this.bytes = out;
    this.ok = sha256Hex(out) === this.offer.sha256;
  }
}

export function validOffer(o) {
  return !!o && typeof o.id === "string" && /^[0-9a-f]{16}$/.test(o.id)
    && typeof o.name === "string" && o.name.length > 0 && o.name.length <= 255
    && Number.isInteger(o.size) && o.size >= 0
    && Number.isInteger(o.chunk) && o.chunk > 0 && o.chunk <= 100000
    && Number.isInteger(o.n) && o.n === Math.max(1, Math.ceil(o.size / o.chunk))
    && /^[0-9a-f]{64}$/.test(String(o.sha256));
}

// ---- receiver progress (T_PROG) ----
export function progressFrame(rx, peer, name) {
  return encodeFrame(T_PROG, {
    id: rx.offer.id, peer: String(peer || "").slice(0, 128), name: String(name || "").slice(0, 64),
    have: rx.got, n: rx.offer.n, done: !!rx.done, ok: rx.done ? !!rx.ok : null,
  });
}

export function validProgress(h) {
  return !!h && typeof h.id === "string" && /^[0-9a-f]{16}$/.test(h.id)
    && typeof h.peer === "string" && h.peer.length > 0 && h.peer.length <= 128
    && typeof h.name === "string" && h.name.length <= 64
    && Number.isInteger(h.n) && h.n > 0 && Number.isInteger(h.have) && h.have >= 0 && h.have <= h.n;
}

// Per-offer receiver list: who is downloading, how far, and who is done.
// A receiver silent for SILENT_MS is dropped, unless it was partway through
// (then it stays, marked stale) or finished (stays done).
export class ReceiverTracker {
  constructor({ id, now = () => Date.now(), silentMs = SILENT_MS } = {}) {
    this.id = id; this.now = now; this.silentMs = silentMs;
    this.peers = new Map(); // peer -> {peer, name, have, n, done, ok, seen}
  }
  handle(frame) {
    if (!frame || frame.type !== T_PROG || frame.header.id !== this.id || !validProgress(frame.header)) return false;
    const h = frame.header;
    const prev = this.peers.get(h.peer);
    this.peers.set(h.peer, {
      peer: h.peer, name: h.name || h.peer, n: h.n, seen: this.now(),
      have: Math.max(h.have, prev?.have || 0), done: !!h.done || !!prev?.done,
      ok: h.done ? h.ok === true : prev?.ok ?? null,
    });
    return true;
  }
  list() {
    const t = this.now();
    const out = [];
    for (const [k, p] of this.peers) {
      const silent = t - p.seen > this.silentMs;
      if (silent && !p.done && p.have === 0) { this.peers.delete(k); continue; }
      out.push({ ...p, percent: Math.floor((p.have / p.n) * 100), stale: silent && !p.done });
    }
    return out;
  }
  /** Receivers currently connected (heard recently) — the status-line count. */
  activeCount() { return this.list().filter(p => !p.stale && !(p.done && this.now() - p.seen > this.silentMs)).length; }
}
