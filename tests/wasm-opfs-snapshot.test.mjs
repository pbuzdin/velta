// #123/#126: the PWA snapshot must carry the SQLite databases (they are not
// in the memfs) and must never leave OPFS without a complete snapshot, even
// when the worker dies mid-write.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// --- in-memory OPFS ---------------------------------------------------------
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
let failWritesAfter = Infinity;
class File_ {
  constructor() { this.kind = "file"; this.data = new Uint8Array(); }
  async getFile() { const d = this.data; return { arrayBuffer: async () => d.slice().buffer, text: async () => new TextDecoder().decode(d) }; }
  async createWritable() {
    let buf = null;
    return {
      write: async (b) => { buf = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b); },
      close: async () => { if (failWritesAfter-- <= 0) throw new Error("worker killed"); this.data = buf; },
    };
  }
}
let root = new Dir();
const store = { memfs: new Map(), dbs: new Map() };
globalThis.__glueStore = store;

const dir = mkdtempSync(join(tmpdir(), "velta-glue-"));
const gluePath = join(dir, "glue.mjs");
writeFileSync(gluePath, `
const s = globalThis.__glueStore;
export default async function () {}
export function vfs_mkdirp() {}
export function vfs_write(p, b) { s.memfs.set(p, new Uint8Array(b)); }
export function vfs_read(p) { if (!s.memfs.has(p)) throw new Error("ENOENT " + p); return s.memfs.get(p); }
export function vfs_remove(p) { s.memfs.delete(p); }
export async function vfs_list(p) {
  const pre = p.endsWith("/") ? p : p + "/"; const out = new Set();
  for (const k of s.memfs.keys()) if (k.startsWith(pre)) { const rest = k.slice(pre.length); const i = rest.indexOf("/"); out.add(i === -1 ? pre + rest : pre + rest.slice(0, i) + "/"); }
  // The core gets the thread after a directory was listed (async export).
  if (s.onList && p.includes("dc.db-blobs")) { const f = s.onList; s.onList = null; f(); }
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
globalThis.setInterval = () => 0; // boot's 8 s checkpoint timer: off in the test
await import("../app/js/worker-wasm.js");
const send = (m) => globalThis.onmessage({ data: m });
const waitFor = async (pred) => { for (let i = 0; i < 200; i++) { const hit = posted.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 5)); } throw new Error("timeout"); };

const DB = "/accounts/uuid-1/dc.db";
const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

async function boot() {
  posted.length = 0;
  store.memfs.clear(); store.dbs.clear();
  send({ type: "boot", glueUrl: pathToFileURL(gluePath).href });
  const r = await waitFor((m) => m.type === "ready" || m.type === "boot-error");
  assert.equal(r.type, "ready", r.error);
}
let cpId = 0;
async function checkpoint() {
  const id = ++cpId;
  send({ type: "checkpoint", id });
  return waitFor((m) => m.id === id && (m.type === "checkpoint-done" || m.type === "checkpoint-error"));
}

test("the database survives a reload (it is not in the memfs)", async () => {
  await boot();
  store.memfs.set("/accounts/accounts.toml", bytes("selected_account = 1"));
  store.dbs.set(DB, bytes("configured=1"));
  assert.equal((await checkpoint()).type, "checkpoint-done");
  await boot(); // fresh memory, same OPFS
  assert.equal(text(store.dbs.get(DB)), "configured=1");
  assert.equal(text(store.memfs.get("/accounts/accounts.toml")), "selected_account = 1");
});

test("a write cut off half way keeps the previous snapshot", async () => {
  await boot();
  store.dbs.set(DB, bytes("configured=2"));
  failWritesAfter = 1; // first file lands, then the worker "dies"
  assert.equal((await checkpoint()).type, "checkpoint-error");
  failWritesAfter = Infinity;
  await boot();
  assert.equal(text(store.dbs.get(DB)), "configured=1", "old generation still complete");
  store.dbs.set(DB, bytes("configured=3"));
  assert.equal((await checkpoint()).type, "checkpoint-done");
  await boot();
  assert.equal(text(store.dbs.get(DB)), "configured=3");
  const names = [...root.children.keys()].sort();
  assert.equal(names.filter((n) => n.startsWith("snap-")).length, 1, `old generations pruned: ${names}`);
});

test("the old single-tree layout is still restored", async () => {
  root = new Dir();
  const legacy = await (await root.getDirectoryHandle("accounts", { create: true }));
  const f = await legacy.getFileHandle("accounts.toml", { create: true });
  f.data = bytes("legacy");
  await boot();
  assert.equal(text(store.memfs.get("/accounts/accounts.toml")), "legacy");
  store.dbs.set(DB, bytes("x"));
  assert.equal((await checkpoint()).type, "checkpoint-done");
  assert.equal(root.children.has("accounts"), false, "legacy tree dropped after the first new snapshot");
});

test("read-file falls back to the database VFS (#124 password fallback)", async () => {
  await boot();
  store.dbs.set(DB, bytes("db-bytes"));
  send({ type: "read-file", path: DB, id: 77 });
  const r = await waitFor((m) => m.id === 77);
  assert.equal(r.type, "file");
  assert.equal(text(r.bytes), "db-bytes");
});

test("a blob written during the walk never leaves the saved db pointing at nothing", async () => {
  await boot();
  store.dbs.set(DB, bytes("selfavatar="));
  store.memfs.set("/accounts/accounts.toml", bytes("t"));
  store.memfs.set("/accounts/uuid-1/dc.db-blobs/old.jpg", bytes("old"));
  // The core runs between the walk's awaits: it writes the avatar blob, then
  // the config row naming it (set_config selfavatar order).
  const BLOB = "/accounts/uuid-1/dc.db-blobs/av.jpg";
  store.onList = () => { store.memfs.set(BLOB, bytes("jpeg")); store.dbs.set(DB, bytes("selfavatar=" + BLOB)); };
  assert.equal((await checkpoint()).type, "checkpoint-done");
  await boot();
  const saved = text(store.dbs.get(DB));
  const named = saved.slice("selfavatar=".length);
  if (named) assert.ok(store.memfs.has(named), `db names ${named} but the snapshot lacks it`);
  // the next checkpoint catches up with both
  store.memfs.set(BLOB, bytes("jpeg")); store.dbs.set(DB, bytes("selfavatar=" + BLOB));
  assert.equal((await checkpoint()).type, "checkpoint-done");
  await boot();
  assert.equal(text(store.dbs.get(DB)), "selfavatar=" + BLOB);
  assert.equal(text(store.memfs.get(BLOB)), "jpeg");
});

test("remove-file only touches /uploads/<name>", async () => {
  await boot();
  store.memfs.set("/uploads/avatar-1.jpg", bytes("x"));
  store.memfs.set("/accounts/accounts.toml", bytes("t"));
  send({ type: "remove-file", path: "/uploads/avatar-1.jpg", id: 901 });
  assert.equal((await waitFor((m) => m.id === 901)).type, "removed");
  assert.equal(store.memfs.has("/uploads/avatar-1.jpg"), false);
  send({ type: "remove-file", path: "/accounts/accounts.toml", id: 902 });
  assert.equal((await waitFor((m) => m.id === 902)).type, "file-error");
  send({ type: "remove-file", path: "/uploads/../accounts/accounts.toml", id: 903 });
  assert.equal((await waitFor((m) => m.id === 903)).type, "file-error");
  assert.ok(store.memfs.has("/accounts/accounts.toml"));
});
