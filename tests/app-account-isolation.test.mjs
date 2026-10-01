import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";

const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");

// Run the production declarations, renderers and listeners, not copies of their
// logic. Keep original line offsets for failures; fail loudly if markers move.
const scripts = [
  ["let diagnosticsOpen = false;", "function appLog("],
  ["function scheduleChatListRefresh(", "// Group message sender avatars"],
  ["async function openChat(", "// Android BACK / gesture"],
  ["function accountIsCurrent(", "// Tell the frontend where blobs live"],
  ['diagnostics.addEventListener("changed"', "/* ---------------- DOM budget watchdog"],
].map(([start, end]) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing app.js marker: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `Missing app.js end marker: ${end}`);
  return new Script(source.slice(from, to), {
    filename: "app/js/app.js",
    lineOffset: source.slice(0, from).split("\n").length - 1,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function deferCalls(core, method) {
  const calls = [];
  core[method] = (...args) => {
    const call = { ...deferred(), accountId: core.accountId, epoch: core.accountEpoch, args };
    calls.push(call);
    return call.promise;
  };
  return calls;
}

// Only the DOM/custom-element surface touched by the extracted app functions.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.value = "";
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    };
  }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    for (const child of children) this.appendChild(child);
  }
  replaceWith(child) {
    const parent = this.parent;
    const index = parent.children.indexOf(this);
    child.remove();
    this.remove();
    parent.children.splice(index, 0, child);
    child.parent = parent;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setData(chat) { this.chat = chat; this.setAttribute("chat-id", chat.id); }
  addEventListener() {}
  querySelectorAll(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    return cls ? this.children.filter(c => c.classList?.contains(cls)) : [];
  }
}

const chat = name => ({ id: 7, kind: "single", name });

function setup(t) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const listeners = new Map();
  const core = {
    accountId: "A", accountEpoch: 0,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    getChatList: async () => [],
    getChat: async () => chat("current"),
    getContactEncryptionInfo: async id => `fingerprint-${id}`,
  };
  const effects = { opens: [], closes: 0, popupsClosed: 0, accounts: [], fingerprints: [], toasts: [], warnings: [], ioCallbacks: [], ioObserved: [] };
  const timers = new Map();
  let timerId = 0;
  const context = createContext({
    core,
    localStorage: { getItem: () => null },
    $: node,
    document: { createElement: tag => new Element(tag), querySelector: node, getElementById: id => nodes.get(id) ?? null, querySelectorAll: () => [], body: new Element("body"), addEventListener() {}, removeEventListener() {} },
    window: {},
    // #44: captures the chat-list ghost observer; instances land in
    // effects.ioCallbacks, observed targets in effects.ioObserved.
    IntersectionObserver: class {
      constructor(callback) { effects.ioCallbacks.push(callback); }
      observe(target) { effects.ioObserved.push(target); }
      unobserve() {} disconnect() {}
    },
    history: {
      state: null,
      pushes: [],
      pushState(value) { this.state = value; this.pushes.push(value); },
      replaceState(value) { this.state = value; },
    },
    DIAGNOSTICS_CHAT_ID: -1,
    diagnostics: {
      preview: "Diagnostics",
      getChat() { return { id: -1, name: this.preview }; },
      addEventListener(name, callback) { listeners.set(`diagnostics:${name}`, [callback]); },
    },
    diagnosticsPaused: false,
    renderDiagnosticsMessages: () => {},
    renderInitialDiagnosticsChat: () => {},
    p2pEnabled: () => false,
    console: { warn: (...args) => effects.warnings.push(args) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    testChatView: {
      close: () => { effects.closes++; },
      open: async (id, chat) => { effects.opens.push([core.accountId, id]); effects.openedWith = chat; return true; },
    },
    closeAllPopups: () => { effects.popupsClosed++; node("popups").replaceChildren(); },
    refreshChatHeadPresence: () => {},
    refreshAccounts: async () => { effects.accounts.push(core.accountId); },
    setFingerprintSource: callback => effects.fingerprints.push(callback),
    toast: (...args) => effects.toasts.push(args),
    errToast: (...args) => effects.toasts.push(args),
    openDiagnosticsChat: () => assert.fail("Unexpected diagnostics navigation"),
    // Local chat (local-chat.js imports): off in these tests — no hub card,
    // no offline queue.
    hubModel: async () => null,
    lcQueueItems: () => [],
  });
  for (const script of scripts) script.runInContext(context);
  const app = new Script(`
    chatView = testChatView;
    ({ state, refreshChatList, scheduleChatListRefresh, scheduleChatListUpdate, renderChatList, openChat, closeChatUI,
       get archivedCount() { return archivedCount; },
       get inFlight() { return chatListInFlight; },
       get navigation() { return chatNavigation; },
       get accountRefresh() { return accountRefreshPromise; },
       get drawer() { return drawer; },
       set drawer(value) { drawer = value; },
       get listView() { return listView; },
       set listView(value) { listView = value; } })
  `).runInContext(context);
  const emit = name => {
    assert.ok(listeners.has(name), `Missing ${name} listener`);
    for (const callback of listeners.get(name)) callback();
  };
  const switchTo = id => {
    core.accountEpoch++;
    emit("account-changing");
    core.accountId = id;
    core.accountEpoch++;
    emit("account-changed");
  };
  const shown = () => node("chat-list").children.filter(el => el.tagName === "VELTA-CHAT-ITEM").map(el => el.chat.name);
  t.after(() => assert.deepEqual(effects.toasts, [], "Unexpected openChat error or stale toast"));
  return { app, core, context, node, effects, timers, emit, switchTo, shown };
}

