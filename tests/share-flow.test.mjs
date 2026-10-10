import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import * as shareIn from "../app/js/share-in.js";

// #97: run the production share block of app.js (routeOpenedBatch ->
// inbox -> picker -> openChat -> ChatView.receiveShare) against stubs.
const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const from = source.indexOf("// #97 share-in. Android hands over");
const to = source.indexOf("async function forwardFlow(", from);
assert.ok(from !== -1 && to > from, "share block markers moved");
const block = new Script(source.slice(from, to) + "\n;globalThis.__share = { routeOpenedBatch, shareInbox, drainOpened };", {
  filename: "app/js/app.js",
  lineOffset: source.slice(0, from).split("\n").length - 1,
});

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attrs = {}; this.value = ""; this.textContent = ""; this.className = ""; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  replaceChildren(...cs) { this.children = []; for (const c of cs) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  setData(chat) { this.chat = chat; }
  addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn); }
  fire(n) { for (const fn of this.listeners[n] || []) fn({ target: this }); }
  focus() {}
}
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setTimeout(r, 0));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(); }
  throw new Error(`timed out waiting for ${what}`);
}

const DIAG = -9007199254740991;
const diagRow = { id: DIAG, name: "Velta Diagnostics", kind: "device" };

function setup({ chats = [diagRow, { id: 10, name: "Alice", kind: "single" }, { id: 12, name: "Family", kind: "group" }], accounts = [] } = {}) {
  const log = { modals: [], opened: [], received: [], toasts: [], errors: [], switched: [], refreshes: 0, deeplinks: [], taken: [] };
  const state = { chats, accounts, accountChanging: false, activeChatId: null, query: "" };
  const core = { accountId: 1, accountEpoch: 0, getChatList: async () => [], switchAccount: async id => { log.switched.push(id); ctx.__switchTo(id); } };
  let openedQueue = [];
  const ctx = createContext({
    ...shareIn,
    console, setTimeout, clearTimeout, Promise, Date,
    state, core,
    accountRefreshPromise: Promise.resolve(),
    DIAGNOSTICS_CHAT_ID: DIAG,
    navigator: { userAgent: "Android" },
    document: { createElement: tag => new El(tag) },
    window: { __TAURI__: { core: { invoke: async cmd => { log.taken.push(cmd); const q = openedQueue; openedQueue = []; return q; } } } },
    accountIsCurrent: epoch => !state.accountChanging && epoch === core.accountEpoch,
    refreshChatList: async () => { log.refreshes++; if (ctx.__nextChats) { state.chats = ctx.__nextChats; ctx.__nextChats = null; } },
    modalHistorySettled: async () => {},
    handleDeeplinkFromUrl: async url => { log.deeplinks.push(url); return url.includes("i.delta.chat"); },
    showModal: ({ title, body, onClose }) => {
      const modal = { title, body, open: true };
      modal.close = () => { if (!modal.open) return; modal.open = false; onClose?.(); };
      log.modals.push(modal);
      return { close: modal.close };
    },
    openChat: async id => { log.opened.push(id); state.activeChatId = id; },
    chatView: { receiveShare: async share => { log.received.push(share); return share.files.length > 1 ? "sent" : "staged"; } },
    toast: msg => log.toasts.push(msg),
    errToast: msg => log.errors.push(msg),
  });
  ctx.__switchTo = id => {
    // what account-changing / account-changed do in app.js
    state.accountChanging = true;
    for (const m of log.modals) m.close();
    state.chats = [];
    setTimeout(() => {
      core.accountId = id;
      core.accountEpoch++;
      state.chats = ctx.__chatsFor?.(id) || [];
      state.accountChanging = false;
    }, 5);
  };
  block.runInContext(ctx);
  const rows = modal => modal.body.children.find(c => c.className.includes("share-list")).children;
  return { ctx, state, core, log, api: ctx.__share, rows, park: urls => { openedQueue.push(...urls); } };
}

