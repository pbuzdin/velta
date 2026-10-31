import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// #178: the Android DEK wraps (VeltaKeystore plain wrap, VeltaLock auth
// wrap) are [ver=1][12B iv][ciphertext ‖ 16B GCM tag]. A buffer sized from
// the plaintext (1 + 12 + 32 = 45) cannot hold the 48-byte GCM output —
// that threw on every wrap, so no DEK was ever stored.
const dir = "../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/";
const ks = readFileSync(new URL(dir + "VeltaKeystore.kt", import.meta.url), "utf8");
const lock = readFileSync(new URL(dir + "VeltaLock.kt", import.meta.url), "utf8");

// Mirror of VeltaKeystore.pack / unwrap (Java's GCM appends the tag).
const pack = (iv, ct) => Buffer.concat([Buffer.from([1]), iv, ct]);
const unpack = (blob) => ({ iv: blob.subarray(1, 13), ct: blob.subarray(13) });

test("wrap layout round-trips a 32-byte DEK through AES-256-GCM", () => {
  const kek = randomBytes(32), iv = randomBytes(12), dek = randomBytes(32);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([c.update(dek), c.final(), c.getAuthTag()]);
  assert.equal(ct.length, 48);
  const blob = pack(iv, ct);
  assert.equal(blob.length, 61);
  const u = unpack(blob);
  const d = createDecipheriv("aes-256-gcm", kek, u.iv);
  d.setAuthTag(u.ct.subarray(u.ct.length - 16));
  assert.deepEqual(Buffer.concat([d.update(u.ct.subarray(0, u.ct.length - 16)), d.final()]), dek);
});

test("Kotlin wraps size the blob from the ciphertext, never the plaintext", () => {
  for (const src of [ks, lock]) assert.doesNotMatch(src, /ByteArray\(1 \+ iv\.size \+ dek\.size\)/);
  assert.match(ks, /ByteArray\(1 \+ iv\.size \+ ct\.size\)/);
  assert.match(lock, /ByteArray\(1 \+ iv\.size \+ ct\.size\)/);
  // unwrap mirrors pack: iv [1,13), ct [13,end)
  assert.match(ks, /copyOfRange\(1, 13\)/);
  assert.match(ks, /doFinal\(blob, 13, blob\.size - 13\)/);
});
