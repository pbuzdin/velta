// transfer.js — "Velta Beam" webxdc app protocol (#138 part 2).
// Pure logic (no DOM): runs in the app and under node tests.
//
// Everything rides the webxdc realtime channel (iroh gossip, broadcast to
// every peer that joined this app instance, lossy, ≤128 000 B/message):
//   frame = [type u8][header length u32 BE][header JSON][payload bytes]
//   OFFER  {id, name, size, sha256, chunk, n, ph?} sender + every seeder,
//                                                  every few seconds
//   REQ    {id, idx:[chunk indices]}               receiver asks for missing
//   CHUNK  {id, i} + bytes                         any holder answers (broadcast:
//                                                  every receiver may use it)
//   PROG   {id, peer, name, have, n, done, ok,     everyone, every ~1 s
//           seed?, src?}                           (receiver + seeder lists)
// Group fan-out: every member who holds a piece can answer a REQ (Seeder).
// The original sender answers at once; other seeders wait a random jitter
// and drop a piece they saw on the channel meanwhile, so one REQ costs one
// CHUNK however many seeders listen, and a piece goes out at most once per
// ROUND_MS. A token bucket caps each seeder's send rate. Receivers keep a
// small window and re-ask with exponential backoff + jitter.
// Integrity: `ph` (per-piece SHA-256, first 128 bits, files up to PH_MAX
// pieces) lets a receiver verify each piece on arrival, so a partial
// download can already seed; without `ph` only a full, SHA-256-verified
// copy seeds. The assembled file must match `sha256` before it is saved.

export const T_OFFER = 1, T_REQ = 2, T_CHUNK = 3, T_PROG = 4;
export const PROG_MS = 1000;   // receiver progress broadcast period
export const SILENT_MS = 10000; // receiver considered gone/stale after this
export const CHUNK = 48 * 1024; // + header, and the RPC carries it as a JSON number array
export const WINDOW = 8;
export const RETRY_MS = 1500;
export const ROUND_MS = 1000;     // a piece is sent at most once per round, per seeder
export const JITTER_MS = 250;     // non-source seeders answer after 0..JITTER_MS
export const RATE = 40;           // pieces/s per seeder (~1.9 MB/s), burst = RATE
export const MAX_BACKOFF_MS = 12000;
export const PH_MAX = 2048;       // per-piece hashes up to ~96 MB (offer frame stays < 128 kB)

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

// ---- per-piece hashes ----
export function pieceHash(bytes) { return sha256Hex(bytes).slice(0, 32); }
export function pieceHashes(bytes, chunk) {
  const n = Math.max(1, Math.ceil(bytes.length / chunk));
  if (n > PH_MAX) return null;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pieceHash(bytes.subarray(i * chunk, (i + 1) * chunk)));
  return out;
}

// ---- seeder: answers REQs from pieces it holds ----
// piece(i) returns verified bytes or null. source=true (original sender)
// answers immediately; others after a random jitter, and only if nobody
// else sent that piece meanwhile (noteChunk).
export class Seeder {
  constructor({ offer, piece, send, source = false, now = () => Date.now(), rand = Math.random,
    jitterMs = JITTER_MS, roundMs = ROUND_MS, rate = RATE }) {
    Object.assign(this, { offer, piece, send, source, now, rand, jitterMs, roundMs, rate });
    this.recent = new Map();  // index -> last time sent or seen on the channel
    this.pending = new Map(); // index -> due time
    this.tokens = rate;
    this.refill = now();
    this.served = 0;
  }
  fresh(i) { const t = this.recent.get(i); return t != null && this.now() - t < this.roundMs; }
  handle(frame) {
    if (!frame || frame.type !== T_REQ || !frame.header || frame.header.id !== this.offer.id) return;
    const idx = Array.isArray(frame.header.idx) ? frame.header.idx.slice(0, 64) : [];
    const t = this.now();
    for (const i of idx) {
      if (!Number.isInteger(i) || i < 0 || i >= this.offer.n) continue;
      if (this.pending.has(i) || this.fresh(i) || !this.piece(i)) continue;
      this.pending.set(i, t + (this.source ? 0 : Math.floor(this.rand() * this.jitterMs) + 1));
    }
    this.flush();
  }
  // Someone sent piece i: it reached every listener, drop our duplicate.
  noteChunk(i) { this.recent.set(i, this.now()); this.pending.delete(i); }
  flush() {
    const t = this.now();
    this.tokens = Math.min(this.rate, this.tokens + ((t - this.refill) / 1000) * this.rate);
    this.refill = t;
    for (const [i, due] of [...this.pending].sort((a, b) => a[1] - b[1])) {
      if (due > t) break;
      if (this.tokens < 1) break; // rate limit: the rest waits for the next flush
      this.pending.delete(i);
      if (this.fresh(i)) continue;
      const b = this.piece(i);
      if (!b) continue;
      this.tokens -= 1;
      this.recent.set(i, t);
      this.send(encodeFrame(T_CHUNK, { id: this.offer.id, i }, b));
      this.served++;
    }
  }
  announce() { this.send(encodeFrame(T_OFFER, this.offer)); }
}