test("B refresh and its awaited join finish while A is pending; late A cannot overwrite B", async t => {
  const { app, core, shown } = setup(t);
  const calls = deferCalls(core, "getChatList");
  const old = app.refreshChatList();
  core.accountId = "B";
  core.accountEpoch += 2;
  let refreshed = false;
  const current = app.refreshChatList().then(() => { refreshed = true; });
  let joined = false;
  const joining = app.refreshChatList().then(() => { joined = true; });
  assert.deepEqual(calls.map(call => call.accountId), ["A", "B"]);
  await nextTurn();
  assert.equal(refreshed, false, "An awaited new-account refresh must not return early");
  assert.equal(joined, false, "An awaited coalesced refresh must not return early");
  calls[1].resolve([chat("B")]);
  await Promise.all([current, joining]);
  assert.equal(refreshed, true);
  assert.equal(joined, true);
  assert.deepEqual(shown(), ["Diagnostics", "B"]);
  calls[0].resolve([chat("stale A")]);
  await old;
  assert.deepEqual(Array.from(app.state.chats, item => item.name), ["Diagnostics", "B"]);
  assert.deepEqual(shown(), ["Diagnostics", "B"]);
});

for (const rejects of [false, true]) {
  test(`old A ${rejects ? "rejection" : "completion"} cannot clear B's pending refresh`, async t => {
    const { app, core, shown, effects } = setup(t);
    const calls = deferCalls(core, "getChatList");
    const old = app.refreshChatList();
    core.accountId = "B";
    core.accountEpoch += 2;
    const current = app.refreshChatList();
    const request = app.inFlight;
    if (rejects) calls[0].reject(new Error("old account offline"));
    else calls[0].resolve([chat("stale A")]);
    await old;
    assert.equal(app.inFlight, request);
    assert.deepEqual(shown(), []);
    const joining = app.refreshChatList();
    assert.equal(calls.length, 2, "B's request should still be coalesced");
    calls[1].resolve([chat("B")]);
    await Promise.all([current, joining]);
    assert.deepEqual(shown(), ["Diagnostics", "B"]);
    assert.equal(app.inFlight, null);
    assert.equal(effects.warnings.length, rejects ? 1 : 0);
  });
}

