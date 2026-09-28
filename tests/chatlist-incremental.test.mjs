import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// Issue #25: the chat list refreshes incrementally — rpc-core exposes the
// cheap entry list and per-id items separately, and surfaces the core's
// fine-grained ChatlistChanged / ChatlistItemChanged events.

const listItem = (id, name) => ({ kind: "ChatListItem", id, name, summaryText1: "", summaryText2: "" });

function probe(items) {
  const calls = [];
  class Probe extends JsonRpcCore {
    async _call(method, ...args) {
      calls.push([method, ...args]);
      if (method === "get_chatlist_entries") return args[1] === 1 ? [30, 31] : [3, 1, 2];
      if (method === "get_chatlist_items_by_entries") {
        return Object.fromEntries(args[1].filter(id => items[id]).map(id => [String(id), items[id]]));
      }
      return null;
    }
  }
  const core = new Probe();
  core.accountId = 7;
  return { core, calls };
}

test("getChatListIds returns entry ids only — no item fetch (archived count)", async () => {
  const { core, calls } = probe({});
  assert.deepEqual(await core.getChatListIds({ archived: true }), [30, 31]);
  assert.deepEqual(calls, [["get_chatlist_entries", 7, 1, null, null]]);
});

test("getChatListItems fetches just the requested ids; non-chat entries map to null", async () => {
  const { core, calls } = probe({ 2: listItem(2, "two"), 5: { kind: "ArchiveLink" }, 6: { kind: "Error", error: "x" } });
  const got = await core.getChatListItems([2, 5, 6, 9]);
  assert.deepEqual(calls, [["get_chatlist_items_by_entries", 7, [2, 5, 6, 9]]]);
  assert.equal(got.get(2).name, "two");
  assert.deepEqual([got.get(5), got.get(6), got.get(9)], [null, null, null]);
  assert.equal((await core.getChatListItems([])).size, 0);
  assert.equal(calls.length, 1, "no RPC for an empty id list");
});

test("getChatList keeps the core's entry order on top of ids + items", async () => {
  const { core } = probe({ 1: listItem(1, "one"), 2: listItem(2, "two"), 3: listItem(3, "three") });
  assert.deepEqual((await core.getChatList()).map(c => c.name), ["three", "one", "two"]);
});

test("ChatlistChanged / ChatlistItemChanged surface as chat-list events (and still invalidate)", async () => {
  const { core } = probe({});
  assert.equal(core.chatlistEvents, true);
  const seen = [];
  for (const name of ["chatlist-changed", "chatlist-item-changed", "chat-updated"]) {
    core.addEventListener(name, e => seen.push([name, { ...e.detail }]));
  }
  await core._handleCoreEvent({ kind: "ChatlistChanged" }, 7);
  await core._handleCoreEvent({ kind: "ChatlistItemChanged", chatId: 12 }, 7);
  await core._handleCoreEvent({ kind: "ChatlistItemChanged", chatId: null }, 7);
  await core._handleCoreEvent({ kind: "ChatlistItemChanged", chatId: 13 }, 8); // other account
  assert.deepEqual(seen, [
    ["chatlist-changed", {}],
    ["chat-updated", { chatId: 0 }],
    ["chatlist-item-changed", { chatId: 12 }],
    ["chat-updated", { chatId: 12 }],
    ["chatlist-item-changed", { chatId: 0 }],
    ["chat-updated", { chatId: 0 }],
  ]);
});

test("getChat fetches just that chat's item, never the whole list (#25)", async () => {
  const { core, calls } = probe({ 2: listItem(2, "two") });
  const chat = await core.getChat(2);
  assert.equal(chat.name, "two");
  assert.deepEqual(calls, [["get_chatlist_items_by_entries", 7, [2]]]);
});

test("getChat falls back to get_basic_chat_info when there is no chatlist item", async () => {
  const calls = [];
  class Probe extends JsonRpcCore {
    async _call(method, ...args) {
      calls.push(method);
      if (method === "get_chatlist_items_by_entries") return { 5: { kind: "Error", error: "gone" } };
      if (method === "get_basic_chat_info") return { name: "basic", chatType: "Group" };
      if (method === "get_fresh_msg_cnt") return 3;
      return null;
    }
  }
  const core = new Probe();
  core.accountId = 7;
  const chat = await core.getChat(5);
  assert.equal(chat.name, "basic");
  assert.equal(chat.unread, 3);
  assert.ok(!calls.includes("get_chatlist_entries"), "no full list load");
});
