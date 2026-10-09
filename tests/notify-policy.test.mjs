import test from "node:test";
import assert from "node:assert/strict";
import { shouldNotifyIncoming } from "../app/js/notify-policy.js";

test("desktop toasts when minimized or unfocused even if the page stays visible", () => {
  const base = { tauri: true, android: false, hidden: false, minimized: false, focused: true };
  assert.equal(shouldNotifyIncoming(base), false);
  assert.equal(shouldNotifyIncoming({ ...base, hidden: true }), true);
  assert.equal(shouldNotifyIncoming({ ...base, minimized: true }), true);
  assert.equal(shouldNotifyIncoming({ ...base, focused: false }), true);
});

test("android page never toasts", () => {
  const base = { tauri: true, android: true, hidden: false, minimized: true, focused: false };
  assert.equal(shouldNotifyIncoming(base), false);
  assert.equal(shouldNotifyIncoming({ ...base, hidden: true }), false);
});

test("a plain browser never toasts", () => {
  assert.equal(shouldNotifyIncoming({ tauri: false, hidden: true, minimized: true, focused: false }), false);
});

test("the PWA (web) toasts when hidden or unfocused, never while watched", () => {
  const base = { web: true, hidden: false, minimized: false, focused: true };
  assert.equal(shouldNotifyIncoming(base), false);
  assert.equal(shouldNotifyIncoming({ ...base, hidden: true }), true);
  assert.equal(shouldNotifyIncoming({ ...base, focused: false }), true);
  // minimized is not observable on the web — hidden/unfocused carry it
  assert.equal(shouldNotifyIncoming({ ...base, minimized: true }), false);
});

test("web flag does not leak a toast into the Tauri-only paths", () => {
  assert.equal(shouldNotifyIncoming({ web: false, tauri: false, hidden: true }), false);
  assert.equal(shouldNotifyIncoming({ web: true, android: true, hidden: true }), false);
});
