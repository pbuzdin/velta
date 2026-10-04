import test from "node:test";
import assert from "node:assert/strict";
import { batteryReactionPlan } from "../app/js/rpc-core.js";

// #83: low-battery marker decision. While low + unplugged, the 🪫 moves to
// the latest outgoing message (cleared from the previous one); when the
// state ends, the marker is removed; no-op cases must not churn reactions.

test("#83 low, first marker -> add on the sent message", () => {
  assert.deepEqual(batteryReactionPlan(101, null, true), { add: 101, clear: null });
});

test("#83 low, marker on an older message -> move (clear old, add new)", () => {
  assert.deepEqual(batteryReactionPlan(102, 101, true), { add: 102, clear: 101 });
});

test("#83 low, marker already on this message -> no-op (no churn)", () => {
  assert.deepEqual(batteryReactionPlan(101, 101, true), { add: null, clear: null });
});

test("#83 state ended (charged / feature off) -> clear the marker", () => {
  assert.deepEqual(batteryReactionPlan(102, 101, false), { add: null, clear: 101 });
});

test("#83 state ended, no marker out there -> no-op", () => {
  assert.deepEqual(batteryReactionPlan(102, null, false), { add: null, clear: null });
});