test("A -> B -> A invalidates a list result even without a replacement request", async t => {
  const { app, core, shown } = setup(t);
  const calls = deferCalls(core, "getChatList");
  const old = app.refreshChatList();
  core.accountId = "B";
  core.accountEpoch += 2;
  core.accountId = "A";
  core.accountEpoch += 2;
  calls[0].resolve([chat("old A epoch")]);
  await old;
  assert.equal(app.state.chats.length, 0);
  assert.deepEqual(shown(), []);
  const fresh = app.refreshChatList();
  calls[1].resolve([chat("new A epoch")]);
  await fresh;
  assert.deepEqual(shown(), ["Diagnostics", "new A epoch"]);
});

test("changed search query invalidates a result before the next search starts", async t => {
  const { app, core, shown } = setup(t);
  const calls = deferCalls(core, "getChatList");
  app.state.query = "old";
  const old = app.refreshChatList();
  app.state.query = "new";
  calls[0].resolve([chat("old search")]);
  await old;
  assert.deepEqual(shown(), []);
  assert.equal(app.state.chats.length, 0);
  const current = app.refreshChatList();
  assert.deepEqual(calls.map(call => call.args[0].query), ["old", "new"]);
  calls[1].resolve([chat("new search")]);
  await current;
  assert.deepEqual(shown(), ["Diagnostics", "new search"]);
});

test("search old -> new -> old keeps only the latest request for the same query", async t => {
  const { app, core, shown } = setup(t);
  const calls = deferCalls(core, "getChatList");
  app.state.query = "old";
  const first = app.refreshChatList();
  app.state.query = "new";
  const middle = app.refreshChatList();
  app.state.query = "old";
  const last = app.refreshChatList();
  assert.deepEqual(calls.map(call => call.args[0].query), ["old", "new", "old"]);
  calls[0].resolve([chat("obsolete same-query result")]);
  await first;
  assert.equal(app.state.chats.length, 0);
  const joining = app.refreshChatList();
  assert.equal(calls.length, 3);
  calls[2].resolve([chat("latest search")]);
  await Promise.all([last, joining]);
  calls[1].resolve([chat("middle search")]);
  await middle;
  assert.deepEqual(shown(), ["Diagnostics", "latest search"]);
});

test("accountChanging alone blocks a pending list result", async t => {
  const { app, core, shown } = setup(t);
  const calls = deferCalls(core, "getChatList");
  const pending = app.refreshChatList();
  app.state.accountChanging = true;
  calls[0].resolve([chat("transition result")]);
  await pending;
  assert.equal(app.state.chats.length, 0);
  assert.deepEqual(shown(), []);
});

test("closeChatUI during getChat cannot reopen the chat or push history", async t => {
  const { app, core, effects, node, context } = setup(t);
  const calls = deferCalls(core, "getChat");
  const pending = app.openChat(7);
  assert.equal(calls.length, 1);
  const navigation = app.navigation;
  app.closeChatUI();
  assert.ok(app.navigation > navigation);
  calls[0].resolve(chat("closed A"));
  await pending;
  assert.equal(app.state.activeChatId, null);
  assert.equal(node("chat-head-info").children.length, 0);
  assert.equal(node("chat-view").hidden, true);
  assert.equal(node("no-chat").hidden, false);
  assert.deepEqual(effects.opens, []);
  assert.equal(context.history.pushes.length, 0);
});

test("epoch alone invalidates pending getChat after A -> B -> A", async t => {
  const { app, core, effects, node } = setup(t);
  const calls = deferCalls(core, "getChat");
  const pending = app.openChat(7);
  const navigation = app.navigation;
  core.accountId = "B";
  core.accountEpoch += 2;
  core.accountId = "A";
  core.accountEpoch += 2;
  calls[0].resolve(chat("old A epoch"));
  await pending;
  assert.equal(app.navigation, navigation, "This case must isolate the epoch guard");
  assert.equal(app.state.activeChatId, null);
  assert.equal(node("chat-head-info").children.length, 0);
  assert.deepEqual(effects.opens, []);
});

