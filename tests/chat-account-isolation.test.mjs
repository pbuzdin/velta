import test from "node:test";
import assert from "node:assert/strict";

// Only the DOM surface used by ChatView's lifecycle and the real modal helpers.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.className = "";
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 500;
    this.classList = {
      add: (...names) => { this.className += " " + names.join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(" "); },
      toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  fire(name, event = {}) { return Promise.all([...this.listeners.get(name) || []].map(fn => fn({ target: this, currentTarget: this, ...event }))); }
  querySelectorAll(selector) {
    const matches = el => selector.startsWith(".") ? el.className.split(/\s+/).includes(selector.slice(1)) : el.tagName.toLowerCase() === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { top: 20, left: 20, right: 200, bottom: 100, width: 180, height: 80 }; }
  focus() {}
  scrollTo({ top }) { this.scrollTop = top; }
}

globalThis.HTMLElement = Element;
const elements = new Map();
globalThis.customElements = { get: name => elements.get(name), define: (name, el) => elements.set(name, el) };
globalThis.window = {};
globalThis.innerHeight = 800;
globalThis.innerWidth = 1200;
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups, confirmModal, confirmDeleteMessagesModal, showModal } = await import("../app/js/ui.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const message = (id, chatId = 7) => ({ id, chatId, from: 1, text: `message ${id}`, ts: 1700000000000, viewtype: "text", fromContact: { name: "Me" } });
const page = (...messages) => ({ messages, hasMore: true });

function setup(t) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  globalThis.document = {
    getElementById: node,
    querySelector: node,
    createElement: tag => new Element(tag),
    hidden: false,
  };
  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => timer(...args).unref());
  window.__TAURI__ = null;
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async id => ({ id, kind: "single", unread: 0, encrypted: true }),
    getMessages: async id => page(message(10, id)),
    markRead: async () => {},
  });
  let changed = 0, forwarded = 0, live = 0;
  const view = new ChatView(core, { onChatsChanged: () => changed++, onForward: () => forwarded++ });
  // Rendering/layout is not under test; all lifecycle, data and action methods are real.
  view._createScroller = function () { this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} }; };
  view.startLive = () => live++;
  const switchTo = id => {
    core.accountEpoch++;
    view.close();
    closeAllPopups();
    core.accountId = id;
    core.accountEpoch++;
  };
  t.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; });
  return { view, core, node, frames, switchTo, changed: () => changed, forwarded: () => forwarded, live: () => live };
}

for (const stage of ["getChat", "getMessages", "markRead"]) {
  test(`close during open's ${stage} cannot resurrect the view`, async t => {
    const { view, core, live, node } = setup(t);
    const pending = deferred(), entered = deferred();
    core[stage] = () => { entered.resolve(); return pending.promise; };
    const opening = view.open(7);
    await entered.promise;
    view.close();
    pending.resolve(stage === "getChat" ? { id: 7, kind: "single" } : stage === "getMessages" ? page(message(99)) : undefined);
    assert.equal(await opening, false);
    assert.equal(view.chat, null);
    assert.deepEqual(view.items, []);
    assert.equal(view.vs, null);
    assert.equal(node("composer-input").disabled, true);
    assert.equal(live(), 0);
  });
}

test("old open cannot replace a newer chat or reopen after an account round trip", async t => {
  const { view, core, switchTo } = setup(t);
  const pending = deferred();
  const getChat = core.getChat;
  core.getChat = () => pending.promise;
  const opening = view.open(7);
  switchTo("B");
  switchTo("A");
  core.getChat = getChat;
  assert.equal(await view.open(8), true);
  pending.resolve({ id: 7, kind: "single" });
  assert.equal(await opening, false);
  assert.equal(view.chat.id, 8);
});

