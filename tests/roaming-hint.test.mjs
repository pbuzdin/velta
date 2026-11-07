import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #302 — roaming hint: offer Text-only mode once per roaming episode
// while the mode is off; never after "Don't ask again". Policy module is
// node-safe; the Android command and app wiring are pinned by source asserts.

globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const rh = await import("../app/js/roaming-hint.js");

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const ask = (roaming, mode, storage = localStorage) => rh.shouldAskRoaming({ roaming, mode, storage });

test("asks on entering roaming while the mode is off", () => {
  rh._resetRoamingEpisode();
  localStorage.removeItem(rh.ROAMING_DISMISSED_KEY);
  assert.equal(ask(true, "off"), true);
});

test("does not re-ask within the same episode; leaving roaming opens the next one", () => {
  rh._resetRoamingEpisode();
  localStorage.removeItem(rh.ROAMING_DISMISSED_KEY);
  assert.equal(ask(true, "off"), true);
  assert.equal(ask(true, "off"), false, "still in the episode");
  assert.equal(ask(true, "off"), false);
  assert.equal(ask(false, "off"), false, "roaming ended");
  assert.equal(ask(true, "off"), true, "a new episode asks again");
});

test("never asks when the mode is already on (unknown/all)", () => {
  rh._resetRoamingEpisode();
  localStorage.removeItem(rh.ROAMING_DISMISSED_KEY);
  assert.equal(ask(true, "unknown"), false);
  assert.equal(ask(true, "all"), false);
});

test("respects Don't ask again; a throwing storage fails closed", () => {
  rh._resetRoamingEpisode();
  rh.dismissRoamingHintForever(localStorage);
  assert.equal(ask(true, "off"), false);
  assert.equal(rh.roamingHintDismissed(localStorage), true);
  rh._resetRoamingEpisode();
  const boom = { getItem() { throw new Error("full"); }, setItem() { throw new Error("full"); } };
  assert.equal(rh.roamingHintDismissed(boom), true, "unreadable storage counts as dismissed");
});

test("Android command and app wiring exist", () => {
  assert.match(src("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/NetInfo.kt"), /fun isRoaming\(context: Context\): Boolean/);
  assert.match(src("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/NetInfo.kt"), /isNetworkRoaming/);
  const rust = src("../velta-app/src-tauri/src/lib.rs");
  assert.match(rust, /fn is_network_roaming\(\) -> Result<bool, String>/);
  assert.match(rust, /"isRoaming",\s*\n\s*"\(Landroid\/content\/Context;\)Z"/);
  assert.match(rust, /get_battery_status, is_network_roaming, push::push_status,/);
  const app = src("../app/js/app.js");
  assert.match(app, /invoke\("is_network_roaming"\)/);
  assert.match(app, /addEventListener\("online", \(\) => \{ netWatch\.onSignal\("online"\); askRoamingHint\(\)/);
  assert.match(app, /netWatch\.onSignal\("visible"\); askRoamingHint\(\)/);
  assert.match(app, /askRoamingHint\(\); \} catch \{ \/\* no shell \*\/ \}/);
});
