import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// Stub DOM first: chat-view's module graph registers custom elements.
installChatViewGlobals();
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");

// Reply threads: messages quoting a bubble (quote.messageId = the quoted
// message) are counted on the quoted bubble as a passive "N replies" label,
// the context menu offers "Show replies", and that opens the thread panel:
// parent on top, replies beneath, composer locked to the thread.

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

test("quoted messages count on the parent bubble as a passive label", async (t) => {
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
  await view.open(7);

  const counts = view._replyCounts.get(11);
  assert.equal(counts.count, 2);
  assert.equal(counts.newestId, 13, "newest reply wins by ts");

  const parentRow = view._renderMsgItem(view.msgIndex.get(11));
  assert.ok(parentRow.innerHTML.includes("2 replies"), "count label renders on the parent");
  assert.ok(!parentRow.innerHTML.includes('data-act="show-replies"'), "the label is passive — no tap target in the meta row");
  const plainRow = view._renderMsgItem(view.msgIndex.get(14));
  assert.ok(!plainRow.innerHTML.includes("replies"), "no label on non-quoted messages");
});

test("menu Show replies opens the thread panel with the composer locked", async (t) => {
  const base = Date.now();
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([parent(), reply(12, 11, base + 500), message(14, { text: "plain" })]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
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

  assert.equal(view.thread.parentId, 11, "thread mode opened for the parent");
  assert.equal(view.threadPanel.hidden, false, "thread panel visible");
  assert.notEqual(view.listEl.hidden, true, "history stays visible above the sheet");
  assert.equal(view.threadPanel.getAttribute("role"), "dialog");
  assert.ok(view.threadPanel.querySelector(".thread-close"), "header close button");
  assert.equal(view.replyTo?.id, 11, "composer locked: quote points at the parent");
  assert.equal(document.getElementById("btn-reply-close").hidden, true, "quote-bar X hidden while locked");
  const rows = view.threadPanel.querySelectorAll('[data-msgid="12"]');
  assert.equal(rows.length, 1, "reply rendered in the panel");
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
// every chat — no hasMore guard).
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

// Thread panel end-to-end: open, locked composer, live append, exit.
test("thread panel opens, locks the composer, appends live replies, exits", async (t) => {
  const base = Date.now();
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([parent(), reply(12, 11, base + 500), reply(13, 11, base + 600)]),
    markRead: async () => {},
  });
  const { view } = setup(t, core);
  await view.open(7);
  assert.equal(view.threadPanel.hidden, true, "panel hidden before");

  await view._showReplies(parent());
  assert.equal(view.threadPanel.hidden, false, "panel visible after Show replies");
  assert.notEqual(view.listEl.hidden, true, "history stays visible above the sheet");
  assert.equal(view.threadReplies.children.length, 2, "both loaded replies rendered");
  assert.equal(view.replyTo?.id, 11, "composer locked to the parent");

  // a late reply lands in the loaded window and appends live
  const late = reply(14, 11, base + 900);
  view._insertItems(view._annotateMessages([late]));
  assert.equal(view.threadReplies.children.length, 3, "late reply appended to the panel");

  // exiting restores the history list and clears the composer lock
  view._closeThread();
  assert.equal(view.thread, null);
  assert.equal(view.threadPanel.hidden, true);
  assert.notEqual(view.listEl.hidden, true);
  assert.equal(view.replyTo, null);
});

test("side button: shown from THREAD_BUTTON_MIN_REPLIES, labelled, opens the thread; Escape closes", async (t) => {
  const { THREAD_BUTTON_MIN_REPLIES } = await import("../app/js/chat-view.js");
  assert.equal(THREAD_BUTTON_MIN_REPLIES, 1);
  const base = Date.now();
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([parent(), reply(12, 11, base + 500)]),
    markRead: async () => {},
  });
  const { view } = setup(t, core);
  await view.open(7);
  const row = view._renderMsgItem(view.msgIndex.get(11));
  assert.ok(row.innerHTML.includes('class="msg-thread-btn" data-act="thread" aria-label="Show 1 reply"'), "round button with aria-label");
  assert.ok(row.className.includes("has-thread"));
  assert.ok(row.innerHTML.includes('class="msg-replies-count">1 reply'), "passive meta count");
  const inPanel = view._renderMsgItem(view.msgIndex.get(11), { inThread: true });
  assert.ok(!inPanel.innerHTML.includes("msg-thread-btn"), "no side button inside the panel");
  const plain = view._renderMsgItem(view.msgIndex.get(12));
  assert.ok(!plain.innerHTML.includes("msg-thread-btn"));

  await view._openThread(view.msgIndex.get(11).msg);
  assert.equal(view.threadPanel.hidden, false);
  await view.threadPanel.fire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(view.thread, null);
  assert.equal(view.threadPanel.hidden, true);
});