// ---- sender (original source) ----
export class Sender extends Seeder {
  constructor({ name, bytes, send, id = newId(), chunk = CHUNK, now = () => Date.now(), rand, rate }) {
    const n = Math.max(1, Math.ceil(bytes.length / chunk));
    const offer = { id, name, size: bytes.length, sha256: sha256Hex(bytes), chunk, n };
    const ph = pieceHashes(bytes, chunk);
    if (ph) offer.ph = ph;
    super({ offer, send, now, rand, rate, source: true, piece: (i) => bytes.subarray(i * chunk, (i + 1) * chunk) });
    this.bytes = bytes;
    this.chunk = chunk;
  }
}

// ---- receiver ----
export class Receiver {
  constructor({ offer, send, now = () => Date.now(), window = WINDOW, retryMs = RETRY_MS, rand = Math.random }) {
    this.offer = offer;
    this.send = send;
    this.now = now;
    this.rand = rand;
    this.window = window;
    this.retryMs = retryMs;
    this.parts = new Array(offer.n);
    this.got = 0;
    this.asked = new Map(); // index -> due time for a re-ask
    this.tries = new Map(); // index -> attempts (exponential backoff)
    this.done = false;
    this.ok = null; // sha256 verdict once complete
    this.rejected = 0; // pieces failing their per-piece hash
  }
  get progress() { return this.got / this.offer.n; }
  get receivedBytes() { return Math.min(this.offer.size, this.got * this.offer.chunk); }
  // Verified bytes of piece i for seeding, or null. With per-piece hashes a
  // piece is verified on arrival; without them only a SHA-256-good file seeds.
  piece(i) {
    if (this.done) return this.ok ? this.bytes.subarray(i * this.offer.chunk, (i + 1) * this.offer.chunk) : null;
    return Array.isArray(this.offer.ph) ? this.parts[i] || null : null;
  }
  get canSeed() { return this.done ? !!this.ok : Array.isArray(this.offer.ph) && this.got > 0; }
  // Ask for missing chunks: fill the window; re-ask timed-out ones with backoff.
  pump() {
    if (this.done) return;
    const t = this.now();
    for (const [i, due] of this.asked) if (t >= due) this.asked.delete(i);
    const want = [];
    for (let i = 0; i < this.offer.n && this.asked.size + want.length < this.window; i++) {
      if (!this.parts[i] && !this.asked.has(i)) want.push(i);
    }
    if (!want.length) return;
    for (const i of want) {
      const k = this.tries.get(i) || 0;
      this.tries.set(i, k + 1);
      const wait = Math.min(MAX_BACKOFF_MS, this.retryMs * 2 ** Math.min(k, 4));
      this.asked.set(i, t + wait + Math.floor(this.rand() * this.retryMs / 2));
    }
    this.send(encodeFrame(T_REQ, { id: this.offer.id, idx: want }));
  }
  handle(frame) {
    if (this.done || !frame || frame.type !== T_CHUNK || frame.header.id !== this.offer.id) return false;
    const i = frame.header.i;
    if (!Number.isInteger(i) || i < 0 || i >= this.offer.n || this.parts[i]) return false;
    const want = i === this.offer.n - 1 ? this.offer.size - i * this.offer.chunk : this.offer.chunk;
    if (frame.payload.length !== want) return false;
    if (Array.isArray(this.offer.ph) && pieceHash(frame.payload) !== this.offer.ph[i]) { this.rejected++; return false; }
    this.parts[i] = new Uint8Array(frame.payload); // own copy
    this.asked.delete(i);
    this.tries.delete(i);
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
    this.parts = null;
    this.ok = sha256Hex(out) === this.offer.sha256;
  }
}

