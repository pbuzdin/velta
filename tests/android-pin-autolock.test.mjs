import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const lock = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/VeltaLock.kt");
const app = src("app/js/app.js");
const dbKey = src("velta-app/src-tauri/src/db_key.rs");

const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test("auto-lock on resume covers a PIN-only setup", () => {
  const resumed = between(lock, "fun onActivityResumed", "fun onActivityStopped");
  assert.match(lock, /fun lockCapable\(context: Context\): Boolean = on\(context\) \|\| VeltaKeystore\.pinOn\(context\)/);
  assert.match(resumed, /lockCapable\(activity\)/);
  assert.doesNotMatch(resumed, /if \(on\(activity\) &&/);
  // No biometric prompt without the biometric wrap: the overlay opens on the PIN entry.
  assert.match(resumed, /pinOnly = !on\(activity\)/);
  assert.match(resumed, /if \(!pinOnly\) reAuth\(activity\)/);
});

test("PIN-only overlay shows the PIN entry and no dead buttons", () => {
  const show = between(lock, "private fun showLock", "private fun showPinEntry");
  assert.match(show, /pinOnly: Boolean = false/);
  assert.match(show, /tag = "velta-lock-unlock"\s+visibility = if \(pinOnly\) View\.GONE/);
  assert.match(show, /VeltaKeystore\.pinOn\(activity\) && !pinOnly/);
  assert.match(show, /visibility = if \(pinOnly\) View\.VISIBLE else View\.GONE/);
});

test("the PIN button stays disabled for the wait and counts it down", () => {
  const show = between(lock, "private fun showLock", "private fun showPinEntry");
  assert.match(show, /startWait\(this, secs\)/);
  // The button is not re-enabled unconditionally after the verdict.
  assert.doesNotMatch(show, /activity\.runOnUiThread \{\s+isEnabled = true/);
  assert.match(lock, /CountDownTimer\(secs \* 1000L, 1000L\)/);
});

test("the page does not arm a desktop lock on Android", () => {
  const block = between(app, "invoke(\"get_db_hello_state\")", "invoke(\"lock_now\")");
  assert.match(block, /if \(isAndroid\(\)\) return;/);
});

test("the PIN wait is checked before any key derivation", () => {
  const open = between(dbKey, "pub fn pin_wrap_open(path", "fn pin_wrap_open_now");
  assert.match(open, /pin_wait_left/);
  assert.ok(!open.includes("derive_pin_kek"));
  const now = between(dbKey, "fn pin_wrap_open_now", "/// Verify the wrap with");
  assert.match(now, /pin_wait_store\(path, now \+ delay_secs \* 1000\)/);
});