for (const destination of ["B", "A"]) {
  for (const rejects of [false, true]) {
    test(`late A getChat ${rejects ? "rejection" : "completion"} cannot replace ${destination}'s same numeric chat ID`, async t => {
      const { app, core, effects, node, context, switchTo } = setup(t);
      const calls = deferCalls(core, "getChat");
      const old = app.openChat(7);
      switchTo("B");
      if (destination === "A") switchTo("A");
      const current = app.openChat(7);
      assert.equal(calls.length, 2);
      calls[1].resolve(chat(`current ${destination}`));
      await current;
      const head = app.state.activeChatHead;
      const closes = effects.closes;
      assert.equal(app.state.activeChatId, 7);
      assert.deepEqual(effects.opens, [[destination, 7]]);
      if (rejects) calls[0].reject(new Error("old getChat failed"));
      else calls[0].resolve(chat("obsolete A"));
      await old;
      await app.accountRefresh;
      assert.equal(app.state.activeChatId, 7);
      assert.equal(app.state.activeChatHead, head);
      assert.equal(node("chat-head-info").children[0].chat.name, `current ${destination}`);
      assert.equal(node("chat-view").hidden, false);
      assert.equal(effects.closes, closes);
      assert.deepEqual(effects.opens, [[destination, 7]]);
      assert.equal(context.history.pushes.length, 1);
    });
  }
}

test("account listeners synchronously clear private UI and start an awaitable new-account refresh", async t => {
  const { app, core, node, effects, context, timers, emit, shown } = setup(t);
  app.state.chats = [chat("private A")];
  await app.openChat(7);
  // Since 1.3.36 search is an in-list side view (renderSearchView) — the
  // header #search input and its debounce searchTimer are gone; state.query
  // is the only query state the account boundary must clear.
  app.state.query = "private query";
  const oldRow = node("chat-list").children[0];
  const popup = node("popups").appendChild(new Element());
  const drawer = { el: new Element(), overlayEl: new Element() };
  node("drawer-host").appendChild(drawer.el);
  node("drawer-host").appendChild(drawer.overlayEl);
  app.drawer = drawer;
  app.scheduleChatListRefresh();
  assert.equal(timers.size, 1);
  const lists = deferCalls(core, "getChatList");
  const oldRefresh = app.refreshChatList();
  const closes = effects.closes;
  const navigation = app.navigation;
  core.accountEpoch++;
  emit("account-changing");

  // No await before these assertions: privacy teardown belongs to the event stack.
  assert.equal(app.state.accountChanging, true);
  assert.equal(app.state.activeChatId, null);
  assert.equal(app.state.activeChatHead, null);
  assert.equal(app.state.chats.length, 0);
  assert.equal(app.state.query, "");
  assert.equal(node("chat-head-info").children.length, 0);
  assert.equal(node("chat-view").hidden, true);
  assert.equal(node("no-chat").hidden, false);
  assert.equal(node(".app").classList.contains("chat-open"), false);
  assert.deepEqual(shown(), []);
  assert.equal(oldRow.parent, null);
  assert.equal(popup.parent, null);
  assert.equal(node("popups").children.length, 0);
  assert.equal(effects.popupsClosed, 1);
  assert.equal(drawer.el.parent, null);
  assert.equal(drawer.overlayEl.parent, null);
  assert.equal(app.drawer, null);
  assert.equal(effects.closes, closes + 1);
  assert.ok(app.navigation > navigation);
  assert.equal(context.history.state, null);
  assert.equal(timers.size, 0);
  assert.equal(app.inFlight, null);

  const chats = deferCalls(core, "getChat");
  app.scheduleChatListRefresh();
  await Promise.all([app.refreshChatList(), app.openChat(7), app.openChat(-1)]);
  assert.equal(lists.length, 1);
  assert.equal(chats.length, 0);
  assert.equal(timers.size, 0);
  lists[0].resolve([chat("late private A")]);
  await oldRefresh;
  assert.deepEqual(shown(), []);

  const accounts = deferred();
  context.refreshAccounts = () => { effects.accounts.push(core.accountId); return accounts.promise; };
  core.accountId = "B";
  core.accountEpoch++;
  emit("account-changed");
  assert.equal(app.state.accountChanging, false);
  assert.deepEqual(effects.accounts, ["B"]);
  assert.equal(effects.fingerprints.length, 1);
  assert.equal(lists.length, 2, "account-changed must start refresh without a caller or timer");
  assert.equal(lists[1].accountId, "B");
  assert.equal(lists[1].args[0].query, "");
  let finished = false;
  const refreshing = app.accountRefresh.then(() => { finished = true; });
  const joining = app.refreshChatList();
  lists[1].resolve([chat("B")]);
  await joining;
  assert.deepEqual(shown(), ["Diagnostics", "B"]);
  await nextTurn();
  assert.equal(finished, false, "Account refresh must also await account metadata");
  accounts.resolve();
  await refreshing;
  assert.equal(finished, true);
});

