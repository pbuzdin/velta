// lru.js — small Map-backed LRU for renderer in-memory caches.
// Evicts least-recently-used entries while over maxItems OR over maxBytes.
// Size per entry: opts.sizeOf(value, key) if given, else string length * 2
// (UTF-16) for strings/data URLs, else 0. get()/set() bump recency; has()
// and peek() do not. canEvict(value, key) === false pins an entry (e.g. a
// row still in the DOM); pinned entries are skipped, so the cache may stay
// over its limits while everything left is pinned. onEvict(key, value)
// fires only for limit evictions, not for delete()/clear().
// String keys: do not swap for WeakMap (it needs object keys).
export const DEFAULT_MAX_ITEMS = 100;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function estimateBytes(v) {
  return typeof v === "string" ? v.length * 2 : 0;
}

export class LruCache {
  constructor({ maxItems = DEFAULT_MAX_ITEMS, maxBytes = DEFAULT_MAX_BYTES, sizeOf = null, canEvict = null, onEvict = null } = {}) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this._sizeOf = sizeOf || estimateBytes;
    this._canEvict = canEvict;
    this._onEvict = onEvict;
    this._map = new Map(); // key -> { v, s }
    this.bytes = 0;
  }
  get size() { return this._map.size; }
  has(key) { return this._map.has(key); }
  peek(key) { return this._map.get(key)?.v; }
  get(key) {
    const e = this._map.get(key);
    if (!e) return undefined;
    this._map.delete(key);
    this._map.set(key, e);
    return e.v;
  }
  set(key, value) {
    const old = this._map.get(key);
    if (old) { this.bytes -= old.s; this._map.delete(key); }
    let s = 0;
    try { s = Number(this._sizeOf(value, key)) || 0; } catch {}
    this._map.set(key, { v: value, s });
    this.bytes += s;
    this._trim(key);
    return this;
  }
  delete(key) {
    const e = this._map.get(key);
    if (!e) return false;
    this._map.delete(key);
    this.bytes -= e.s;
    return true;
  }
  clear() { this._map.clear(); this.bytes = 0; }
  _over() { return this._map.size > this.maxItems || this.bytes > this.maxBytes; }
  _trim(justSet) {
    if (!this._over()) return;
    for (const [k, e] of [...this._map]) {
      if (!this._over()) break;
      if (k === justSet) continue; // never evict what the caller just stored
      if (this._canEvict) { try { if (this._canEvict(e.v, k) === false) continue; } catch {} }
      this._map.delete(k);
      this.bytes -= e.s;
      if (this._onEvict) { try { this._onEvict(k, e.v); } catch {} }
    }
  }
  // Snapshot iteration: safe to delete() while looping.
  keys() { return [...this._map.keys()][Symbol.iterator](); }
  values() { return [...this._map.values()].map((e) => e.v)[Symbol.iterator](); }
  entries() { return [...this._map].map(([k, e]) => [k, e.v])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
}
