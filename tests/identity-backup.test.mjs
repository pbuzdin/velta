// V2.5 identity backup crypto: bundle round-trip, wrong-passphrase/tamper
// rejection, base64 helpers. Pure WebCrypto — runs in node and in the
// browser (the rig re-runs the round-trip in Chromium via the same module).
import test from "node:test";
import assert from "node:assert/strict";
import {
  wrapIdentityBundle,
  unwrapIdentityBundle,
  buildIdentityBundle,
  bytesToBase64,
  base64ToBytes,
} from "../app/js/identity-backup.js";

const PASS = "correct horse battery staple";
const KEYS = { "private-key-abc.asc": bytesToBase64(new TextEncoder().encode("-----BEGIN PGP PRIVATE KEY-----\nabc\n")), };

test("bundle round-trip preserves every field", async () => {
  const bundle = buildIdentityBundle({ addr: "alice@example.org", mail_pw: "hunter2", keys: KEYS });
  const wrapped = await wrapIdentityBundle(bundle, PASS);
  const out = await unwrapIdentityBundle(wrapped, PASS);
  assert.equal(out.kind, "velta-identity");
  assert.equal(out.addr, "alice@example.org");
  assert.equal(out.mail_pw, "hunter2");
  assert.deepEqual(out.keys, KEYS);
  assert.ok(out.exported);
});

test("wrapped file carries the magic header and is not plaintext", async () => {
  const wrapped = await wrapIdentityBundle(buildIdentityBundle({ addr: "a@b.c", mail_pw: "x", keys: {} }), PASS);
  assert.ok(new TextDecoder().decode(wrapped.slice(0, 16)).startsWith("VeltaIdentity-v1"));
  assert.ok(!new TextDecoder().decode(wrapped).includes("hunter2"));
});

test("wrong passphrase is rejected", async () => {
  const wrapped = await wrapIdentityBundle(buildIdentityBundle({ addr: "a@b.c", mail_pw: "x", keys: {} }), PASS);
  await assert.rejects(() => unwrapIdentityBundle(wrapped, "wrong"), /Wrong passphrase or corrupted backup/);
});

test("tampered ciphertext is rejected", async () => {
  const wrapped = await wrapIdentityBundle(buildIdentityBundle({ addr: "a@b.c", mail_pw: "x", keys: {} }), PASS);
  wrapped[wrapped.length - 5] ^= 0xff;
  await assert.rejects(() => unwrapIdentityBundle(wrapped, PASS));
});

test("non-identity files are rejected before any crypto", async () => {
  await assert.rejects(() => unwrapIdentityBundle(new TextEncoder().encode("hello world, not a backup at all"), PASS), /Not a Velta identity backup/);
  await assert.rejects(() => unwrapIdentityBundle(new Uint8Array(8), PASS), /Not a Velta identity backup/);
});

test("base64 helpers round-trip binary bytes", () => {
  const u8 = new Uint8Array(70_000).map((_, i) => i % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(u8)), u8);
});

// #105 audit: the restore path must never strand the user on a half-created
// account. Source-integrity pins for the app.js flow (not importable):
//   • unwrap BEFORE addAccount — a wrong passphrase creates nothing;
//   • configure failure removes the stray (deleteAccount) instead of
//     leaving it selected (#99 family);
//   • configure runs BEFORE import_self_keys (spike day 18 — the import
//     marks the account configured and would short-circuit the login proof).
const appSrc = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
import { readFileSync } from "node:fs";

test("restore flow ordering: unwrap-first, configure-before-keys, stray rollback", () => {
  const start = appSrc.indexOf("async function runIdentityRestore(");
  const end = appSrc.indexOf("function openIdentityBackup(", start);
  assert.ok(start !== -1 && end > start, "runIdentityRestore exists before openIdentityBackup");
  const body = appSrc.slice(start, end);
  const unwrap = body.indexOf("unwrapIdentityBundle(");
  const add = body.indexOf("core.addAccount()");
  const configure = body.indexOf("core.configureAccount(id)");
  const keys = body.indexOf("importSelfKeys(id, dir, pass)");
  const rollback = body.indexOf("core.deleteAccount(id)");
  assert.ok(unwrap !== -1 && unwrap < add, "bundle unwrapped before any account is created");
  assert.ok(add !== -1 && add < configure && configure < keys, "configure BEFORE import_self_keys (day 18)");
  assert.ok(rollback !== -1 && rollback < keys, "failed configure removes the stray account");
});
