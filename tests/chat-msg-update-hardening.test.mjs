import test from "node:test";
import assert from "node:assert/strict";

// Regression tests for the event-storm hardening in ChatView:
//  - duplicate msg updates must not loop re-render work for unmounted rows
//    (the "[virtual-scroller] The item is no longer rendered onscreen
//    (onItemHeightDidChange)" console spam), and
//  - msgs-changed bursts must collapse into one tail refetch per gap.

// Only the DOM surface used by ChatView's lifecycle and the real modal helpers.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.hidden = false;
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
  replaceWith(el) {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children[i] = el;
    el.parent = this.parent;
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
    const matches = el => {
      if (selector.startsWith(".")) return el.className.split(/\s+/).includes(selector.slice(1));
      const attr = selector.match(/^\[data-msgid="(.+)"\]$/);
      if (attr) return String(el.dataset.msgid) === attr[1];
      return el.tagName.toLowerCase() === selector;
    };
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { top: 20, left: 20, right: 200, bottom: 100, width: 180, height: 80 }; }
  focus() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  after(child) { const p = this.parent; if (!p) return child; p.children.splice(p.children.indexOf(this) + 1, 0, child); child.parent = p; return child; }
  scrollTo({ top }) { this.scrollTop = top; }
}

globalThis.HTMLElement = Element;
const elements = new Map();
globalThis.customElements = { get: name => elements.get(name), define: (name, el) => elements.set(name, el) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.innerHeight = 800;
globalThis.innerWidth = 1200;
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");

const message = (id, chatId = 7, overrides = {}) => ({
  id, chatId, from: 1, text: `message ${id}`, ts: 1700000000000,
  viewtype: "text", state: "sent", fromContact: { name: "Me" }, ...overrides,
});
const page = (...messages) => ({ messages, hasMore: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

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
    body: new Element("body"),
    addEventListener() {},
    removeEventListener() {},
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
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  // Rendering/layout is not under test; height notifications and the item
  // caches are, so the stub records exactly what the view asks of the
  // scroller.
  view._createScroller = function () {
    this.vs = {
      stop() {}, setItems() {},
      heightCalls: [],
      onItemHeightDidChange(item) { this.heightCalls.push(item.key); },
    };
  };
  view.startLive = () => {};
  t.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; });
  return { view, core, node };
}

test("duplicate msg updates for an unmounted row take the changed path at most once", async t => {
  const { view } = setup(t);
  await view.open(7);
  const msg = message(10, 7);

  // No rows are mounted in this harness — the "unmounted" branch runs.
  view.onMsgUpdated(7, msg);
  assert.equal(view._rowSigCache.get("m10"), view._rowSignature(msg),
    "the new signature must be remembered for unmounted rows, not deleted");
  assert.equal(view._rowCache.has("m10"), false, "the stale cached row must be dropped");

  view.onMsgUpdated(7, msg); // duplicate of the same data
  assert.equal(view.vs.heightCalls.length, 0,
    "an unmounted row must never fire onItemHeightDidChange");
  assert.equal(view._rowSigCache.get("m10"), view._rowSignature(msg),
    "the duplicate must short-circuit as a data-only change");

  // A remount rebuilds from the updated item and records its signature.
  const el = view._renderItem(view.msgIndex.get(10));
  assert.ok(el);
  assert.equal(view._rowSigCache.get("m10"), view._rowSignature(msg));
});

test("a changed unmounted message is rebuilt on remount, duplicates stay silent", async t => {
  const { view } = setup(t);
  await view.open(7);
  const edited = message(10, 7, { text: "edited" });

  view.onMsgUpdated(7, edited);
  view.onMsgUpdated(7, edited);
  assert.equal(view.vs.heightCalls.length, 0);

  const el = view._renderItem(view.msgIndex.get(10));
  assert.ok(el.innerHTML.includes("edited"), "the rebuilt row carries the new text");
  assert.equal(view._rowSigCache.get("m10"), view._rowSignature(edited));
});

test("a mounted row is rebuilt and height-notified exactly once per change", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const row = document.createElement("div");
  row.dataset.msgid = "10";
  node("history").appendChild(row);

  view.onMsgUpdated(7, message(10, 7, { text: "changed" }));
  assert.deepEqual(view.vs.heightCalls, ["m10"], "mounted rows are height-notified on rebuild");
  assert.notEqual(node("history").children[0], row, "the row was replaced");
  assert.ok(node("history").children[0].innerHTML.includes("changed"));
  assert.equal(view._rowSigCache.get("m10"), view._rowSignature(message(10, 7, { text: "changed" })));

  view.onMsgUpdated(7, message(10, 7, { text: "changed" }));
  assert.equal(view.vs.heightCalls.length, 1, "the identical duplicate must not rebuild");
});