test("cold start: a share parked during boot opens a picker with the chats once boot is ready", async () => {
  const { api, log, rows, park } = setup();
  park(["data:text/plain,hello%20there", "content://media/external/images/7"]);
  await api.drainOpened();
  await tick();
  assert.equal(log.modals.length, 0, "no picker before the chat list is ready");
  api.shareInbox.ready();
  const modal = await until(() => log.modals[0], "picker");
  assert.equal(modal.title, "Share to…");
  const list = rows(modal);
  assert.deepEqual(list.map(r => r.chat?.id), [10, 12], "the chat rows are in the sheet (the #97 bug: they never were)");
  list[1].fire("click");
  await until(() => log.received.length, "delivery");
  assert.equal(modal.open, false);
  assert.deepEqual(log.opened, [12]);
  assert.deepEqual(plain(log.received), [{ text: "hello there", files: ["content://media/external/images/7"] }]);
  assert.deepEqual(log.toasts, [], "a staged share is not reported as sent");
});

test("warm start: a share while running opens the picker; several files are sent and reported", async () => {
  const { api, log, rows } = setup();
  api.shareInbox.ready();
  await api.routeOpenedBatch(["content://a/1", "content://a/2", "https://example.com/page", "https://i.delta.chat/#INVITE"]);
  const modal = await until(() => log.modals[0], "picker");
  rows(modal)[0].fire("click");
  await until(() => log.received.length, "delivery");
  assert.deepEqual(plain(log.received), [{ text: "https://example.com/page", files: ["content://a/1", "content://a/2"] }]);
  assert.deepEqual(log.deeplinks, ["https://example.com/page", "https://i.delta.chat/#INVITE"], "invite links stay with the deeplink router");
  assert.deepEqual(log.toasts, ["Sent to Alice"]);
});

test("closing the picker drops that share only; the next one still gets a picker", async () => {
  const { api, log, rows } = setup();
  api.shareInbox.ready();
  await api.routeOpenedBatch(["data:text/plain,first"]);
  (await until(() => log.modals[0], "first picker")).close();
  await api.routeOpenedBatch(["data:text/plain,second"]);
  const second = await until(() => log.modals[1], "second picker");
  rows(second)[0].fire("click");
  await until(() => log.received.length, "delivery");
  assert.deepEqual(log.received.map(r => r.text), ["second"]);
});

test("a share before the chat list loaded fetches it instead of showing an empty sheet", async () => {
  const { ctx, api, log, rows } = setup({ chats: [diagRow] });
  ctx.__nextChats = [diagRow, { id: 30, name: "Carol", kind: "single" }];
  api.shareInbox.ready();
  await api.routeOpenedBatch(["data:text/plain,x"]);
  const modal = await until(() => log.modals[0], "picker");
  assert.ok(log.refreshes >= 1);
  assert.deepEqual(plain(rows(modal).map(r => r.chat?.id)), [30]);
});

test("several profiles: switching in the picker re-lists the other profile's chats", async () => {
  const { ctx, api, log, rows } = setup({ accounts: [{ id: 1, name: "Work" }, { id: 2, name: "Home" }] });
  ctx.__chatsFor = id => id === 2 ? [diagRow, { id: 10, name: "Mum", kind: "single" }] : [];
  api.shareInbox.ready();
  await api.routeOpenedBatch(["data:text/plain,photo%20caption"]);
  const first = await until(() => log.modals[0], "picker");
  const chips = first.body.children.find(c => c.className === "share-accounts").children;
  chips[1].fire("click");
  const second = await until(() => log.modals[1], "picker on the other profile");
  assert.deepEqual(log.switched, [2]);
  assert.deepEqual(plain(rows(second).map(r => r.chat?.name)), ["Mum"]);
  rows(second)[0].fire("click");
  await until(() => log.received.length, "delivery");
  assert.deepEqual(log.opened, [10]);
  assert.deepEqual(plain(log.received), [{ text: "photo caption", files: [] }]);
});
