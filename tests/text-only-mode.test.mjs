import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issues #300/#310 — Text-only mode: device-global renderer gate, Auto limited
// to 1:1 contact requests, no phantom attachment cards, and session reveals.

// --- policy module (stub localStorage before the import) ---
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const to = await import("../app/js/text-only-mode.js");

const IN = { from: 0, fromContact: { id: 42, name: "Bob" } };
const SELF = { from: 1, fromContact: { id: 1, name: "Me" } };
const GROUP = { kind: "group" };
const REQUEST = { kind: "deaddrop" };
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
});

test("Auto covers only unaccepted 1:1 contact requests", () => {
  to.setTextOnlyMode("unknown");
  assert.equal(localStorage.getItem("velta-text-only"), null, "the default stores nothing");
  assert.equal(to.coversMessage(IN, REQUEST), true);
  assert.equal(to.coversMessage(IN, { kind: "single" }), false);
  assert.equal(to.coversMessage(SELF, REQUEST), false);
  assert.equal(to.coversMessage({ from: 5, fromDevice: true }, REQUEST), false);
});

test("Auto never covers group senders, even with unresolved contact data", () => {
  to.setTextOnlyMode("unknown");
  assert.equal(to.coversMessage(IN, GROUP), false);
  assert.equal(to.coversMessage({ from: 0 }, GROUP), false);
  assert.equal(to.coversMessage({ from: 0, fromContact: { id: 7, name: "Eve" } }, GROUP), false);
  assert.equal(to.coversMessage(SELF, GROUP), false);
});

test("device and service messages follow normal Auto behavior", () => {
  to.setTextOnlyMode("unknown");
  assert.equal(to.coversMessage({ from: 5, fromDevice: true }, { kind: "device" }), false);
  assert.equal(to.coversMessage({ kind: "service", from: 0 }, REQUEST), false);
});

test("reveal state is session-scoped and cleared on a mode change", () => {
  const k = to.itemKey("A", 10);
  to.revealItem(k);
  assert.equal(to.isItemRevealed(k), true);
  to.setTextOnlyMode("all");
  assert.equal(to.isItemRevealed(k), false, "state change clears the session's reveals");
});