test("account switch leaves a side view: old search results are neither shown nor tappable", async t => {
  const { app, core, node, emit, shown } = setup(t);
  app.state.chats = [chat("private A")];
  // An open search view (renderSearchView) rendered A's hits into the list
  // container; each hit button carries A's chat id.
  app.listView = "search";
  app.state.query = "priv";
  const staleHit = node("chat-list").appendChild(new Element("button"));
  const lists = deferCalls(core, "getChatList");
  core.accountEpoch++;
  emit("account-changing");
  assert.equal(app.listView, "chats", "side view must close on the account boundary");
  assert.equal(staleHit.parent, null, "stale search hit must leave the DOM");
  core.accountId = "B";
  core.accountEpoch++;
  emit("account-changed");
  assert.equal(lists.length, 1);
  lists[0].resolve([chat("B")]);
  await app.accountRefresh;
  assert.deepEqual(shown(), ["Diagnostics", "B"], "the new profile's list must render");
  assert.equal(staleHit.parent, null);
});

/* ---- incremental chat list (issue #25) ---- */

// Fires every pending timer (debounces), then lets the refresh settle.
async function flushTimers(timers) {
  while (timers.size) {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) await callback();
  }
  for (let i = 0; i < 5; i++) await nextTurn();
}

const item = (id, name = `chat ${id}`) => ({ id, kind: "group", name });

// A core that emits the fine-grained chat-list events: records every entries
// / items request, serves chats from a mutable backing list.
function incrementalCore(core, ids) {
  const calls = { entries: [], items: [], full: [] };
  const names = new Map(ids.map(id => [id, `chat ${id}`]));
  const listed = { ids: [...ids], archived: [101, 102, 103] };
  core.chatlistEvents = true;
  core.getChatListIds = async ({ archived = false } = {}) => {
    calls.entries.push(archived ? "archived" : "main");
    return archived ? [...listed.archived] : [...listed.ids];
  };
  core.getChatListItems = async want => {
    calls.items.push([...want]);
    return new Map(want.map(id => [id, names.has(id) ? item(id, names.get(id)) : null]));
  };
  core.getChatList = async opts => { calls.full.push(opts); return []; };
  return { calls, names, listed };
}

test("incremental: first refresh is full, archived folder counted from entries only", async t => {
  const { app, core, timers, shown } = setup(t);
  const { calls } = incrementalCore(core, [1, 2, 3]);
  await app.refreshChatList();
  await flushTimers(timers);
  assert.deepEqual(calls.entries, ["main", "archived"]);
  assert.deepEqual(calls.items, [[1, 2, 3]], "archived items must not be loaded");
  assert.deepEqual(calls.full, [], "getChatList is not used on an incremental core");
  assert.equal(app.archivedCount, 3);
  assert.deepEqual(shown(), ["Diagnostics", "chat 1", "chat 2", "chat 3"]);
});

