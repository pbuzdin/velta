import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #178 phase 4: the app lock lives in the app-wide Privacy & security screen
// (main drawer, native shells only) — PIN on every native platform,
// biometric on top on Android — and no longer in Profile management.
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const app = read("../app/js/app.js");
const ui = read("../app/js/ui.js");
const lock = read("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/VeltaLock.kt");
const ks = read("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/VeltaKeystore.kt");
const rs = read("../velta-app/src-tauri/src/lib.rs");

const slice = (src, start) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, start);
  const j = src.indexOf("\nfunction ", i + 1), k = src.indexOf("\nasync function ", i + 1);
  return src.slice(i, Math.min(...[j, k].filter((x) => x > 0)));
};

test("Profile management has no app-lock box; Privacy & security has it", () => {
  assert.ok(!slice(app, "function openProfileManagement(").includes("data-applock-box"));
  const ps = slice(app, "function openPrivacySecurity(");
  for (const s of ["data-applock-box", "data-bio-toggle", "data-pin-add", "velta-biometric"]) assert.ok(ps.includes(s), s);
  // Android shows the PIN rows too (no early return hiding them).
  assert.ok(!/isAndroid\(\)\)\s*\{\s*\/\/ PIN is a desktop mode/.test(ps));
});

test("Privacy & security sits in the main drawer, Tauri-only", () => {
  const invite = ui.indexOf('data-act="invite"');
  const item = ui.indexOf('data-act="privacy-security"');
  const settings = ui.indexOf('<div class="drawer-sec">${t("Settings")}</div>');
  assert.ok(invite > 0 && item > invite && item < settings);
  assert.match(app, /onPrivacySecurity: window\.__TAURI__ && tauriInvoke\(\)/);
});

test("new strings exist in ru and fr", () => {
  const keys = [...app.matchAll(/t\("((?:Privacy & security|App-lock PIN is on: Velta|Add a Velta app-lock PIN|Database encryption isn't set up|Set up a screen lock|The biometric prompt did not succeed: )[^"]*)"/g)].map((m) => m[1]);
  keys.push("Privacy & security…");
  assert.ok(keys.length >= 6);
  for (const l of ["ru", "fr"]) {
    const j = JSON.parse(read(`../app/locales/${l}.json`));
    for (const k of keys) assert.ok(j[k], `${l}: ${k}`);
  }
});

test("Android lock: main thread, screen-lock fallback, no blind fresh key", () => {
  assert.match(lock, /activity\.runOnUiThread/);
  assert.match(lock, /BIOMETRIC_STRONG or BiometricManager\.Authenticators\.DEVICE_CREDENTIAL/);
  assert.match(lock, /if \(Build\.VERSION\.SDK_INT < 30\) builder\.setNegativeButtonText/);
  assert.match(lock, /external fun notifyResult\(on: Boolean, ok: Boolean, detail: String\)/);
  assert.match(ks, /if \(pinOn\(context\)\)/);
  // StrongBox fallback wraps generateKey(), where the exception surfaces.
  assert.match(ks, /setIsStrongBoxBacked\(true\)\.build\(\)\)\s*return generator\.generateKey\(\)/);
});

test("Rust: unlocked DEK runs prepare (migration) and the PIN works on Android", () => {
  assert.match(rs, /db_key::prepare\(&accounts_dir, Some\(&hex\)\)/);
  for (const f of ["fn android_pin_set(", "fn android_pin_clear(", "fn android_pin_unlock("]) assert.ok(rs.includes(f), f);
  assert.ok(rs.includes('"(Landroid/content/Context;ZLjava/lang/String;)Z"'));
});
