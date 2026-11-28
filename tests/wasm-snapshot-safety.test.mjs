// Snapshot safety (PWA persistence): a checkpoint must use ONE key for the
// whole generation even if encryption is toggled while it runs, the wrap may
// only be dropped after a plaintext rewrite is confirmed, and a storage read
// error must never be read as "nothing saved" (recovery from generation 0
// would delete snap-1 and prune the rest).
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { deriveKekPassphrase, b64 } from "../app/js/db-crypt.js";

// --- worker flow on the fake OPFS (harness as in wasm-opfs-snapshot.test) ---
class Dir {
  constructor() { this.kind = "directory"; this.children = new Map(); }
  async getDirectoryHandle(n, o = {}) {
    let c = this.children.get(n);
    if (!c) { if (!o.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); c = new Dir(); this.children.set(n, c); }
    return c;
  }
  async getFileHandle(n, o = {}) {
    let c = this.children.get(n);
    if (!c) { if (!o.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); c = new File_(); this.children.set(n, c); }
    return c;
  }
  async removeEntry(n) { if (!this.children.delete(n)) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); }
  async *entries() { for (const e of [...this.children]) yield e; }
}
const hooks = { closeGate: null, failRead: null };
class File_ {
  constructor() { this.kind = "file"; this.data = new Uint8Array(); }
  async getFile() {
    if (hooks.failRead?.(this)) throw Object.assign(new Error("transient storage error"), { name: "UnknownError" });
    const d = this.data;
    return { arrayBuffer: async () => d.slice().buffer, text: async () => new TextDecoder().decode(d), size: d.length };
  }
  async createWritable() {
    let buf = null;
    return {
      write: async (b) => { buf = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b); },
      close: async () => { if (hooks.closeGate) await hooks.closeGate(); this.data = buf; },
    };
  }
}
let root = new Dir();
const store = { memfs: new Map(), dbs: new Map() };
globalThis.__glueStore3 = store;

const dir = mkdtempSync(join(tmpdir(), "velta-snapsafe-"));
const gluePath = join(dir, "glue.mjs");
writeFileSync(gluePath, `
const s = globalThis.__glueStore3;
export default async function () {}
export function vfs_mkdirp() {}
export function vfs_write(p, b) { s.memfs.set(p, new Uint8Array(b)); }
export function vfs_read(p) { if (!s.memfs.has(p)) throw new Error("ENOENT " + p); return s.memfs.get(p); }
export function vfs_remove(p) { s.memfs.delete(p); }
export async function vfs_list(p) {
  const pre = p.endsWith("/") ? p : p + "/"; const out = new Set();
  for (const k of s.memfs.keys()) if (k.startsWith(pre)) { const rest = k.slice(pre.length); const i = rest.indexOf("/"); out.add(i === -1 ? pre + rest : pre + rest.slice(0, i) + "/"); }
  return [...out];
}
export function sqlite_list() { return [...s.dbs.keys()]; }
export function sqlite_export(n) { if (!s.dbs.has(n)) throw new Error("no db"); return s.dbs.get(n); }
export function sqlite_import(n, b) { s.dbs.set(n, new Uint8Array(b)); }
export async function init() { return { receive() {} }; }
`);

globalThis.self = globalThis;
Object.defineProperty(globalThis, "navigator", { value: { storage: { getDirectory: async () => root } }, configurable: true });
const posted = [];
globalThis.postMessage = (m) => posted.push(m);
globalThis.setInterval = () => 0;
await import("../app/js/worker-wasm.js");
const send = (m) => globalThis.onmessage({ data: m });
const waitFor = async (pred) => { for (let i = 0; i < 400; i++) { const hit = posted.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 5)); } throw new Error("timeout"); };

const DB = "/accounts/uuid-1/dc.db";
const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

async function boot(dbKey, unlockSrc) {
  posted.length = 0;
  store.memfs.clear(); store.dbs.clear();
  send({ type: "boot", glueUrl: pathToFileURL(gluePath).href, dbKey, unlockSrc });
  return waitFor((m) => ["ready", "boot-error", "db-locked"].includes(m.type));
}
let cpId = 0;
async function checkpoint() {
  const id = ++cpId;
  send({ type: "checkpoint", id });
  return waitFor((m) => m.id === id && (m.type === "checkpoint-done" || m.type === "checkpoint-error"));
}