test("msgs-changed bursts collapse into one refetch per gap with fresh carried through", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  const calls = [];
  core.getMessages = async (id, opts) => { calls.push(opts); return page(message(10, id)); };
  view.tailRefetchGapMs = 40;

  await view.onMsgsChanged(7, {});
  assert.equal(calls.length, 1, "the first refetch in a window runs immediately");

  view.onMsgsChanged(7, {});
  view.onMsgsChanged(7, { fresh: true });
  assert.equal(calls.length, 1, "bursts inside the gap are suppressed");

  await wait(120); // trailing refetch
  assert.equal(calls.length, 2, "exactly one trailing refetch runs after the burst");
  assert.equal(calls[1].fresh, true, "the trailing refetch inherits the freshest request");
});

test("incoming bursts near the bottom collapse to one markRead after the debounce", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  view.markReadDebounceMs = 5;
  let reads = 0;
  core.markRead = async () => { reads++; };

  // Sit "near the bottom" so onIncoming takes the read path.
  view.scrollEl.scrollTop = 520; // 1000 - 520 - 500 < 220

  await view.onIncoming(7, message(11, 7));
  await view.onIncoming(7, message(12, 7));
  assert.equal(reads, 0, "no markRead while the debounce window is open");

  await wait(30);
  assert.equal(reads, 1, "the burst collapses to exactly one markRead");
});

test("a pending debounced read is flushed on close", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  view.markReadDebounceMs = 10_000;
  let reads = 0;
  core.markRead = async () => { reads++; };
  view.scrollEl.scrollTop = 520;

  await view.onIncoming(7, message(11, 7));
  assert.equal(reads, 0, "scheduled, not fired");
  view.close();
  assert.equal(reads, 1, "close must flush the pending markRead");
});

test("isMediaFilePath classifies openable media for the Android lightbox path", async t => {
  const { isMediaFilePath } = await import("../app/js/chat-view.js");
  assert.equal(isMediaFilePath("/data/x/abc.webp"), true, "animated webp opens in the lightbox");
  assert.equal(isMediaFilePath("/data/x/photo.JPG"), true, "case-insensitive");
  assert.equal(isMediaFilePath("/data/x/doc.pdf"), false, "non-media stays out of the lightbox");
  assert.equal(isMediaFilePath(""), false);
});

test("Android open of a non-media file toasts instead of calling the opener plugin", async t => {
  const { view } = setup(t);
  await view.open(7);
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Android 15; Mobile)" }, configurable: true });
  t.after(() => {
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
  });

  const toasts = document.getElementById("toasts");
  const before = toasts ? toasts.children.length : 0;
  view._openFile("/data/x/dc.db-blobs/doc.pdf", "doc.pdf");
  const after = toasts ? toasts.children.length : before;
  assert.equal(after, before + 1, "an honest toast replaces the crashing opener call");
});

test("fetch-then-jump walks older pages until the target message loads", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  view.jumpSeekAttempts = 1;
  view.jumpSeekDelayMs = 1;
  const beforeIds = [];
  core.getMessages = async (id, opts) => {
    beforeIds.push(opts.beforeId);
    if (opts.beforeId === 10) return { messages: [message(9, 7)], hasMore: true };
    return { messages: [message(8, 7), message(7, 7)], hasMore: false };
  };

  await view._jumpToMessage(7);

  assert.deepEqual(beforeIds, [10, 9], "walks beforeId chain from the oldest loaded id");
  assert.equal(view._hasItem(7), true, "target message is loaded");
  assert.equal(view.hasMore, false);
});

test("jump gives up with a toast when history is exhausted without the target", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  view.jumpMaxPages = 3;
  view.jumpSeekAttempts = 1;
  core.getMessages = async () => ({ messages: [message(50, 7)], hasMore: false });
  const toasts = document.getElementById("toasts");
  const before = toasts ? toasts.children.length : 0;

  await view._jumpToMessage(7);

  const after = toasts ? toasts.children.length : before;
  assert.equal(after, before + 1, "give-up toast shown");
  assert.equal(view._hasItem(7), false);
});

test("composer Enter respects the send-on-enter setting", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  const input = document.getElementById("composer-input");
  let sent = 0;
  core.sendMessage = async () => { sent++; return message(99, 7, { text: "hi" }); };

  // Default (unset = on): Enter sends and clears the input.
  localStorage.setItem("velta-send-enter", "1");
  input.value = "hi";
  await input.fire("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(sent, 1, "Enter sends when the setting is on");
  assert.equal(input.value, "", "input cleared after send");

  // Off: Enter must not send — the textarea inserts the newline natively and
  // the composer grows via its input handler.
  localStorage.setItem("velta-send-enter", "0");
  input.value = "line one";
  await input.fire("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(sent, 1, "no send when the setting is off");
  assert.equal(input.value, "line one", "text untouched when the setting is off");

  // Shift+Enter is always a newline, regardless of the setting.
  localStorage.removeItem("velta-send-enter");
  await input.fire("keydown", { key: "Enter", shiftKey: true, preventDefault() {} });
  assert.equal(sent, 1, "shift+enter never sends");
});