test("wiring exists without the removed group classifier", () => {
  assert.match(src("../app/js/ui.js"), /data-textonly-opts/);
  assert.match(src("../app/js/ui.js"), /Unknown senders/);
  assert.match(src("../app/js/ui.js"), /Don't load attachments or link previews unless you choose to show them/);
  assert.match(src("../app/js/chat-view.js"), /COVERED_VIEWTYPES/);
  assert.match(src("../app/js/chat-view.js"), /hasAttachmentMetadata/);
  assert.match(src("../app/js/chat-view.js"), /dataset\.act === "reveal"/);
  assert.match(src("../app/js/chat-view.js"), /Link preview hidden/);
  assert.match(src("../app/js/chat-view.js"), /!senderPreviewBlocked\(\)/);
  assert.match(src("../app/js/chat-view.js"), /!covered && \(m\.viewtype === "image"/);
  assert.match(src("../app/js/chat-media.js"), /data-media-reveal/);
  assert.match(src("../app/js/chat-media.js"), /coveredNow/);
  assert.doesNotMatch(src("../app/js/app.js"), /setKnownContactIds/);
  assert.match(src("../app/js/app.js"), /velta-text-only-changed/);
});

// --- rendering: fake DOM ChatView (same harness as chat-msg-update-hardening) ---
const { installChatViewGlobals, installFakeDocument, installFakeFrames } = await import("./helpers/fake-dom.mjs");
installChatViewGlobals();
const { ChatView } = await import("../app/js/chat-view.js");

const msg = (o = {}) => ({
  id: 10, chatId: 7, from: 0, ts: 1700000000000, viewtype: "image",
  text: "caption here", downloadState: "Done", filePath: "x.jpg", fileName: "x.jpg",
  fromContact: { id: 42, name: "Bob", color: "#123456" }, ...o,
});

function setup(t, { messages = [msg()], kind = "deaddrop", mode = "unknown" } = {}) {
  installFakeDocument();
  installFakeFrames();
  to.setTextOnlyMode(mode);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...a) => timer(...a).unref());
  window.__TAURI__ = null;
  const downloads = [];
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async id => ({ id, kind, name: "Chat", unread: 0, encrypted: true }),
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

test("contact-request image: placeholder + caption, no media or open paths", async t => {
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
  const { view, downloads } = setup(t);
  await view.open(7);
  const row = view._renderItem(view.msgIndex.get(10));
  await row.fire("click", revealClick);
  assert.deepEqual(downloads, [], "already-downloaded content must not refetch");
  assert.equal(to.isItemRevealed(to.itemKey("A", 10)), true);
  const rebuilt = view._renderItem(view.msgIndex.get(10));
  assert.match(rebuilt.innerHTML, /data-src="image"/, "the revealed item renders its media");
});

test("real pending attachment without a local path keeps its reveal action", async t => {
  const pending = msg({ filePath: null, fileName: "photo.jpg", fileSize: 1200, downloadState: "Available" });
  const { view, downloads } = setup(t, { messages: [pending] });
  await view.open(7);
  const row = view._renderItem(view.msgIndex.get(10));
  assert.match(row.innerHTML, /msg-textonly/);
  assert.match(row.innerHTML, /Download and show/);
  await row.fire("click", revealClick);
  assert.deepEqual(downloads, [10], "retrieval happens on activation only");
});

test("off, Auto groups, and own contact-request media render directly", async t => {
  const { view } = setup(t, { mode: "off" });
  await view.open(7);
  assert.match(view._renderItem(view.msgIndex.get(10)).innerHTML, /data-src="image"/);

  const { view: group } = setup(t, { kind: "group" });
  await group.open(7);
  assert.match(group._renderItem(group.msgIndex.get(10)).innerHTML, /data-src="image"/, "Auto does not gate groups");

  const own = msg({ from: 1, fromContact: { id: 1, name: "Me" } });
  const { view: self } = setup(t, { messages: [own] });
  await self.open(7);
  assert.match(self._renderItem(self.msgIndex.get(10)).innerHTML, /data-src="image"/, "own messages are not covered");
});

test("unknown plain text never gets attachment UI or a link-free preview placeholder", async t => {
  for (const text of ["plain body", "see https://example.com/x"]) {
    const plain = msg({ viewtype: "text", text, filePath: null, fileName: null, fileSize: null, fileMime: null });
    const { view } = setup(t, { messages: [plain] });
    await view.open(7);
    const html = view._renderItem(view.msgIndex.get(10)).innerHTML;
    assert.match(html, /msg-text/);
    assert.doesNotMatch(html, /msg-textonly|msg-file|data-act="reveal"/);
    if (text.includes("https://")) {
      assert.match(html, /data-lp hidden/, "a real link keeps its separate preview slot");
      assert.doesNotMatch(html, /link-preview-card|lp-img/);
    } else {
      assert.doesNotMatch(html, /data-lp|Link preview hidden|Load preview/);
    }
  }
});

test("attachment-shaped row with no file metadata renders as text, not a phantom file", async t => {
  const phantom = msg({ viewtype: "file", text: "plain body", filePath: null, fileName: null, fileSize: null, fileMime: null });
  const { view } = setup(t, { messages: [phantom] });
  await view.open(7);
  const html = view._renderItem(view.msgIndex.get(10)).innerHTML;
  assert.match(html, /msg-text/);
  assert.doesNotMatch(html, /msg-textonly|msg-file|data-act="reveal"|data-act="download"/);
});

// --- gallery: Auto ignores groups; All preserves per-item reveal ---
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

const photos = [
  { id: 5, viewtype: "image", from: 0, filePath: "a.jpg", fileName: "a.jpg", downloadState: "Done", fromContact: { id: 42, name: "Bob" }, ts: 1e12 },
  { id: 6, viewtype: "image", from: 1, filePath: "b.jpg", fileName: "b.jpg", downloadState: "Done", ts: 1e12 },
];
const galleryCore = { accountId: "A", getChatMedia: async () => [5, 6], getMessagesByIds: async ids => photos.filter(m => ids.includes(m.id)) };

async function openGallery(root, mode) {
  installFakeDocument();
  to.setTextOnlyMode(mode);
  const { sections, ready } = mountChatMedia(root, { core: galleryCore, chatId: 7, chat: GROUP, fileUrl: p => `u/${p}` });
  await ready;
  await sections.get("photos").open();
  return root.secs.get("photos").body.children[0];
}

test("Auto group gallery renders unknown senders normally", async () => {
  const scroller = await openGallery(fakeMediaRoot(), "unknown");
  const spacer = scroller.children[0];
  assert.match(spacer.children[1].innerHTML, /<img class="media-tile-inner" src="u\/a\.jpg"/);
  assert.doesNotMatch(spacer.children[1].innerHTML, /media-textonly-cover|data-media-reveal/);
});

test("All group gallery hides a real attachment and reveals just that tile", async () => {
  const scroller = await openGallery(fakeMediaRoot(), "all");
  const coveredTile = scroller.children[0].children[1];
  assert.match(coveredTile.innerHTML, /media-textonly-cover/);
  assert.match(coveredTile.innerHTML, /data-media-reveal/);
  assert.doesNotMatch(coveredTile.innerHTML, /<img /, "no media URL on a covered tile");
  await scroller.fire("click", { target: { closest: sel => sel === "[data-media-reveal]" ? {} : (sel.includes(".media-tile") ? coveredTile : null) } });
  const after = scroller.children[0].children[1];
  assert.match(after.innerHTML, /<img class="media-tile-inner" src="u\/a\.jpg"/, "only the revealed tile loads");
});
