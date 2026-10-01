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

test("android page toasts only while the document is hidden", () => {
  const base = { tauri: true, android: true, hidden: false, minimized: true, focused: false };
  assert.equal(shouldNotifyIncoming(base), false);
  assert.equal(shouldNotifyIncoming({ ...base, hidden: true }), true);
});

test("a plain browser never toasts", () => {
  assert.equal(shouldNotifyIncoming({ tauri: false, hidden: true, minimized: true, focused: false }), false);
});