test("same-account close and reopen invalidates old work without an epoch change", async t => {
  const { view, core, node, changed } = setup(t);
  await view.open(7);
  const pending = deferred();
  core.sendMessage = () => pending.promise;
  node("composer-input").value = "sending";
  const sending = view._send();
  const epoch = core.accountEpoch;
  view.close();
  await view.open(7);
  pending.resolve(message(99));
  await sending;
  assert.equal(core.accountEpoch, epoch);
  assert.deepEqual([...view.msgIndex.keys()], [10]);
  assert.equal(changed(), 0);

  const loading = deferred();
  const getChat = core.getChat;
  core.getChat = () => loading.promise;
  const opening = view.open(8);
  core.getChat = getChat;
  await view.open(7);
  loading.resolve({ id: 8, kind: "single" });
  assert.equal(await opening, false);
  assert.equal(view.chat.id, 7);
});

test("reload rejects same-ID results from another account and from A-B-A", async t => {
  const { view, core, switchTo } = setup(t);
  await view.open(7);
  const getMessages = core.getMessages;
  for (const target of ["B", "A"]) {
    const pending = deferred();
    core.getMessages = () => pending.promise;
    const loading = view.onMsgsChanged(7);
    switchTo(target);
    core.getMessages = getMessages;
    await view.open(7);
    pending.resolve(page(message(99)));
    await loading;
    assert.deepEqual([...view.msgIndex.keys()], [10]);
  }
  const pending = deferred();
  core.getMessages = () => pending.promise;
  const loading = view.onMsgsChanged(7);
  switchTo("B");
  switchTo("A");
  core.getMessages = getMessages;
  await view.open(7);
  pending.resolve(page(message(100)));
  await loading;
  assert.deepEqual([...view.msgIndex.keys()], [10]);
});

test("epoch alone invalidates async results and immediate actions", async t => {
  const { view, core, node } = setup(t);
  await view.open(7);
  const pending = deferred();
  core.getMessages = () => pending.promise;
  const loading = view.onMsgsChanged(7);
  core.accountEpoch += 2;
  pending.resolve(page(message(99)));
  await loading;
  core.sendMessage = () => assert.fail("stale view sent a message");
  node("composer-input").value = "old account";
  await view._send();
  await view.onIncoming(7, message(100));
  view.onMsgsDeleted(7, [10]);
  assert.deepEqual([...view.msgIndex.keys()], [10]);
});

test("an older tail request cannot undo a newer tail", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  const older = deferred(), newer = deferred();
  core.getMessages = () => older.promise;
  const first = view.onMsgsChanged(7);
  core.getMessages = () => newer.promise;
  const second = view.onMsgsChanged(7);
  newer.resolve(page(message(10), message(11)));
  await second;
  older.resolve(page(message(10)));
  await first;
  assert.deepEqual([...view.msgIndex.keys()], [10, 11]);
});

for (const rejectOld of [false, true]) {
  test(`old pagination ${rejectOld ? "rejection" : "completion"} cannot clear the newer loading flag`, async t => {
    const { view, core, switchTo } = setup(t);
    await view.open(7);
    const getMessages = core.getMessages;
    const old = deferred(), next = deferred();
    core.getMessages = () => old.promise;
    const first = view._loadOlder();
    switchTo("B");
    core.getMessages = getMessages;
    await view.open(7);
    core.getMessages = () => next.promise;
    const second = view._loadOlder();
    if (rejectOld) old.reject(new Error("old request failed"));
    else old.resolve(page(message(1)));
    await first;
    assert.equal(view.loadingMore, true);
    assert.deepEqual([...view.msgIndex.keys()], [10]);
    next.resolve({ messages: [message(5)], hasMore: false });
    await second;
    assert.equal(view.loadingMore, false);
    assert.equal(view.hasMore, false);
    assert.deepEqual(view.items.filter(i => i.type === "msg").map(i => i.msg.id), [5, 10]);
  });
}

test("current pagination failure releases its loading flag", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  core.getMessages = async () => { throw new Error("offline"); };
  await view._loadOlder();
  assert.equal(view.loadingMore, false);
  assert.equal(view.hasMore, true);
});

