import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// Issue #93: peer reactions arrive as the ReactionsChanged event kind, not
// MsgsChanged. Without a handler the open chat kept stale chips until restart.

const msg = (id) => ({
  id, chatId: 4, text: "hi", fromId: 9, state: "Delivered", timestamp: 1700000000,
  reactions: { reactions: [{ emoji: "👍", count: 2, isFromSelf: false }] },
});

function probe(msgs) {
  const calls = [];
  class Probe extends JsonRpcCore {
    async _call(method, ...args) {
      calls.push([method, ...args]);
      if (method === "get_message") return msgs[args[1]];
      return null;
    }
  }
  const core = new Probe();
  core.accountId = 7;
  return { core, calls };
}

test("ReactionsChanged emits msg-updated with mapped reactions, no broad refetch (#93)", async () => {
  const { core, calls } = probe({ 11: msg(11) });
  const names = [];
  let got = null;
  for (const name of ["msg-updated", "msgs-changed", "chat-updated"]) {
    core.addEventListener(name, e => { names.push(name); if (name === "msg-updated") got = e.detail; });
  }
  await core._handleCoreEvent({ kind: "ReactionsChanged", chatId: 4, msgId: 11, contactId: 9 }, 7);
  assert.deepEqual(names, [
    "chat-updated",
    // No msgs-changed — chat-view patches the chips in place via onMsgUpdated.
    "msg-updated",
  ]);
  assert.deepEqual(got.msg.reactions, [{ emoji: "👍", count: 2, mine: false }]);
  assert.deepEqual(calls, [["get_message", 7, 11]]);
});

test("ReactionsChanged without msgId only invalidates; another account's event is dropped", async () => {
  const { core, calls } = probe({ 11: msg(11) });
  const seen = [];
  core.addEventListener("msg-updated", e => seen.push(e.detail));
  await core._handleCoreEvent({ kind: "ReactionsChanged", chatId: 4, msgId: null, contactId: 9 }, 7);
  await core._handleCoreEvent({ kind: "ReactionsChanged", chatId: 4, msgId: 11, contactId: 9 }, 8);
  assert.deepEqual(seen, []);
  assert.deepEqual(calls, []);
});