test("incremental: chatlist-item-changed refetches only that chat's item", async t => {
  const { app, core, timers, shown } = setup(t);
  const { calls, names } = incrementalCore(core, [1, 2, 3]);
  await app.refreshChatList();
  await flushTimers(timers);
  calls.entries.length = 0; calls.items.length = 0;
  names.set(2, "renamed");
  app.scheduleChatListUpdate({ chatId: 2 });
  await flushTimers(timers);
  assert.deepEqual(calls.entries, [], "order unchanged: no entries / archived refetch");
  assert.deepEqual(calls.items, [[2]]);
  assert.deepEqual(shown(), ["Diagnostics", "chat 1", "renamed", "chat 3"]);
});

test("incremental: chatlist-changed refetches entries and only new chats; drops removed ones", async t => {
  const { app, core, timers, shown } = setup(t);
  const { calls, names, listed } = incrementalCore(core, [1, 2, 3]);
  await app.refreshChatList();
  await flushTimers(timers);
  calls.entries.length = 0; calls.items.length = 0;
  names.set(4, "new chat");
  listed.ids = [4, 3, 1]; // new chat on top, 3 moved up, 2 deleted
  listed.archived = [101];
  app.scheduleChatListUpdate({ order: true });
  await flushTimers(timers);
  assert.deepEqual(calls.entries, ["main", "archived"]);
  assert.deepEqual(calls.items, [[4]]);
  assert.equal(app.archivedCount, 1);
  assert.deepEqual(shown(), ["Diagnostics", "new chat", "chat 3", "chat 1"]);
});

test("incremental: a burst of chat-list events coalesces into one small refresh", async t => {
  const { app, core, timers } = setup(t);
  const { calls } = incrementalCore(core, [1, 2, 3, 4]);
  await app.refreshChatList();
  await flushTimers(timers);
  calls.entries.length = 0; calls.items.length = 0;
  for (let i = 0; i < 50; i++) {
    app.scheduleChatListUpdate({ order: true });
    app.scheduleChatListUpdate({ chatId: 1 + (i % 2) });
  }
  assert.equal(timers.size, 1, "one trailing refresh for the whole burst");
  await flushTimers(timers);
  assert.deepEqual(calls.entries, ["main", "archived"]);
  assert.deepEqual(calls.items, [[1, 2]]);
});

test("incremental: ChatlistItemChanged without a chat and account switches refetch everything", async t => {
  const { app, core, timers, switchTo } = setup(t);
  const { calls } = incrementalCore(core, [1, 2]);
  await app.refreshChatList();
  await flushTimers(timers);
  calls.items.length = 0;
  app.scheduleChatListUpdate({ chatId: 0 });
  await flushTimers(timers);
  assert.deepEqual(calls.items, [[1, 2]]);
  calls.items.length = 0;
  switchTo("B");
  await flushTimers(timers);
  app.scheduleChatListUpdate({ chatId: 1 });
  await flushTimers(timers);
  // First refresh of the new account is full (no stale cache from A), then
  // the per-chat update touches one item only.
  assert.deepEqual(calls.items, [[1, 2], [1]]);
});

test("incremental: a failed partial refresh makes the next one full", async t => {
  const { app, core, timers, effects } = setup(t);
  const { calls } = incrementalCore(core, [1, 2]);
  await app.refreshChatList();
  await flushTimers(timers);
  const items = core.getChatListItems;
  core.getChatListItems = async () => { throw new Error("offline"); };
  app.scheduleChatListUpdate({ chatId: 1 });
  await flushTimers(timers);
  assert.equal(effects.warnings.length, 1);
  core.getChatListItems = items;
  calls.items.length = 0;
  app.scheduleChatListUpdate({ chatId: 1 });
  await flushTimers(timers);
  assert.deepEqual(calls.items, [[1, 2]]);
});