test("draft text and reply belong to account plus chat, not the current core ID at close", async t => {
  const { view, core, node, switchTo } = setup(t);
  await view.open(7);
  node("composer-input").value = "A's draft";
  view._setReply(view.msgIndex.get(10));
  const replyA = view.replyTo;
  core.accountId = "B";
  core.accountEpoch++;
  view.close();
  view.close();
  core.accountEpoch++;
  await view.open(7);
  assert.equal(node("composer-input").value, "");
  assert.equal(view.replyTo, null);
  node("composer-input").value = "B's draft";
  await view.open(8);
  assert.equal(node("composer-input").value, "");
  await view.open(7);
  assert.equal(node("composer-input").value, "B's draft");
  switchTo("A");
  await view.open(7);
  assert.equal(node("composer-input").value, "A's draft");
  assert.equal(view.replyTo, replyA);
  assert.equal(node("reply-preview").hidden, false);
  node("composer-input").value = "";
  view.replyTo = null;
  view.close();
  await view.open(7);
  assert.equal(node("composer-input").value, "");
  assert.equal(view.replyTo, null);
});

for (const voice of [false, true]) {
  test(`stale ${voice ? "voice" : "text"} send cannot append after A-B-A`, async t => {
    const { view, core, node, switchTo, changed } = setup(t);
    await view.open(7);
    const pending = deferred();
    core.sendMessage = (chatId, data) => {
      assert.equal(chatId, 7);
      if (!voice) assert.deepEqual(data, { text: "hello", quoteId: 10 });
      return pending.promise;
    };
    node("composer-input").value = "hello";
    view._setReply(view.msgIndex.get(10));
    const sending = voice ? view._sendAttachment("voice") : view._send();
    switchTo("B");
    switchTo("A");
    await view.open(7);
    pending.resolve(message(99));
    await sending;
    assert.deepEqual([...view.msgIndex.keys()], [10]);
    assert.equal(changed(), 0);
  });
}

for (const stage of ["picker", "copy", "send"]) {
  test(`switching during attachment ${stage} never retargets the file`, async t => {
    const { view, core, switchTo, changed } = setup(t);
    await view.open(7);
    const pending = deferred(), entered = deferred();
    const calls = [];
    window.__TAURI__ = { core: { invoke: async command => {
      if (command === "js_log") return;
      calls.push(command);
      if (command === "plugin:dialog|open") {
        if (stage === "picker") { entered.resolve(); return pending.promise; }
        return "content://photo";
      }
      assert.equal(command, "resolve_content_uri");
      if (stage === "copy") { entered.resolve(); return pending.promise; }
      return "/data/photo.png";
    } } };
    core.sendMessage = (id, data) => {
      assert.equal(core.accountId, "A");
      assert.equal(id, 7);
      assert.equal(data.file, "/data/photo.png");
      calls.push("send");
      entered.resolve();
      return pending.promise;
    };
    const sending = view._sendAttachment("image");
    await entered.promise;
    switchTo("B");
    await view.open(7);
    pending.resolve(stage === "picker" ? "content://photo" : stage === "copy" ? "/data/photo.png" : message(99));
    await sending;
    assert.equal(calls.includes("send"), stage === "send");
    if (stage === "picker") assert.deepEqual(calls, ["plugin:dialog|open"]);
    assert.deepEqual([...view.msgIndex.keys()], [10]);
    assert.equal(changed(), 0);
  });
}

for (const stage of ["download", "message"]) {
  test(`stale media ${stage} completion cannot fetch or update the new account`, async t => {
    const { view, core, switchTo } = setup(t);
    await view.open(7);
    const pending = deferred(), entered = deferred();
    let fetched = 0;
    core.downloadFullMessage = () => {
      if (stage === "download") { entered.resolve(); return pending.promise; }
      return Promise.resolve();
    };
    core.getMessage = () => { fetched++; entered.resolve(); return pending.promise; };
    const downloading = view._downloadMedia(10);
    await entered.promise;
    switchTo("B");
    await view.open(7);
    pending.resolve({ ...message(10), text: "old download" });
    await downloading;
    assert.equal(fetched, stage === "message" ? 1 : 0);
    assert.equal(view.msgIndex.get(10).msg.text, "message 10");
  });
}

