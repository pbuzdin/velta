import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #300 — Text-only mode: device-global renderer gate (unknown / off /
// all), per-sender classification, session reveal exceptions, and the covered
// rendering paths in chat-view.js + chat-media.js.

// --- policy module (stub localStorage before the import) ---
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const to = await import("../app/js/text-only-mode.js");

const IN = { from: 0, fromContact: { id: 42, name: "Bob" } };
const SELF = { from: 1, fromContact: { id: 1, name: "Me" } };
const GROUP = { kind: "group" };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("unset/invalid preference defaults to Unknown senders", () => {
  localStorage.removeItem("velta-text-only");
  assert.equal(to.textOnlyMode(), "unknown");
  localStorage.setItem("velta-text-only", "bogus");
  assert.equal(to.textOnlyMode(), "unknown", "invalid value falls back");
});

test("off preserves current behavior; all covers every sender incl. self", () => {
  to.setTextOnlyMode("off");
  assert.equal(to.coversMessage(IN, GROUP), false);
  assert.equal(to.coversMessage(SELF, GROUP), false);
  assert.equal(to.senderPreviewBlocked(), false);
  to.setTextOnlyMode("all");
  assert.equal(to.coversMessage(IN, GROUP), true);
  assert.equal(to.coversMessage(SELF, GROUP), true);
  assert.equal(to.senderPreviewBlocked(), true, "All messages suppresses sender-side previews");
  to.setTextOnlyMode("unknown");
  assert.equal(localStorage.getItem("velta-text-only"), null, "the default stores nothing");
  assert.equal(to.coversMessage(SELF, GROUP), false);
});

test("unaccepted contact request is covered; accepted 1:1 partner is not", () => {
  to.setKnownContactIds(() => new Set());
  assert.equal(to.coversMessage(IN, { kind: "deaddrop" }), true);
  assert.equal(to.coversMessage(IN, { kind: "single" }), false);
});

test("mixed group hides only unknown senders' content; self stays normal", () => {
  to.setKnownContactIds(() => new Set([42]));
  assert.equal(to.coversMessage(IN, GROUP), false, "sender with a 1:1 chat is known");
  assert.equal(to.coversMessage({ from: 0, fromContact: { id: 7, name: "Eve" } }, GROUP), true);
  assert.equal(to.coversMessage(SELF, GROUP), false);
});

test("unresolved classification fails closed", () => {
  to.setKnownContactIds(null);
  assert.equal(to.coversMessage(IN, GROUP), true);
  to.setKnownContactIds(() => ({})); // provider without .has → unresolved
  assert.equal(to.coversMessage(IN, GROUP), true);
});

test("device messages follow normal behavior", () => {
  to.setKnownContactIds(null);
  assert.equal(to.coversMessage({ from: 5, fromDevice: true }, { kind: "device" }), false);
});

test("service messages are never covered", () => {
  assert.equal(to.coversMessage({ kind: "service", from: 0 }, GROUP), false);
});

test("reveal state is session-scoped and cleared on a mode change", () => {
  const k = to.itemKey("A", 10);
  to.revealItem(k);
  assert.equal(to.isItemRevealed(k), true);
  to.setTextOnlyMode("all");
  assert.equal(to.isItemRevealed(k), false, "state change clears the session's reveals");
});