export function validOffer(o) {
  return !!o && typeof o.id === "string" && /^[0-9a-f]{16}$/.test(o.id)
    && typeof o.name === "string" && o.name.length > 0 && o.name.length <= 255
    && Number.isInteger(o.size) && o.size >= 0
    && Number.isInteger(o.chunk) && o.chunk > 0 && o.chunk <= 100000
    && Number.isInteger(o.n) && o.n === Math.max(1, Math.ceil(o.size / o.chunk))
    && /^[0-9a-f]{64}$/.test(String(o.sha256))
    && (o.ph === undefined || (Array.isArray(o.ph) && o.ph.length === o.n && o.n <= PH_MAX
      && o.ph.every((h) => typeof h === "string" && /^[0-9a-f]{32}$/.test(h))));
}

// ---- progress / presence (T_PROG) ----
// rx: a Receiver, or null for the original sender (src: has everything).
export function progressFrame(rx, peer, name, { seed = false, src = false, n = 0, id = "" } = {}) {
  const h = rx
    ? { id: rx.offer.id, peer: String(peer || "").slice(0, 128), name: String(name || "").slice(0, 64),
        have: rx.got, n: rx.offer.n, done: !!rx.done, ok: rx.done ? !!rx.ok : null }
    : { id, peer: String(peer || "").slice(0, 128), name: String(name || "").slice(0, 64), have: n, n, done: true, ok: true };
  if (seed) h.seed = true;
  if (src) h.src = true;
  return encodeFrame(T_PROG, h);
}

export function validProgress(h) {
  return !!h && typeof h.id === "string" && /^[0-9a-f]{16}$/.test(h.id)
    && typeof h.peer === "string" && h.peer.length > 0 && h.peer.length <= 128
    && typeof h.name === "string" && h.name.length <= 64
    && Number.isInteger(h.n) && h.n > 0 && Number.isInteger(h.have) && h.have >= 0 && h.have <= h.n;
}

// Per-offer peer list: who is downloading, how far, who is done, who seeds.
// A peer silent for SILENT_MS is dropped, unless it was partway through
// (then it stays, marked stale) or finished (stays done).
export class ReceiverTracker {
  constructor({ id, now = () => Date.now(), silentMs = SILENT_MS } = {}) {
    this.id = id; this.now = now; this.silentMs = silentMs;
    this.peers = new Map(); // peer -> {peer, name, have, n, done, ok, seed, src, seen}
  }
  handle(frame) {
    if (!frame || frame.type !== T_PROG || frame.header.id !== this.id || !validProgress(frame.header)) return false;
    const h = frame.header;
    const prev = this.peers.get(h.peer);
    this.peers.set(h.peer, {
      peer: h.peer, name: h.name || h.peer, n: h.n, seen: this.now(),
      have: Math.max(h.have, prev?.have || 0), done: !!h.done || !!prev?.done,
      ok: h.done ? h.ok === true : prev?.ok ?? null,
      seed: h.seed === true, src: h.src === true,
    });
    return true;
  }
  list() {
    const t = this.now();
    const out = [];
    for (const [k, p] of this.peers) {
      const silent = t - p.seen > this.silentMs;
      if (silent && !p.done && p.have === 0) { this.peers.delete(k); continue; }
      out.push({ ...p, percent: Math.floor((p.have / p.n) * 100), stale: silent && !p.done, live: !silent });
    }
    return out;
  }
  /** Receivers (not the original sender) for the progress list. */
  receivers() { return this.list().filter((p) => !p.src); }
  /** Peers heard recently that serve pieces (sender included). */
  seeders() { return this.list().filter((p) => p.live && p.seed); }
  /** Receivers currently connected (heard recently) — the status-line count. */
  activeCount() { return this.receivers().filter(p => !p.stale && !(p.done && this.now() - p.seen > this.silentMs)).length; }
}
