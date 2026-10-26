import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// Incoming (and sent) messages for the open chat are queued and applied
// once per frame: one insert + one scroller setItems per batch.

installChatViewGlobals();
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");

const message = (id, chatId = 7, overrides = {}) => ({
  id, chatId, from: 2, text: `message ${id}`, ts: 1700000000000,
  viewtype: "text", state: "received", fromContact: { name: "Bob" }, ...overrides,
});

function setup(t) {
  installFakeDocument();
  installFakeFrames();
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => timer(...args).unref());
  window.__TAURI__ = null;
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async id => ({ id, kind: "single", unread: 0, encrypted: true }),
    getMessages: async id => ({ messages: [message(10, id)], hasMore: true }),
    markRead: async () => {},
  });
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  let setItemsCalls = 0;
  view._createScroller = function () {
    this.vs = { stop() {}, setItems() { setItemsCalls++; }, onItemHeightDidChange() {} };
  };
  view.startLive = () => {};
  t.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; });
  return { view, core, setItems: () => setItemsCalls };
}

const msgIds = view => view.items.filter(i => i.type === "msg").map(i => i.msg.id);

test("a burst of incoming messages is applied in one insert and one re-measure", async t => {
  const { view, setItems } = setup(t);
  await view.open(7);
  const before = setItems();
  for (let id = 11; id <= 110; id++) view.onIncoming(7, message(id));
  assert.equal(view.msgIndex.has(11), false, "queued, not applied synchronously");
  view.flushArrivals();
  assert.equal(setItems() - before, 1, "one setItems for the whole burst");
  const ids = msgIds(view);
  assert.deepEqual(ids.slice(-100), Array.from({ length: 100 }, (_, i) => 11 + i), "arrival order kept");
});

test("duplicates within a batch collapse; a known id updates in place", async t => {
  const { view } = setup(t);
  await view.open(7);
  let updated = 0;
  const orig = view.onMsgUpdated.bind(view);
  view.onMsgUpdated = (c, m) => { updated++; return orig(c, m); };
  view.onIncoming(7, message(11, 7, { text: "placeholder" }));
  view.onIncoming(7, message(12));
  view.onIncoming(7, message(11, 7, { text: "full" }));
  view.onIncoming(7, message(10)); // already loaded
  view.flushArrivals();
  assert.deepEqual(msgIds(view), [10, 11, 12]);
  assert.equal(view.msgIndex.get(11).msg.text, "full", "the later copy wins");
  assert.equal(updated, 1, "the loaded id went through onMsgUpdated");
});

test("switching chats mid-batch drops the old chat's queue", async t => {
  const { view } = setup(t);
  await view.open(7);
  view.onIncoming(7, message(11, 7));
  view.onIncoming(7, message(12, 7));
  await view.open(8);
  view.flushArrivals();
  assert.equal(view._arrivals, null);
  assert.deepEqual(msgIds(view), [10]);
  assert.equal(view.msgIndex.has(11), false);
});

test("an own send flushes queued incoming first, so ordering holds", async t => {
  const { view, setItems } = setup(t);
  await view.open(7);
  const before = setItems();
  view.onIncoming(7, message(11));
  view.appendOutgoing(message(12, 7, { from: 1, state: "sent" }));
  assert.deepEqual(msgIds(view), [10, 11, 12], "applied synchronously, in order");
  assert.equal(setItems() - before, 1, "incoming + own send share one re-measure");
});

test("an incoming burst near the bottom schedules one markRead; away from it bumps the badge per message", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  view.markReadDebounceMs = 1;
  let reads = 0;
  core.markRead = async () => { reads++; };
  view._nearBottom = () => true;
  for (let id = 11; id <= 20; id++) view.onIncoming(7, message(id));
  view.flushArrivals();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, 10).ref());
  assert.equal(reads, 1);

  view._nearBottom = () => false;
  view._newWhileAway = 0;
  for (let id = 21; id <= 25; id++) view.onIncoming(7, message(id));
  view.flushArrivals();
  assert.equal(view._newWhileAway, 5, "unread badge counts every message");
});
