import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// Desktop message menu as the bubble action bar: right-click / ⋮ opens a chip
// row (quick-reaction emoji + smiley for the searchable tray, then icon+label
// action chips). Touch keeps the sheet.

installChatViewGlobals();
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");

const message = (id, text) => ({
  id, chatId: 7, ts: Date.now() + id, viewtype: "text", state: "sent",
  fromContact: { name: "Me" }, text,
});
const page = (messages) => ({ messages, hasMore: false });

function setup(t, core) {
  const node = installFakeDocument();
  installFakeFrames();
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => timer(...args).unref());
  // Desktop menu path: the fake DOM's default matchMedia reads as coarse
  // (touch), which would silently take the sheet instead.
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

test("right-click opens the chip bar with reactions and labeled action chips", async (t) => {
  const setReaction = t.mock.fn(async () => {});
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "hello")]),
    markRead: async () => {},
    setReaction,
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  const menu = node("popups").querySelector(".ctx-menu");
  assert.ok(menu.className.includes("msg-action-bar"), "chip bar, not the sheet");
  assert.ok(!menu.className.includes("msg-sheet"), "desktop bar, not the mobile sheet");
  // Two rows: quick-reaction emoji on top, action chips below.
  const reacts = [...menu.querySelector(".msg-bar-reacts").querySelectorAll(".msg-bar-react")];
  assert.equal(reacts.length, 12, "11 quick reactions + the smiley");
  const actions = [...menu.querySelector(".msg-bar-chips").querySelectorAll(".msg-bar-chip")].map(b => b.innerHTML);
  assert.ok(actions.some(h => h.includes(">Delete<")), "Delete chip");
  assert.ok(!actions.some(h => h.includes(">React<")), "no React item left");
  assert.ok(!actions.some(h => h.includes(">Reply<")), "Reply lives on the hover pill, not twice");
  assert.ok(actions.some(h => h.includes(">Save<")), "Save uses the short label");

  const like = reacts.find(b => b.getAttribute("aria-label") === "👍");
  await like.fire("click");
  assert.deepEqual(setReaction.mock.calls[0].arguments, [7, 11, ["👍"]]);
  closeAllPopups();
});

test("P2P chats get a chip bar without the reaction section", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true, isP2p: true }),
    getMessages: async () => page([message(11, "hello")]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  const menu = node("popups").querySelector(".ctx-menu");
  assert.ok(!menu.querySelector(".msg-bar-react"), "local P2P chats carry no reactions");
  closeAllPopups();
});

test("smiley swaps the chips for the searchable tray and back", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "hello")]),
    markRead: async () => {},
    setReaction: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  const menu = node("popups").querySelector(".ctx-menu");
  await menu.querySelector(".msg-bar-more").fire("click");
  const tray = menu.querySelector(".msg-emoji-tray");
  assert.equal(tray.hidden, false, "tray visible after the smiley");
  assert.equal(menu.querySelector(".msg-bar-reacts").hidden, true, "emoji row swapped out");
  assert.equal(menu.querySelector(".msg-bar-chips").hidden, true, "action row swapped out");
  assert.ok(tray.querySelectorAll(".msg-emoji").length > 100, "full emoji grid painted");
  await tray.querySelector(".msg-emoji-back").fire("click");
  assert.equal(tray.hidden, true, "Back returns to the chips");
  assert.equal(menu.querySelector(".msg-bar-reacts").hidden, false, "emoji row visible again");
  assert.equal(menu.querySelector(".msg-bar-chips").hidden, false, "action row visible again");
  closeAllPopups();
});

test("the bar stays inside the viewport for a message taller than the screen", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "hello")]),
    markRead: async () => {},
    setReaction: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);
  // The fake DOM's rects are 0×0, so both bubble edges degenerate — exactly
  // the tall-message case: anchor.top and anchor.bottom are both useless and
  // the viewport clamp is what keeps the bar reachable.
  globalThis.innerHeight = 300;
  t.after(() => { delete globalThis.innerHeight; });

  // Right-click low on a tall message: the bar must not open below the fold.
  view._msgContextMenu(view.msgIndex.get(11), 10, 290);
  let menu = node("popups").querySelector(".msg-action-bar");
  assert.ok(menu, "bar opened for the right-click");
  const lowTop = parseFloat(menu.style.top);
  assert.ok(lowTop >= 8, "never above the viewport top");
  assert.ok(lowTop <= 300 - 8, "never below the viewport bottom");
  closeAllPopups();

  // And near the top: the clamp keeps the 8px margin.
  view._msgContextMenu(view.msgIndex.get(11), 10, 4);
  menu = node("popups").querySelector(".msg-action-bar");
  assert.ok(menu, "bar opened near the top");
  assert.ok(parseFloat(menu.style.top) >= 8, "clamped to the 8px top margin");
  closeAllPopups();
});