test("local chat on or a core without chat-list events: per-chat updates fall back to a full refresh", async t => {
  for (const variant of ["p2p", "mock"]) {
    const { app, core, context, timers } = setup(t);
    const { calls } = incrementalCore(core, [1, 2]);
    if (variant === "p2p") context.p2pEnabled = () => true;
    else { delete core.chatlistEvents; delete core.getChatListIds; delete core.getChatListItems; }
    app.scheduleChatListUpdate({ chatId: 1 });
    await flushTimers(timers);
    assert.equal(calls.full[0]?.query, "", `${variant}: main list via getChatList (proxy merges local peers)`);
    assert.equal(calls.full.length, variant === "mock" ? 2 : 1, `${variant}: archived via getChatList only without ids`);
    assert.deepEqual(calls.items, [], `${variant}: no incremental item fetch`);
  }
});

test("Diagnostics appends patch the Diagnostics row locally, coalesced, without chat-list RPCs", async t => {
  const { app, core, context, timers, emit, shown } = setup(t);
  const { calls } = incrementalCore(core, [1]);
  await app.refreshChatList();
  await flushTimers(timers);
  calls.entries.length = 0; calls.items.length = 0;
  for (let i = 0; i < 20; i++) {
    context.diagnostics.preview = `line ${i}`;
    emit("diagnostics:changed");
  }
  assert.equal(timers.size, 1);
  await flushTimers(timers);
  assert.deepEqual(calls, { entries: [], items: [], full: [] });
  assert.deepEqual(shown(), ["line 19", "chat 1"]);
});

test("openChat hands its fetched chat to the chat view (one getChat per open, #25)", async t => {
  const { app, core, effects } = setup(t);
  let calls = 0;
  core.getChat = async id => { calls++; return { id, kind: "single", name: "current" }; };
  await app.openChat(7);
  assert.equal(calls, 1);
  assert.deepEqual(effects.opens, [["A", 7]]);
  assert.equal(effects.openedWith?.id, 7);
  assert.equal(effects.openedWith?.name, "current");
});

test("chat list mounts the first rows and ghosts the rest, upgrading on approach (#44)", async t => {
  const { app, node, effects } = setup(t);
  const mk = id => ({ id, kind: "single", name: `chat ${id}`, avatarColor: "#123456", lastMsg: "x", lastTs: 1, unread: 0, pinned: false, muted: false, archived: false, encrypted: true, draft: null, lastFrom: 0, lastState: 0 });
  app.state.chats = Array.from({ length: 60 }, (_, i) => mk(i + 1));
  app.listView = "chats";
  app.renderChatList();

  const list = node("chat-list");
  const rows = list.children.filter(el => el.tagName === "VELTA-CHAT-ITEM");
  const ghosts = list.children.filter(el => el.classList?.contains("chat-item-ghost"));
  assert.equal(rows.length, 40, "the first screen-and-a-half mounts fully");
  assert.deepEqual(rows.map(r => r.chat.id), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(ghosts.length, 20, "off-screen rows are placeholders, not custom elements");
  assert.deepEqual(ghosts.map(g => Number(g.getAttribute("chat-id"))), Array.from({ length: 20 }, (_, i) => i + 41));
  assert.equal(effects.ioCallbacks.length, 1, "one IntersectionObserver watches the ghosts");
  assert.equal(effects.ioObserved.length, 20);

  // A re-render (no data change) reuses the same elements and ghosts.
  const topBefore = rows[0];
  const ghostBefore = ghosts[0];
  app.renderChatList();
  assert.equal(node("chat-list").children[0], topBefore, "unchanged rows are not rebuilt");
  assert.ok(node("chat-list").children.includes(ghostBefore), "ghosts survive a re-render");

  // Scrolling a ghost near the viewport upgrades it to a full row.
  const [onIntersect] = effects.ioCallbacks;
  onIntersect([{ target: ghostBefore, isIntersecting: true }]);
  const upgraded = node("chat-list").children.find(el => el.tagName === "VELTA-CHAT-ITEM" && el.chat?.id === 41);
  assert.ok(upgraded, "the ghost became a real row with its chat data");
  assert.equal(node("chat-list").children.filter(el => el.classList?.contains("chat-item-ghost")).length, 19);
});
