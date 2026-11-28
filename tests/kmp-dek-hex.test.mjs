import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const keystore = src("velta-kmp/composeApp/src/androidMain/kotlin/org/velta/kmp/core/VeltaKeystore.kt");
const dbKey = src("velta-kmp/native/rpc-shim/src/db_key.rs");
const lib = src("velta-kmp/native/rpc-shim/src/lib.rs");

test("the Android key string uses the shared two-nibble encoder", () => {
  assert.doesNotMatch(keystore, /private fun hex\(/);
  assert.match(keystore, /return encodeHex\(dek\)/);
  assert.doesNotMatch(keystore, /(^|[^A-Za-z])hex\(/m);
  assert.ok((keystore.match(/encodeHex\(/g) || []).length >= 3);
});

test("the shim re-keys legacy databases and attachments before the core opens them", () => {
  assert.match(dbKey, /pub fn legacy_key\(/);
  assert.match(dbKey, /fn rekey_pass\(/);
  assert.match(dbKey, /fn reencrypt_blobs\(/);
  // a database that could not be re-keyed keeps the whole session on the old key
  assert.match(lib, /prep\.key_override\.as_deref\(\)\.unwrap_or\(&hex\)/);
});