const SALT = new Uint8Array(16).fill(1);
const META_OBJ = () => ({ v: 1, mode: "pass", salt: b64(SALT), iter: 600000 });
async function enable(id) {
  const kek = await deriveKekPassphrase("horse", SALT);
  send({ type: "set-encryption", id, kek, meta: META_OBJ() });
  assert.equal((await waitFor((m) => m.id === id)).type, "encryption-on");
  return kek;
}
const curGen = async () => Number(await (await (await root.getFileHandle("current")).getFile()).text());
const fresh = () => { root = new Dir(); hooks.closeGate = null; hooks.failRead = null; };

test("M9: disabling encryption during a checkpoint never leaves an undecryptable latest snapshot", async () => {
  fresh();
  assert.equal((await boot()).type, "ready");
  store.memfs.set("/accounts/accounts.toml", bytes("selected_account = 1"));
  store.dbs.set(DB, bytes("configured=1"));
  await checkpoint();
  await enable(601);
  store.dbs.set(DB, bytes("configured=2"));

  // Hold the encrypted checkpoint after its first file, toggle meanwhile.
  let release; const gate = new Promise((r) => { release = r; });
  let closes = 0, reached; const midway = new Promise((r) => { reached = r; });
  hooks.closeGate = async () => { if (++closes === 2) { reached(); await gate; } };
  const cpId1 = ++cpId;
  send({ type: "checkpoint", id: cpId1 });
  await midway; // snap is half written under the key
  send({ type: "disable-encryption", id: 602 });
  await new Promise((r) => setTimeout(r, 20));
  hooks.closeGate = null;
  release();
  await waitFor((m) => m.id === cpId1);
  const off = await waitFor((m) => m.id === 602);

  // Whatever the outcome, a boot WITHOUT the key must either restore the data
  // (wrap dropped, snapshot plaintext) or still have the wrap to unlock.
  const wrap = await (async () => { try { return await root.getFileHandle("dbkey.wrap"); } catch { return null; } })();
  if (off.type === "encryption-off") {
    assert.equal(wrap, null);
    const r = await boot();
    assert.equal(r.type, "ready", `boot after disable: ${r.error}`);
    assert.equal(text(store.dbs.get(DB)), "configured=2");
  } else {
    assert.ok(wrap, "encryption stays on, so the wrap must still exist");
  }
});

test("M9: enabling encryption during a plaintext checkpoint still ends with an encrypted latest snapshot", async () => {
  fresh();
  assert.equal((await boot()).type, "ready");
  store.dbs.set(DB, bytes("configured=1"));
  let release; const gate = new Promise((r) => { release = r; });
  let closes = 0, reached; const midway = new Promise((r) => { reached = r; });
  hooks.closeGate = async () => { if (++closes === 1) { reached(); await gate; } };
  const id1 = ++cpId;
  send({ type: "checkpoint", id: id1 });
  await midway;
  const kek = await deriveKekPassphrase("horse", SALT);
  send({ type: "set-encryption", id: 603, kek, meta: META_OBJ() });
  await waitFor((m) => m.id === 603);
  hooks.closeGate = null;
  release();
  await waitFor((m) => m.id === id1);
  assert.equal((await checkpoint()).type, "checkpoint-done"); // same data: must still be rewritten
  const snap = await root.getDirectoryHandle(`snap-${await curGen()}`);
  assert.ok(snap.children.has("enc"), "latest generation is encrypted once encryption is on");
});

test("M10: a transient read error never prunes saved snapshots", async () => {
  fresh();
  assert.equal((await boot()).type, "ready");
  store.memfs.set("/accounts/accounts.toml", bytes("selected_account = 1"));
  store.dbs.set(DB, bytes("configured=1"));
  await checkpoint();
  const gen = await curGen();
  const before = [...root.children.keys()].sort();

  hooks.failRead = (f) => f === root.children.get("current"); // OPFS hiccup on the pointer
  const r = await boot();
  assert.equal(r.type, "boot-error", "a read error fails the boot loudly");
  // The page (or a stale timer) may still ask for a checkpoint: it must not write or prune.
  store.memfs.set("/accounts/accounts.toml", bytes("selected_account = 99"));
  store.dbs.set(DB, bytes("EMPTY-NEW-PROFILE"));
  assert.equal((await checkpoint()).type, "checkpoint-error");
  hooks.failRead = null;
  assert.deepEqual([...root.children.keys()].sort(), before, "no snapshot removed or added");
  assert.equal(await curGen(), gen);

  assert.equal((await boot()).type, "ready");
  assert.equal(text(store.dbs.get(DB)), "configured=1", "the saved profile is still there");
});
