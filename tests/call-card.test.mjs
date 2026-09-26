import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { MockCore } from "../app/js/mock-core.js";

// Issue #8: call messages (core viewtype Call) render as call cards fed by
// call_info state. The wrapper caches per msgId — chat rows re-mount on
// every scroll pass and an ended call's state is terminal.
test("rpc-core maps the Call viewtype and caches call state", async () => {
  const core = new JsonRpcCore();
  core.accountId = 3;
  assert.equal(core._mapViewtype("Call"), "call");
  const calls = [];
  core._call = async (method, ...args) => {
    calls.push([method, ...args]);
    return { sdpOffer: "sdp", hasVideo: false, state: { kind: "Completed", duration: 74 } };
  };
  const first = await core.callState(40);
  assert.deepEqual(first, { kind: "Completed", duration: 74 });
  assert.deepEqual(calls[0], ["call_info", 3, 40]);
  await core.callState(40);
  assert.equal(calls.length, 1); // second read comes from the cache
  core._beginAccountChange();
  assert.equal(core._callStateCache.size, 0); // ids are per-account
});

test("mock core serves call state for demo call messages", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref();
  const ada = mock.chats.find(c => c.id === 12);
  const callMsg = mock._mkMsg(ada, { from: 2, viewtype: "call", text: "", callDuration: 134, ts: Date.now() });
  ada.messages.push(callMsg);
  const state = await mock.callState(callMsg.id);
  assert.deepEqual(state, { kind: "Completed", duration: 134 });
  await assert.rejects(() => mock.callState(999999));
});
