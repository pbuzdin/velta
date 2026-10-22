import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// Regressions from the 2026-10-22 Android report:
// A) a 16-member group showed no thread button / counts although incoming
//    replies quoted an on-screen bubble — the #14 core matched raw
//    "<id>" In-Reply-To headers against bare rfc724_mid (0 for every
//    incoming reply) and the chat view then IGNORED the loaded-window
//    count whenever the core answered.
// B) a message shown in the chat list never appeared in history (even after
//    reopen): an IncomingMsg invalidation that landed while get_message_ids
//    was in flight was overwritten by the stale answer, which stayed cached;
//    plus refetched copies without `replies` rebuilt rows in a loop
//    ("row mNNN rebuilt: no field diff").

installChatViewGlobals();
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");
const { diagnosticsSink } = await import("../app/js/diagnostics.js");

const message = (id, o = {}) => ({ id, chatId: 7, ts: 1_700_000_000_000 + id * 1000, viewtype: "text", state: "sent", fromContact: { name: "V" }, text: `msg ${id}`, ...o });
const reply = (id, q, o = {}) => message(id, { quote: { id: q, text: "parent" }, ...o });

function setup(t, core) {
  installFakeDocument();
  installFakeFrames();
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...a) => timer(...a).unref());
  window.__TAURI__ = null;
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  view._createScroller = function () { this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} }; };
  view.startLive = () => {};
  t.after(() => { view.close(); closeAllPopups(); });
  return view;
}

const baseCore = (msgs, extra = {}) => Object.assign(new EventTarget(), {
  accountId: "A", accountEpoch: 0,
  getChat: async () => ({ id: 7, kind: "group", unread: 0, encrypted: true }),
  getMessages: async () => ({ messages: msgs(), hasMore: false }),
  markRead: async () => {},
  ...extra,
});

test("A: incoming replies count even when the core under-counts (max of core and window)", async (t) => {
  const msgs = () => [message(11, { from: 1 }), reply(12, 11, { from: 2 }), reply(13, 11, { from: 2 })];
  const view = setup(t, baseCore(msgs, { getReplyCounts: async () => ({}) }));
  await view.open(7);
  await view._refreshCoreReplyCounts();
  assert.equal(view._coreReplies, true);
  assert.equal(view._replyCountFor(11), 2, "window replies are not thrown away");
  const row = view._renderMsgItem(view.msgIndex.get(11));
  assert.ok(row.innerHTML.includes('aria-label="Show 2 replies"'), "thread button on the parent");
});

test("A: core counts cover a parent whose replies are not loaded, and live replies add up", async (t) => {
  const msgs = () => [message(20), message(21)];
  let core = { 20: 4 };
  const view = setup(t, baseCore(msgs, { getReplyCounts: async () => core }));
  await view.open(7);
  await view._refreshCoreReplyCounts();
  assert.ok(view._renderMsgItem(view.msgIndex.get(20)).innerHTML.includes("Show 4 replies"));
  // own/incoming reply lands before the debounced core refresh
  view._insertItems(view._annotateMessages([reply(22, 21)], view.items.at(-1).dayKey));
  assert.equal(view._replyCountFor(21), 1, "live reply counts immediately");
  core = { 20: 4, 21: 1 };
  await view._refreshCoreReplyCounts();
  assert.equal(view._replyCountFor(21), 1, "no double count once the core catches up");
});

test("B: refetched copies without a reply count do not rebuild rows or log 'no field diff'", async (t) => {
  const msgs = () => [message(31), reply(32, 31)];
  const view = setup(t, baseCore(msgs, { getReplyCounts: async () => ({ 31: 1 }) }));
  await view.open(7);
  await view._refreshCoreReplyCounts();
  const item = view.msgIndex.get(31);
  view._rowSigCache.set(item.key, view._rowSignature(item.msg));
  const logged = [];
  t.mock.method(diagnosticsSink, "append", (lvl, line) => logged.push(line));
  for (let i = 0; i < 5; i++) view.onMsgUpdated(7, message(31)); // fresh copy, no `replies`
  assert.equal(view.msgIndex.get(31).msg.replies, 1, "count survives the refetch");
  assert.deepEqual(logged.filter(l => /rebuilt/.test(l)), [], "no rebuild noise");
  // a real content change still logs, with the field named
  view.onMsgUpdated(7, message(31, { text: "edited" }));
  assert.ok(logged.some(l => /row m31 rebuilt: text:/.test(l)));
});

test("B: an invalidation during get_message_ids does not cache the stale id list", async () => {
  const { JsonRpcCore } = await import("../app/js/rpc-core.js");
  const core = new JsonRpcCore({});
  core.accountId = 1;
  let ids = [1, 2, 3], release;
  core._call = async () => { const snap = [...ids]; await new Promise(r => { release = r; }); return snap; };
  const p = core.getMessageIds(7);
  // IncomingMsg for msg 4 lands while the fetch is in flight
  ids = [1, 2, 3, 4];
  core._invalidateChat(7, core.accountEpoch);
  release();
  assert.deepEqual(await p, [1, 2, 3]);
  assert.equal(core.msgIdCache.get(7), undefined, "stale answer not cached");
  core._call = async () => [...ids];
  assert.deepEqual(await core.getMessageIds(7), [1, 2, 3, 4], "reopen sees the new message");
});
