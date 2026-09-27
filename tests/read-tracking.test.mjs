import test from "node:test";
import assert from "node:assert/strict";

// read-markers.js reads globalThis.localStorage lazily — install a stub
// before any test touches it.
const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
};

const { pageBounds, MockCore } = await import("../app/js/mock-core.js");
const { getReadMarker, setReadMarker, clearReadMarker } = await import("../app/js/read-markers.js");
const { JsonRpcCore } = await import("../app/js/rpc-core.js");

const IDS = Array.from({ length: 100 }, (_, i) => 1000 + i);
const slice = ({ start, end }) => IDS.slice(start, end);

test("pageBounds: default, beforeId and unknown ids page from the tail", () => {
  assert.deepEqual(pageBounds(IDS, { limit: 40 }), { start: 60, end: 100 });
  assert.deepEqual(pageBounds(IDS, { beforeId: 1060, limit: 40 }), { start: 20, end: 60 });
  assert.deepEqual(pageBounds(IDS, { beforeId: 5, limit: 40 }), { start: 60, end: 100 });
  assert.deepEqual(pageBounds(IDS, { aroundId: 5, limit: 40 }), { start: 60, end: 100 });
});

test("pageBounds: aroundId opens `before` messages above the anchor and keeps the page full at the tail", () => {
  const mid = slice(pageBounds(IDS, { aroundId: 1030, before: 10, limit: 60 }));
  assert.equal(mid[0], 1020);
  assert.equal(mid.length, 60);
  const nearTail = slice(pageBounds(IDS, { aroundId: 1095, before: 10, limit: 60 }));
  assert.equal(nearTail.at(-1), 1099);
  assert.equal(nearTail.length, 60);
  assert.ok(nearTail.includes(1095));
  assert.deepEqual(slice(pageBounds(IDS, { aroundId: 1003, before: 10, limit: 20 })), IDS.slice(0, 20));
});

test("pageBounds: afterId pages downwards; an unknown afterId yields an empty page, never the tail", () => {
  assert.deepEqual(pageBounds(IDS, { afterId: 1049, limit: 40 }), { start: 50, end: 90 });
  assert.deepEqual(pageBounds(IDS, { afterId: 1080, limit: 40 }), { start: 81, end: 100 });
  assert.deepEqual(pageBounds(IDS, { afterId: 1099, limit: 40 }), { start: 100, end: 100 });
  assert.deepEqual(pageBounds(IDS, { afterId: 5, limit: 40 }), { start: 100, end: 100 });
});

test("read markers are per (account, chat) and survive a clear of another slot", () => {
  store.clear();
  assert.equal(getReadMarker(1, 10), null);
  setReadMarker(1, 10, 55);
  setReadMarker(2, 10, 77);
  assert.equal(getReadMarker(1, 10), 55);
  assert.equal(getReadMarker(2, 10), 77);
  assert.equal(getReadMarker(1, 11), null);
  clearReadMarker(2, 10);
  assert.equal(getReadMarker(2, 10), null);
  assert.equal(getReadMarker(1, 10), 55);
});

test("read markers degrade to none when storage is corrupt or throws", () => {
  store.set("velta-read-markers", "{not json");
  assert.equal(getReadMarker(1, 10), null);
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  try {
    assert.equal(getReadMarker(1, 10), null);
    assert.doesNotThrow(() => setReadMarker(1, 10, 5));
    assert.doesNotThrow(() => clearReadMarker(1, 10));
  } finally {
    globalThis.localStorage = saved;
  }
});

function rpcFixture(handlers) {
  const core = new JsonRpcCore({});
  core.accountId = 1;
  const calls = [], events = [];
  core._call = async (method, ...params) => {
    calls.push([method, ...params]);
    if (Object.hasOwn(handlers, method)) return handlers[method](...params);
    throw new Error(`Unexpected RPC: ${method}`);
  };
  core.addEventListener("chat-updated", e => events.push(e.detail));
  return { core, calls, events };
}

const coreMsg = (id, { fromId = 5, state = 10, isInfo = false } = {}) =>
  ({ kind: "message", id, chatId: 7, fromId, state, isInfo, text: `m${id}`, timestamp: id, sender: { id: fromId } });

test("rpc-core maps unseen incoming states (fresh, noticed) to unread — never own or seen messages", async () => {
  const { core } = rpcFixture({
    get_message_ids: () => [1, 2, 3, 4, 5],
    get_messages: (_a, ids) => Object.fromEntries(ids.map(id => [id, {
      1: coreMsg(1, { state: 16 }),          // InSeen
      2: coreMsg(2, { state: 13 }),          // InNoticed
      3: coreMsg(3, { state: 10 }),          // InFresh
      4: coreMsg(4, { fromId: 1, state: 26 }), // own, delivered
      5: coreMsg(5, { state: 10, isInfo: true }),
    }[id]])),
  });
  const { messages, hasMore, hasNewer } = await core.getMessages(7);
  assert.deepEqual(messages.map(m => m.unread), [false, true, true, false, true]);
  assert.equal(hasMore, false);
  assert.equal(hasNewer, false);
});

test("rpc-core getMessages reports hasNewer for a window that stops short of the tail", async () => {
  const { core } = rpcFixture({
    get_message_ids: () => IDS,
    get_messages: (_a, ids) => Object.fromEntries(ids.map(id => [id, coreMsg(id)])),
  });
  const around = await core.getMessages(7, { aroundId: 1020, before: 10, limit: 30 });
  assert.equal(around.messages[0].id, 1010);
  assert.equal(around.hasMore, true);
  assert.equal(around.hasNewer, true);
  const next = await core.getMessages(7, { afterId: around.messages.at(-1).id, limit: 80 });
  assert.equal(next.messages[0].id, 1040);
  assert.equal(next.hasNewer, false);
});

test("rpc-core markSeen marks exactly the given ids on the entry account and drops the event after a switch", async () => {
  let release;
  const { core, calls, events } = rpcFixture({
    markseen_msgs: () => new Promise(r => { release = r; }),
    get_first_unread_message_of_chat: () => 42,
    select_account: () => {},
    get_selected_account_id: () => 2,
  });
  assert.equal(await core.getFirstUnreadMessageId(7), 42);
  const pending = core.markSeen(7, [3, 4]);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.find(c => c[0] === "markseen_msgs"), ["markseen_msgs", 1, [3, 4]]);
  core.accountEpoch++; // account switched while the call was in flight
  release();
  await pending;
  assert.deepEqual(events, []);
  await core.markSeen(7, []);
  assert.equal(calls.filter(c => c[0] === "markseen_msgs").length, 1, "empty batches never reach the core");
});

test("mock core keeps the chat counter in step with per-message unread flags", async () => {
  const mock = new MockCore();
  try {
    const chat = mock.chats.find(c => c.unread > 1);
    const unreadIds = chat.messages.filter(m => m.unread).map(m => m.id);
    assert.equal(unreadIds.length, chat.unread);
    assert.equal(await mock.getFirstUnreadMessageId(chat.id), unreadIds[0]);
    await mock.markSeen(chat.id, [unreadIds[0]]);
    assert.equal(chat.unread, unreadIds.length - 1);
    assert.equal(await mock.getFirstUnreadMessageId(chat.id), unreadIds[1]);
    await mock.markRead(chat.id);
    assert.equal(chat.unread, 0);
    assert.equal(await mock.getFirstUnreadMessageId(chat.id), null);
  } finally {
    clearInterval(mock._simTimer);
  }
});