test("wiring exists in the surfaces", () => {
  assert.match(src("../app/js/ui.js"), /data-textonly-opts/);
  assert.match(src("../app/js/ui.js"), /Unknown senders/);
  assert.match(src("../app/js/ui.js"), /Don't load attachments or link previews unless you choose to show them/);
  assert.match(src("../app/js/chat-view.js"), /COVERED_VIEWTYPES/);
  assert.match(src("../app/js/chat-view.js"), /dataset\.act === "reveal"/);
  assert.match(src("../app/js/chat-view.js"), /Link preview hidden/);
  assert.match(src("../app/js/chat-view.js"), /!senderPreviewBlocked\(\)/);
  assert.match(src("../app/js/chat-view.js"), /!covered && \(m\.viewtype === "image"/);
  assert.match(src("../app/js/chat-media.js"), /data-media-reveal/);
  assert.match(src("../app/js/chat-media.js"), /coveredNow/);
  assert.match(src("../app/js/app.js"), /setKnownContactIds\(knownContactIds\)/);
  assert.match(src("../app/js/app.js"), /velta-text-only-changed/);
});

// --- rendering: fake DOM ChatView (same harness as chat-msg-update-hardening) ---
const { installChatViewGlobals, installFakeDocument, installFakeFrames } = await import("./helpers/fake-dom.mjs");
installChatViewGlobals();
const { ChatView } = await import("../app/js/chat-view.js");

const msg = (o = {}) => ({
  id: 10, chatId: 7, from: 0, ts: 1700000000000, viewtype: "image",
  text: "caption here", downloadState: "Done", filePath: "x.jpg",
  fromContact: { id: 42, name: "Bob", color: "#123456" }, ...o,
});

function setup(t, { messages = [msg()] } = {}) {
  installFakeDocument();
  installFakeFrames();
  to.clearReveals(); // the reveal Set is module-global and shared across tests
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...a) => timer(...a).unref());
  window.__TAURI__ = null;
  const downloads = [];
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async id => ({ id, kind: "group", name: "G", unread: 0, encrypted: true }),
    getMessages: async () => ({ messages, hasMore: false }),
    getMessage: async () => messages[0],
    markRead: async () => {},
    downloadFullMessage: async (id) => { downloads.push(id); },
  });
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  view._createScroller = function () { this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} }; };
  view.startLive = () => {};
  t.after(() => { view.close(); window.__TAURI__ = null; });
  return { view, core, downloads };
}

const revealClick = { target: { closest: (sel) => (sel === "[data-act]" ? { dataset: { act: "reveal" } } : null) }, stopPropagation() {}, preventDefault() {} };

test("covered image bubble: placeholder + caption, no media, no open paths", async t => {
  to.setKnownContactIds(() => new Set()); // Bob has no 1:1 chat → unknown
  const { view } = setup(t);
  await view.open(7);
  const row = view._renderItem(view.msgIndex.get(10));
  assert.match(row.innerHTML, /msg-textonly/);
  assert.match(row.innerHTML, /Hidden — Text-only mode/);
  assert.match(row.innerHTML, /caption here/, "captions stay visible");
  assert.doesNotMatch(row.innerHTML, /data-src="image"/, "no media URL is assigned");
  assert.doesNotMatch(row.innerHTML, /data-act="download"/);
  assert.doesNotMatch(row.innerHTML, /data-act="open"/);
  assert.match(row.innerHTML, /data-act="reveal"/);
  assert.match(row.innerHTML, /Show</, "downloaded content offers Show, not Download and show");
});

test("reveal (Done) does not call downloadFullMessage and re-renders the media", async t => {
  to.setKnownContactIds(() => new Set());
  const { view, downloads } = setup(t);
  await view.open(7);
  const row = view._renderItem(view.msgIndex.get(10));
  await row.fire("click", revealClick);
  assert.deepEqual(downloads, [], "already-downloaded content must not refetch");
  assert.equal(to.isItemRevealed(to.itemKey("A", 10)), true);
  const rebuilt = view._renderItem(view.msgIndex.get(10));
  assert.match(rebuilt.innerHTML, /data-src="image"/, "the revealed item renders its media");
});

test("reveal of not-downloaded content downloads only after activation", async t => {
  to.setKnownContactIds(() => new Set());
  const { view, downloads } = setup(t, { messages: [msg({ downloadState: "None" })] });
  await view.open(7);
  const row = view._renderItem(view.msgIndex.get(10));
  assert.match(row.innerHTML, /Download and show/);
  await row.fire("click", revealClick);
  assert.deepEqual(downloads, [10], "retrieval happens on activation only");
});

