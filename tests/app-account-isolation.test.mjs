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
  const effects = { opens: [], closes: 0, popupsClosed: 0, accounts: [], fingerprints: [], toasts: [], warnings: [] };
  const timers = new Map();
  let timerId = 0;
  const context = createContext({
    core,
    localStorage: { getItem: () => null },
    $: node,
    document: { createElement: tag => new Element(tag), querySelector: node },
    window: {},
    history: {
      state: null,
      pushes: [],
      pushState(value) { this.state = value; this.pushes.push(value); },
      replaceState(value) { this.state = value; },
    },
    DIAGNOSTICS_CHAT_ID: -1,
    diagnostics: { getChat: () => ({ id: -1, name: "Diagnostics" }) },
    console: { warn: (...args) => effects.warnings.push(args) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    testChatView: {
      close: () => { effects.closes++; },
      open: async id => { effects.opens.push([core.accountId, id]); return true; },
    },
    closeAllPopups: () => { effects.popupsClosed++; node("popups").replaceChildren(); },
    refreshAccounts: async () => { effects.accounts.push(core.accountId); },
    setFingerprintSource: callback => effects.fingerprints.push(callback),
    toast: (...args) => effects.toasts.push(args),
    openDiagnosticsChat: () => assert.fail("Unexpected diagnostics navigation"),
  });
  for (const script of scripts) script.runInContext(context);
  const app = new Script(`
    chatView = testChatView;
    ({ state, refreshChatList, scheduleChatListRefresh, renderChatList, openChat, closeChatUI,
       get inFlight() { return chatListInFlight; },
       get navigation() { return chatNavigation; },
       get accountRefresh() { return accountRefreshPromise; },
       get drawer() { return drawer; },
       set drawer(value) { drawer = value; },
       set searchTimer(value) { searchTimer = value; } })
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
  const shown = () => node("chat-list").children.filter(el => el.tagName === "DC-CHAT-ITEM").map(el => el.chat.name);
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
  app.state.query = node("search").value = "private query";
  const oldRow = node("chat-list").children[0];
  const popup = node("popups").appendChild(new Element());
  const drawer = { el: new Element(), overlayEl: new Element() };
  node("drawer-host").appendChild(drawer.el);
  node("drawer-host").appendChild(drawer.overlayEl);
  app.drawer = drawer;
  app.scheduleChatListRefresh();
  app.searchTimer = context.setTimeout(() => assert.fail("Cancelled search ran"));
  assert.equal(timers.size, 2);
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
  assert.equal(node("search").value, "");
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
