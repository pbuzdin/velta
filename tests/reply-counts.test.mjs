import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// Stub DOM first: chat-view's module graph registers custom elements.
installChatViewGlobals();
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");

// Reply counts: messages quoting a bubble (quote.messageId = the quoted
// message) are counted on the quoted bubble as "N replies", with a
// "Show replies" context-menu item that jumps to the newest reply. The chip
// renders only when hasMore is false — a partially loaded window would
// silently under-count.

const message = (id, overrides = {}) => ({
  id, chatId: 7, ts: Date.now() + id, viewtype: "text", state: "sent",
  fromContact: { name: "Me" }, text: `msg ${id}`, ...overrides,
});
const parent = () => message(11, { text: "parent" });
const reply = (id, quoteId, ts) => message(id, { ts, text: `reply ${id}`, quote: { id: quoteId, text: "parent" } });
const page = (messages, hasMore = false) => ({ messages, hasMore });

function setup(t, core) {
  const node = installFakeDocument();
  installFakeFrames();
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => timer(...args).unref());
  window.__TAURI__ = null;
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  view._createScroller = function () {
    this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} };
  };
  view.startLive = () => {};
  t.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; });
  return { view, node };
}

test("quoted messages count on the parent bubble with a jump chip", async (t) => {
  const jumps = [];
  const base = Date.now();
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([
      parent(),
      reply(12, 11, base + 1000),
      reply(13, 11, base + 2000),
      message(14, { text: "unrelated" }),
    ]),
    markRead: async () => {},
  });
  const { view } = setup(t, core);
  view._jumpToMessage = (id) => jumps.push(id);
  await view.open(7);

  const counts = view._replyCounts.get(11);
  assert.equal(counts.count, 2);
  assert.equal(counts.newestId, 13, "newest reply wins by ts");

  const parentRow = view._renderMsgItem(view.msgIndex.get(11));
  assert.ok(parentRow.innerHTML.includes("2 replies"), "chip renders on the parent");
  assert.ok(parentRow.innerHTML.includes('data-act="show-replies"'), "chip is wired to the jump action");
  const plainRow = view._renderMsgItem(view.msgIndex.get(14));
  assert.ok(!plainRow.innerHTML.includes("replies"), "no chip on non-quoted messages");

  // The chip jumps to the NEWEST reply.
  view._showReplies({ id: 11 });
  assert.deepEqual(jumps, [13]);
});

test("menu carries Show replies only when replies exist", async (t) => {
  const base = Date.now();
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([parent(), reply(12, 11, base + 500), message(14, { text: "plain" })]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
  const jumps = [];
  view._jumpToMessage = (id) => jumps.push(id);
  await view.open(7);
  const parentItem = view.msgIndex.get(11);
  const plainItem = view.msgIndex.get(14);
  assert.equal(view._replyCounts.get(11).count, 1);
  assert.equal(view._replyCounts.get(14), undefined);

  view._msgContextMenu(parentItem, 10, 10);
  const menu = node("popups").querySelector(".ctx-menu");
  const show = [...menu.querySelectorAll("button")].find(b => b.innerHTML.includes("Show replies"));
  assert.ok(show, "Show replies on a quoted parent");
  await show.fire("click");
  assert.deepEqual(jumps, [12], "fires the jump to the newest reply");
  closeAllPopups();

  view._msgContextMenu(plainItem, 10, 10);
  const plain = node("popups").querySelector(".ctx-menu");
  assert.ok(![...plain.querySelectorAll("button")].some(b => b.innerHTML.includes("Show replies")), "none on a plain message");
  closeAllPopups();
});

test("partially loaded history shows no counts (they would under-count)", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([parent(), reply(12, 11, Date.now() + 1)], true),
    markRead: async () => {},
  });
  const { view } = setup(t, core);
  await view.open(7);
  assert.equal(view.hasMore, true);
  assert.ok(!view.listEl.innerHTML.includes("replies"), "no chip while older pages are missing");
});

