import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { MockCore } from "../app/js/mock-core.js";

// Issue #13: the archived-chats folder button rides getChatList's list_flags.
test("rpc-core getChatList passes DC_GCL_ARCHIVED_ONLY only when asked", async () => {
  const calls = [];
  class Probe extends JsonRpcCore {
    async _call(method, ...args) {
      calls.push([method, ...args]);
      if (method === "get_chatlist_entries") return [];
      return null;
    }
  }
  const core = new Probe();
  core.accountId = 7;
  await core.getChatList({ archived: true });
  await core.getChatList();
  assert.deepEqual(calls[0], ["get_chatlist_entries", 7, 2, null, null]);
  assert.deepEqual(calls[1], ["get_chatlist_entries", 7, null, null, null]);
});

test("mock getChatList filters archived chats", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref();
  const archived = await mock.getChatList({ archived: true });
  assert.ok(archived.length >= 1, "demo ships archived chats");
  assert.ok(archived.every(c => c.archived));
  const all = await mock.getChatList();
  assert.ok(all.every(c => !c.archived));
});
