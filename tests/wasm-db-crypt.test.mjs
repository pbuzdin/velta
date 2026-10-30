// #178 phase 3: the PWA snapshot is encrypted at rest. Covers the crypto
// primitives (db-crypt.js) and the worker flow end-to-end on the fake OPFS:
// enable → VLTE1 bytes on disk (no SQLite header), boot halts with db-locked
// and never resets, wrong KEK fails the boot, right KEK restores, disable
// returns to plaintext.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  encryptFile, decryptFile, generateDek, wrapDek, unwrapDek,
  deriveKekPassphrase, deriveKekPrf, b64, unb64,
} from "../app/js/db-crypt.js";

test("VLTE1 round trip; wrong key, tamper and AAD transplant all fail", async () => {
  const key = await crypto.subtle.importKey("raw", generateDek(), "AES-GCM", false, ["encrypt", "decrypt"]);
  const other = await crypto.subtle.importKey("raw", generateDek(), "AES-GCM", false, ["encrypt", "decrypt"]);
  const blob = await encryptFile(key, new TextEncoder().encode("hello db"), "/accounts/x|7");
  assert.equal(new TextDecoder().decode(blob.slice(0, 5)), "VLTE1");
  assert.equal(new TextDecoder().decode(await decryptFile(key, blob, "/accounts/x|7")), "hello db");
  await assert.rejects(decryptFile(other, blob, "/accounts/x|7"));
  const tampered = blob.slice();
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(decryptFile(key, tampered, "/accounts/x|7"));
  await assert.rejects(decryptFile(key, blob, "/accounts/x|8"), "AAD mismatch");
});

test("DEK wrap round trip; a wrong KEK cannot unwrap", async () => {
  const dek = generateDek();
  const kek = await deriveKekPassphrase("correct horse", new Uint8Array(16).fill(7));
  const wrap = await wrapDek(kek, dek);
  assert.deepEqual(await unwrapDek(kek, wrap), dek);
  const bad = await deriveKekPassphrase("wrong", new Uint8Array(16).fill(7));
  await assert.rejects(unwrapDek(bad, wrap));
});

test("KDF derivations are deterministic for the same input", async () => {
  const salt = new Uint8Array(16).fill(3);
  const a = await deriveKekPassphrase("p", salt, 1000);
  const b = await deriveKekPassphrase("p", salt, 1000);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, await deriveKekPassphrase("q", salt, 1000));
  const prf = new Uint8Array(32).fill(9);
  assert.deepEqual(await deriveKekPrf(prf, salt), await deriveKekPrf(prf, salt));
  assert.deepEqual(b64(new Uint8Array([0, 1, 2])), "AAEC");
  assert.deepEqual(unb64("AAEC"), new Uint8Array([0, 1, 2]));
});

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
class File_ {
  constructor() { this.kind = "file"; this.data = new Uint8Array(); }
  async getFile() { const d = this.data; return { arrayBuffer: async () => d.slice().buffer, text: async () => new TextDecoder().decode(d), size: d.length }; }
  async createWritable() {
    let buf = null;
    return {
      write: async (b) => { buf = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b); },
      close: async () => { this.data = buf; },
    };
  }
}
let root = new Dir();
const store = { memfs: new Map(), dbs: new Map() };
globalThis.__glueStore2 = store;

