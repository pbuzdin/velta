import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// #161: right-click / long-press on a link in a bubble → copy / share / open
// that URL. The link items ride the ordinary message menu (_msgContextMenu's
// linkHref argument); copy uses the tracker-stripped URL a click would open.

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
  window.__TAURI__ = null;
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  view._createScroller = function () {
    this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} };
  };
  view.startLive = () => {};
  t.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; });
  return { view, node };
}

const LINK = "https://example.com/page?utm_source=instagram&utm_campaign=x";
const STRIPPED = "https://example.com/page";

// The fake DOM resolves one simple selector at a time: find the menu, then
// its buttons. textContent stays empty there, so match on innerHTML.
const menuButtons = (node) => {
  const menu = node("popups").querySelector(".ctx-menu");
  return menu ? [...menu.querySelectorAll("button")] : [];
};
const menuLabels = (node) => menuButtons(node).map(b => b.innerHTML);

test("link gestures get Copy/Open on the link's URL", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "see " + LINK)]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  view._msgContextMenu(view.msgIndex.get(11), 10, 10, LINK);
  const labels = menuLabels(node);
  assert.ok(labels.some(l => l.includes("Copy link")), "Copy link present");
  assert.ok(labels.some(l => l.includes("Open link")), "Open link present");
  assert.ok(!labels.some(l => l.includes("Share link")), "Share hidden where no share path exists");

  const copied = t.mock.fn();
  globalThis.navigator.clipboard = { writeText: copied };
  const copy = menuButtons(node).find(b => b.innerHTML.includes("Copy link"));
  await copy.fire("click");
  assert.equal(copied.mock.calls[0].arguments[0], STRIPPED, "copies the tracker-stripped URL");
  closeAllPopups();
});

test("no linkHref (or non-http) keeps the menu link-free", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "see " + LINK)]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  assert.ok(!menuLabels(node).some(l => l.includes("Copy link")), "plain gesture: no link items");
  closeAllPopups();

  view._msgContextMenu(view.msgIndex.get(11), 10, 10, "mailto:a@b.c");
  assert.ok(!menuLabels(node).some(l => l.includes("Copy link")), "non-http href: no link items");
  closeAllPopups();
});

test("Share link is touch-only; desktop keeps Copy + Open", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "see " + LINK)]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  // Share path available (Web Share, as on WebView2/iPad) — the desktop menu
  // still must not offer it.
  const prevMatch = globalThis.matchMedia;
  const prevShare = globalThis.navigator.share;
  globalThis.matchMedia = (q) => ({ matches: q === "(hover: hover) and (pointer: fine)" });
  globalThis.navigator.share = async () => {};
  t.after(() => {
    if (prevMatch === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = prevMatch;
    if (prevShare === undefined) delete globalThis.navigator.share; else globalThis.navigator.share = prevShare;
  });

  view._msgContextMenu(view.msgIndex.get(11), 10, 10, LINK);
  const menu = node("popups").querySelector(".ctx-menu");
  assert.ok(!menu.className.includes("msg-sheet"), "fine pointer opens the desktop menu");
  const labels = menuLabels(node);
  assert.ok(labels.some(l => l.includes("Copy link")), "Copy link on desktop");
  assert.ok(labels.some(l => l.includes("Open link")), "Open link on desktop");
  assert.ok(!labels.some(l => l.includes("Share link")), "no Share link on desktop even with Web Share");
  closeAllPopups();

  // Coarse pointer: the sheet keeps Share (mobile has no other way to pass a
  // URL around).
  globalThis.matchMedia = () => ({ matches: false });
  view._msgContextMenu(view.msgIndex.get(11), 10, 10, LINK);
  const sheet = node("popups").querySelector(".ctx-menu");
  assert.ok(sheet.className.includes("msg-sheet"), "coarse pointer opens the sheet");
  assert.ok(menuLabels(node).some(l => l.includes("Share link")), "Share link on touch");
  closeAllPopups();
});

test("sheet lists every link in the message under Show links", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "a " + LINK + " and https://velta.cc/y")]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  const sheet = node("popups").querySelector(".ctx-menu");
  const det = sheet.querySelector(".msg-links");
  assert.ok(det, "Show links details present");
  const anchors = det.querySelectorAll("a");
  assert.equal(anchors.length, 2, "one row per distinct link");
  assert.equal(anchors[0].href, STRIPPED, "hrefs are tracker-stripped");
  assert.equal(anchors[1].href, "https://velta.cc/y");
  closeAllPopups();
});

test("the pressed single link skips the Show links list", async (t) => {
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async () => ({ id: 7, kind: "single", unread: 0, encrypted: true }),
    getMessages: async () => page([message(11, "see " + LINK)]),
    markRead: async () => {},
  });
  const { view, node } = setup(t, core);
  await view.open(7);

  // Long-press ON the link: Copy/Share/Open already target it.
  view._msgContextMenu(view.msgIndex.get(11), 10, 10, LINK);
  let sheet = node("popups").querySelector(".ctx-menu");
  assert.ok(!sheet.querySelector(".msg-links"), "no duplicate list");
  closeAllPopups();

  // Same message, gesture on plain text: the list is the only access.
  view._msgContextMenu(view.msgIndex.get(11), 10, 10);
  sheet = node("popups").querySelector(".ctx-menu");
  assert.ok(sheet.querySelector(".msg-links"), "list appears for a non-link gesture");
  closeAllPopups();
});