test("stale context and reaction callbacks cannot act on identical IDs", async t => {
  const { view, core, node, switchTo, forwarded } = setup(t);
  await view.open(7);
  core.starMessages = core.addReaction = core.deleteMessages = () => assert.fail("stale menu dispatched RPC");
  view._msgContextMenu(view.msgIndex.get(10), 20, 20);
  const actions = [...node("popups").querySelector(".ctx-menu").children];
  view._reactionMenu(view.msgIndex.get(10), 20, 20);
  const reaction = node("popups").querySelector(".ctx-menu").children[0];
  switchTo("B");
  await view.open(7);
  for (const action of actions) await action.fire("click");
  await reaction.fire("click");
  assert.equal(forwarded(), 0);
  assert.equal(view.replyTo, null);
  assert.equal(view.selection.size, 0);
  assert.equal(node("popups").children.length, 0);
});

test("delete confirmation is cancelled on switch; in-flight delete cannot clear new selection", async t => {
  const { view, core, node, switchTo, changed } = setup(t);
  await view.open(7);
  let deleted = 0;
  const pending = deferred(), entered = deferred();
  core.deleteMessages = () => { deleted++; entered.resolve(); return pending.promise; };
  const cancelled = view._delete([10]);
  switchTo("B");
  await cancelled;
  assert.equal(deleted, 0);
  await view.open(7);
  const deleting = view._delete([10]);
  const button = node("popups").querySelectorAll("button").find(b => b.textContent === "Delete for me");
  await button.fire("click");
  await entered.promise;
  switchTo("A");
  await view.open(7);
  view.selection.add(10);
  pending.resolve();
  await deleting;
  assert.equal(deleted, 1);
  assert.equal(view.selection.has(10), true);
  assert.equal(changed(), 0);
});

test("switch after confirmation click but before its continuation prevents delete dispatch", async t => {
  const { view, core, node, switchTo } = setup(t);
  await view.open(7);
  core.deleteMessages = () => assert.fail("stale confirmation dispatched delete");
  const deleting = view._delete([10]);
  node("popups").querySelectorAll("button").find(b => b.textContent === "Delete for me").fire("click");
  switchTo("B");
  await deleting;
});

test("close cancels settling and queued outgoing scrolling cannot move a new view", async t => {
  const { view, node, frames } = setup(t);
  await view.open(7);
  const oldFrames = [...frames.values()];
  view.scrollEl.scrollTop = 600;
  await view.appendOutgoing(message(11));
  oldFrames.push(...frames.values());
  view.close();
  assert.equal(view._stopSettling, null);
  assert.equal(view.scrollEl.listeners.get("wheel").size, 0);
  await view.open(8);
  node("history-scroll").scrollTop = 123;
  for (const frame of oldFrames) frame();
  assert.equal(node("history-scroll").scrollTop, 123);
  assert.notEqual(view._stopSettling, null);
});

test("modal dismissal settles confirmations and invokes onClose only once", async t => {
  const { node } = setup(t);
  const confirmation = confirmModal("Delete", "Sure?");
  closeAllPopups();
  assert.equal(await confirmation, false);
  const deletion = confirmDeleteMessagesModal(1, true);
  showModal({ title: "Replacement" });
  assert.equal(await deletion, null);
  closeAllPopups();
  const accepted = confirmModal("Delete", "Sure?");
  await node("popups").querySelectorAll("button").find(b => b.textContent === "Delete").fire("click");
  assert.equal(await accepted, true);
  let closed = 0;
  const modal = showModal({ title: "Owned", onClose: () => closed++ });
  closeAllPopups();
  modal.close();
  assert.equal(closed, 1);
  assert.equal(node("popups").children.length, 0);
});