test("deleting a reply drops it off the count", async (t) => {
  const base = Date.now();
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([
      parent(),
      reply(12, 11, base + 1000),
      reply(13, 11, base + 2000),
    ]),
    markRead: async () => {},
  });
  const { view } = setup(t, core);
  await view.open(7);
  assert.equal(view._replyCounts.get(11).count, 2);
  view.onMsgsDeleted(7, [13]);
  const counts = view._replyCounts.get(11);
  assert.equal(counts.count, 1);
  assert.equal(counts.newestId, 12, "newest falls back to the surviving reply");
});

// Velta #14 backend present: counts come from get_reply_counts (exact for
// every chat — no hasMore guard) and "Show replies" opens the thread overlay
// (get_reply_ids + getMessage), tapping a reply jumping to it in the chat.
test("core reply counts drive chips even with unloaded pages", async (t) => {
  const base = Date.now();
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([parent(), reply(12, 11, base + 500)], true),
    markRead: async () => {},
    getReplyCounts: async () => ({ 11: 5 }),
    getReplyIds: async () => [12, 13],
    getMessage: async (id) => ({ id, chatId: 7, text: `reply ${id}`, ts: base + id, viewtype: "text", state: "sent", fromContact: { name: "Me" } }),
  });
  const { view } = setup(t, core);
  await view.open(7);
  assert.equal(view.hasMore, true, "history is partially loaded");
  await view._refreshCoreReplyCounts();
  assert.equal(view._coreReplies, true);
  const row = view._renderMsgItem(view.msgIndex.get(11));
  assert.ok(row.innerHTML.includes("5 replies"), "core count wins over the loaded-window count");
});

test("Show replies opens the thread overlay with parent and replies", async (t) => {
  const base = Date.now();
  const idsCalled = [];
  const messagesFetched = [];
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([parent(), reply(12, 11, base + 500), reply(13, 11, base + 600)]),
    markRead: async () => {},
    getReplyCounts: async () => ({ 11: 2 }),
    getReplyIds: async (chatId, messageId) => { idsCalled.push([chatId, messageId]); return [12, 13]; },
    getMessage: async (id) => { messagesFetched.push(id); return message(id, { text: `reply ${id}`, quote: { id: 11, text: "parent" } }); },
  });
  const { view } = setup(t, core);
  await view.open(7);
  await view._refreshCoreReplyCounts();
  console.error("DBG pre-show:", view._coreReplies, typeof view.core.getReplyIds, view.chat?.id, view._session && !!view._session);
  await view._showReplies(parent());
  console.error("DBG post-show: idsCalled", JSON.stringify(idsCalled), "messagesFetched", JSON.stringify(messagesFetched), "overlay", !!document.getElementById("popups").querySelector(".pop-overlay"));

  // the overlay branch ran, both replies were fetched for the thread
  assert.deepEqual(idsCalled, [[7, 11]], "reply ids fetched for the quoted message");
  assert.deepEqual(messagesFetched.sort(), [12, 13], "each reply loaded");
  const overlay = document.getElementById("popups").querySelector(".pop-overlay");
  assert.ok(overlay, "overlay mounted");
  assert.equal(overlay.querySelectorAll('[data-msgid="12"]').length, 1, "reply 12 rendered");
  assert.equal(overlay.querySelectorAll('[data-msgid="13"]').length, 1, "reply 13 rendered");

  // without the #14 core RPCs the same call falls back to the jump
  const jumpView = new ChatView(core, { onChatsChanged() {}, onForward() {} });
  jumpView._createScroller = function () { this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} }; };
  jumpView.startLive = () => {};
  const jumps = [];
  jumpView._jumpToMessage = (id) => jumps.push(id);
  delete jumpView.core.getReplyIds;
  delete jumpView.core.getReplyCounts;
  t.after(() => jumpView.close());
  await jumpView.open(7);
  await jumpView._showReplies(parent());
  assert.equal(jumps.length, 1, "fallback jumps to the newest loaded reply");
});
