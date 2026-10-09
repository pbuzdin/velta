import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");

// Run the production relaySegmentDisplayState, not a copy.
const start = source.indexOf("const RELAY_OFFLINE_AFTER_MS");
const end = source.indexOf("// The core exposes per-transport status", start);
assert.ok(start !== -1 && end > start, "RELAY_OFFLINE_AFTER_MS markers moved");
const script = new Script(source.slice(start, end), {
  filename: "app/js/app.js",
  lineOffset: source.slice(0, start).split("\n").length - 1,
});
const context = createContext({ Date });
script.runInContext(context);
// Top-level const bindings don't land on the context object — read them back
// from the context's persistent global lexical scope.
new Script("this.__out = { RELAY_OFFLINE_AFTER_MS, relaySegmentDisplayState };").runInContext(context);
const { RELAY_OFFLINE_AFTER_MS: GRACE, relaySegmentDisplayState: display } = context.__out;

test("#108: fresh probe failure keeps the core's state (green -> unreachable amber)", () => {
  const now = Date.now();
  assert.equal(display("ok", { ok: true, ts: now }), "ok");
  assert.equal(display("ok", { ok: false, ts: now }), "unreachable");
  assert.equal(display("connecting", { ok: false, ts: now }), "connecting", "blip stays amber");
  assert.equal(display("down", { ok: false, ts: now }), "down");
});

test("#108: sustained probe failure drops the segment to grey offline", () => {
  const now = Date.now();
  const stale = now - GRACE - 1000;
  assert.equal(display("ok", { ok: false, ts: stale, failedSince: stale }), "offline");
  assert.equal(display("connecting", { ok: false, ts: stale, failedSince: stale }), "offline");
  assert.equal(display("unreachable", { ok: false, ts: now, failedSince: stale }), "offline", "failedSince carries the first failure, not the latest probe");
  assert.equal(display("down", { ok: false, ts: now, failedSince: stale }), "offline");
});

test("#108: inside the grace window and missing timestamps stay put", () => {
  const now = Date.now();
  assert.equal(display("connecting", { ok: false, ts: now, failedSince: now - GRACE + 1 }), "connecting");
  assert.equal(display("connecting", { ok: null }), "connecting", "pending probe never escalates");
  assert.equal(display("ok", null), "ok");
});