test("off renders media directly; self and known senders stay normal", async t => {
  to.setTextOnlyMode("off");
  const { view } = setup(t);
  await view.open(7);
  assert.match(view._renderItem(view.msgIndex.get(10)).innerHTML, /data-src="image"/);

  to.setTextOnlyMode("unknown");
  to.setKnownContactIds(() => new Set([42]));
  const { view: v2 } = setup(t, { messages: [msg()] });
  await v2.open(7);
  assert.match(v2._renderItem(v2.msgIndex.get(10)).innerHTML, /data-src="image"/, "known sender is not covered");

  const { view: v3 } = setup(t, { messages: [msg({ from: 1, fromContact: { id: 1, name: "Me" } })] });
  await v3.open(7);
  assert.match(v3._renderItem(v3.msgIndex.get(10)).innerHTML, /data-src="image"/, "own messages are not covered");
});

test("covered text message keeps the link-preview slot dark at build time", async t => {
  // The fake DOM does not parse innerHTML, so hydration (where the #300 gate
  // lives) is covered by the source assertions above; here we pin that a
  // covered message's slot renders hidden and carries no preview markup.
  to.setKnownContactIds(() => new Set());
  const { view } = setup(t, { messages: [msg({ viewtype: "text", text: "see https://example.com/x", filePath: null })] });
  await view.open(7);
  const row = view._renderItem(view.msgIndex.get(10));
  assert.match(row.innerHTML, /data-lp hidden/);
  assert.doesNotMatch(row.innerHTML, /link-preview-card|lp-img/);
});

// --- gallery (chat-media.js): mixed senders, per-item reveal ---
const { FakeElement } = await import("./helpers/fake-dom.mjs");
const { mountChatMedia } = await import("../app/js/chat-media.js");

function fakeMediaRoot() {
  const secs = new Map();
  for (const s of [{ key: "photos", label: "Photos", types: ["Image"], layout: "grid" }]) {
    const el = new FakeElement("details");
    el.hidden = true; el.open = false;
    const count = new FakeElement("span"), body = new FakeElement("div");
    el.querySelector = sel => sel === "[data-media-count]" ? count : sel === "[data-media-body]" ? body : null;
    secs.set(s.key, Object.assign(el, { count, body }));
  }
  return { secs, querySelector: sel => secs.get(/data-media="(\w+)"/.exec(sel)?.[1]) || null };
}

test("mixed gallery hides only unknown senders; reveal loads just that tile", async t => {
  installFakeDocument();
  const photos = [
    { id: 5, viewtype: "image", from: 0, filePath: "a.jpg", downloadState: "Done", fromContact: { id: 42, name: "Bob" }, ts: 1e12 },
    { id: 6, viewtype: "image", from: 1, filePath: "b.jpg", downloadState: "Done", ts: 1e12 },
  ];
  const core = { accountId: "A", getChatMedia: async () => [5, 6], getMessagesByIds: async ids => photos.filter(m => ids.includes(m.id)) };
  to.setKnownContactIds(() => new Set());
  const root = fakeMediaRoot();
  const { sections, ready } = mountChatMedia(root, { core, chatId: 7, chat: { kind: "group" }, fileUrl: p => `u/${p}` });
  await ready;
  await sections.get("photos").open();
  const spacer = root.secs.get("photos").body.children[0].children[0];
  // get_chat_media order is reversed (newest first): tile 0 = msg 6 (self), tile 1 = msg 5 (Bob).
  const ownTile = spacer.children[0], coveredTile = spacer.children[1];
  assert.match(ownTile.innerHTML, /<img class="media-tile-inner" src="u\/b\.jpg"/, "self renders normally");
  assert.match(coveredTile.innerHTML, /media-textonly-cover/);
  assert.match(coveredTile.innerHTML, /data-media-reveal/);
  assert.doesNotMatch(coveredTile.innerHTML, /<img /, "no media URL on a covered tile");
  // Reveal Bob's tile (the click handler lives on the scroller).
  const scroller = root.secs.get("photos").body.children[0];
  await scroller.fire("click", { target: { closest: sel => sel === "[data-media-reveal]" ? {} : (sel.includes(".media-tile") ? coveredTile : null) } });
  const after = scroller.children[0].children[1];
  assert.match(after.innerHTML, /<img class="media-tile-inner" src="u\/a\.jpg"/, "only the revealed tile loads");
});