const dir = mkdtempSync(join(tmpdir(), "velta-dbkey-"));
const gluePath = join(dir, "glue.mjs");
writeFileSync(gluePath, `
const s = globalThis.__glueStore2;
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
async function snapFile(snap, dir, name) {
  const fh = await (await snap.getDirectoryHandle(dir)).getFileHandle(name);
  return new Uint8Array(await (await fh.getFile()).arrayBuffer());
}
async function rootFile(name) {
  try { return new Uint8Array(await (await (await root.getFileHandle(name)).getFile()).arrayBuffer()); } catch { return null; }
}

test("plaintext install → enable → snapshot is VLTE1, no SQLite header on disk", async () => {
  const r = await boot();
  assert.equal(r.type, "ready");
  store.memfs.set("/accounts/accounts.toml", bytes("selected_account = 1"));
  store.dbs.set(DB, bytes("configured=1"));
  await checkpoint();
  assert.equal(text(store.dbs.get(DB)), "configured=1");

  const kek = await deriveKekPassphrase("horse", new Uint8Array(16).fill(1));
  send({ type: "set-encryption", id: 501, kek, meta: { v: 1, mode: "pass", salt: b64(new Uint8Array(16).fill(1)), iter: 600000 } });
  const en = await waitFor((m) => m.id === 501);
  if (en.type !== "encryption-on") console.log("ENABLE-ERROR:", en.error);
  assert.equal(en.type, "encryption-on");
  assert.deepEqual(await rootFile("dbkey.meta"), bytes(JSON.stringify({ v: 1, mode: "pass", salt: b64(new Uint8Array(16).fill(1)), iter: 600000 })));

  store.dbs.set(DB, bytes("configured=2"));
  assert.equal((await checkpoint()).type, "checkpoint-done");
  const cur = Number(await (await (await root.getFileHandle("current")).getFile()).text());
  const snap = await root.getDirectoryHandle(`snap-${cur}`);
  const raw = new Uint8Array(await snapFile(snap, "sqlite", encodeURIComponent(DB)));
  assert.equal(new TextDecoder().decode(raw.slice(0, 5)), "VLTE1", "snapshot bytes are framed VLTE1");
  assert.equal(new TextDecoder().decode(raw).includes("SQLite format 3"), false, "no plaintext SQLite header");
  assert.ok(snap.children.has("enc"), "generation carries the enc marker");
  assert.equal(text(store.dbs.get(DB)), "configured=2", "memory copy untouched");
});

test("boot without a key halts with db-locked and changes nothing; boot with the right KEK restores", async () => {
  const r = await boot(); // no dbKey
  assert.equal(r.type, "db-locked", "worker refuses to open without the KEK");
  assert.equal(r.mode, "pass");
  assert.equal(store.dbs.get(DB), undefined, "nothing was imported");
  assert.ok(await rootFile("dbkey.wrap"), "wrap survives");

  const bad = await boot(await deriveKekPassphrase("wrong", new Uint8Array(16).fill(1)));
  assert.equal(bad.type, "boot-error", "wrong KEK fails loudly, no reset");
  assert.ok(await rootFile("dbkey.wrap"));

  const good = await boot(await deriveKekPassphrase("horse", new Uint8Array(16).fill(1)));
  assert.equal(good.type, "ready");
  assert.equal(text(store.dbs.get(DB)), "configured=2", "decrypted back into memory");
});

test("disable rewrites the snapshot plaintext and drops the wrap", async () => {
  send({ type: "disable-encryption", id: 502 });
  assert.equal((await waitFor((m) => m.id === 502)).type, "encryption-off");
  assert.equal(await rootFile("dbkey.wrap"), null);
  assert.equal(await rootFile("dbkey.meta"), null);
  const cur = Number(await (await (await root.getFileHandle("current")).getFile()).text());
  const snap = await root.getDirectoryHandle(`snap-${cur}`);
  const raw = new Uint8Array(await snapFile(snap, "sqlite", encodeURIComponent(DB)));
  assert.deepEqual(raw, bytes("configured=2"), "plaintext db bytes again, not VLTE1");
  const r = await boot(); // no key needed anymore
  assert.equal(r.type, "ready");
  assert.equal(text(store.dbs.get(DB)), "configured=2");
});

// --- #178 phase 4: app-lock PIN + recovery code wraps (same DEK, shorter
// secrets) — set, boot through each, coexistence, removal, plaintext guard.
test("PIN and recovery wraps: boot through each, remove, refuse on plaintext", async () => {
  const kek = await deriveKekPassphrase("horse", new Uint8Array(16).fill(1));
  send({ type: "set-encryption", id: 601, kek, meta: { v: 1, mode: "pass", salt: b64(new Uint8Array(16).fill(1)), iter: 600000 } });
  assert.equal((await waitFor((m) => m.id === 601)).type, "encryption-on");
  store.dbs.set(DB, bytes("configured=3"));
  assert.equal((await checkpoint()).type, "checkpoint-done");

  const req = (id, msg) => { send({ id, ...msg }); return waitFor((m) => m.id === id); };
  const pinKek = await deriveKekPassphrase("123456", new Uint8Array(16).fill(2));
  assert.equal(
    (await req(602, { type: "set-unlock-wrap", kind: "pin", kek: pinKek, meta: { v: 1, kind: "pin", salt: b64(new Uint8Array(16).fill(2)), iter: 600000 } })).type,
    "unlock-wrap-done");
  assert.ok(await rootFile("dbkey.pin"));
  assert.ok(await rootFile("dbkey.pinmeta"));
  const recKek = await deriveKekPassphrase("ABCD-EFGH-JKMN", new Uint8Array(16).fill(3));
  assert.equal(
    (await req(603, { type: "set-unlock-wrap", kind: "recovery", kek: recKek, meta: { v: 1, kind: "recovery", salt: b64(new Uint8Array(16).fill(3)), iter: 600000 } })).type,
    "unlock-wrap-done");
  assert.ok(await rootFile("dbkey.recovery"));
  assert.ok(await rootFile("dbkey.recmeta"));

  // Each wrap boots the full profile; a KEK against the WRONG wrap fails.
  assert.equal((await boot(pinKek, "pin")).type, "ready");
  assert.equal(text(store.dbs.get(DB)), "configured=3", "decrypted via the PIN wrap");
  assert.equal((await boot(recKek, "recovery")).type, "ready");
  assert.equal((await boot(kek)).type, "ready", "the main wrap still works");
  assert.equal((await boot(kek, "pin")).type, "boot-error", "main KEK cannot open the pin wrap");

  // Removal: the wrap files go, the PIN no longer boots, recovery survives.
  assert.equal((await req(604, { type: "remove-unlock-wrap", kind: "pin" })).type, "unlock-wrap-done");
  assert.equal(await rootFile("dbkey.pin"), null);
  assert.equal((await boot(pinKek, "pin")).type, "boot-error");
  assert.equal((await boot(recKek, "recovery")).type, "ready", "recovery wrap untouched");

  // On a plaintext install there is no DEK to wrap — the PIN is refused,
  // and turning encryption off dropped the recovery wrap with the rest.
  assert.equal((await req(605, { type: "disable-encryption" })).type, "encryption-off");
  assert.equal(await rootFile("dbkey.recovery"), null, "disable drops every wrap");
  const err = await req(606, { type: "set-unlock-wrap", kind: "pin", kek: pinKek, meta: {} });
  assert.equal(err.type, "unlock-wrap-error");
});
