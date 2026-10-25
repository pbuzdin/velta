import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// #157: a channel you can't post in (readOnly, canSend=false) still shows the
// pinned-message tray, but without the ✕ unpin buttons, and the message menu
// has no Pin/Unpin chip. Your own writable chats keep both.
// (The fake DOM never attaches the tray — it's checked via view.pinnedBar.)

installChatViewGlobals();
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");

const message = (id, text) => ({
  id, chatId: 7, ts: Date.now() + id, viewtype: "text", state: "sent",
  fromContact: { name: "Owner" }, text,
});
const page = (messages) => ({ messages, hasMore: false });

function setup(t, core) {
  const node = installFakeDocument();
  installFakeFrames();
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => timer(...args).unref());
  globalThis.matchMedia = (q) => ({ matches: q === "(hover: hover) and (pointer: fine)" });
  t.after(() => { delete globalThis.matchMedia; });
  window.__TAURI__ = null;
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  view._createScroller = function () {
    this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} };
  };
  view.startLive = () => {};
  t.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; });
  return { view, node };
}

const pinnedCore = {
  accountId: "A", accountEpoch: 0,
  getChat: async () => ({ id: 7, kind: "channel", unread: 0, encrypted: true }),
  getMessages: async () => page([message(11, "hello")]),
  getMessage: async (id) => message(id, "pinned " + id),
  getPinnedMessages: async () => [11, 12],
  pinMessage: async () => {},
  markRead: async () => {},
};

const menuChips = (node) =>
  [...node("popups").querySelectorAll(".msg-bar-chip")].map(b => b.innerHTML);

test("read-only channel: pin tray without ✕, message menu without Pin", async (t) => {
  const { view, node } = setup(t, Object.assign(new EventTarget(), pinnedCore));
  await view.open(7);
  view.readOnly = true;

  await view._refreshPinnedBar();
  const tray = view.pinnedBar;
  assert.ok(tray && !tray.hidden, "tray still visible");
  // The fake DOM keeps innerHTML a string; count in it.
  assert.equal((tray.innerHTML.match(/pin-tray-item/g) || []).length, 2, "both pins listed");
  assert.ok(!tray.innerHTML.includes("data-unpin"), "no unpin buttons in someone else's channel");;

  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  const chips = menuChips(node);
  assert.ok(!chips.some(h => h.includes(">Pin<") || h.includes(">Unpin<")), "no Pin chip in the menu");
});

test("writable chat: pin tray ✕ and menu Pin chip stay", async (t) => {
  const { view, node } = setup(t, Object.assign(new EventTarget(), pinnedCore));
  await view.open(7);
  view.readOnly = false;

  await view._refreshPinnedBar();
  const tray = view.pinnedBar;
  assert.equal((view.pinnedBar.innerHTML.match(/data-unpin/g) || []).length, 2, "own chat keeps the unpin buttons");

  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  const chips = menuChips(node);
  assert.ok(chips.some(h => h.includes(">Pin<")), "Pin chip present");
});
