import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

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
  insertBefore(child, before) {
    child.remove();
    const i = before ? this.children.indexOf(before) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    child.parent = this;
    return child;
  }
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
// Ref'd on purpose: setup() swaps the global setTimeout for an unref'd one,
// and ChatView's own interval timers (settle pin) are unref'd too, so a wait
// built on the global would let the event loop drain mid-test.
const wait = ms => sleep(ms);
// Same reason for app code that sleeps on the global setTimeout (the jump
// seek's jumpSeekDelayMs pause): hold the loop open until it settles.
async function held(promise) {
  const keepAlive = setInterval(() => {}, 1000);
  try { return await promise; } finally { clearInterval(keepAlive); }
}

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

function reactionRow() {
  const row = document.createElement("div");
  row.dataset.msgid = "10";
  row.className = "msg-row";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const chips = document.createElement("div");
  chips.className = "msg-reactions";
  chips.innerHTML = "old";
  const track = document.createElement("div");
  track.className = "msg-hover-reply-track";
  bubble.append(chips, track);
  row.append(bubble);
  return row;
}

test("a reaction updates the chips and keeps the same row", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const row = reactionRow();
  node("history").appendChild(row);
  view._rowCache.set("m10", row);
  view._rowSigCache.set("m10", view._rowSignature(message(10, 7)));
  const bubble = row.querySelector(".bubble");

  view.onMsgUpdated(7, message(10, 7, { reactions: [{ emoji: "👍", count: 2, mine: true }] }));
  assert.equal(node("history").children[0], row, "the bubble element is kept");
  assert.equal(bubble.querySelector(".msg-reactions").innerHTML.includes("👍"), true);
  assert.equal(bubble.children.at(-1).className, "msg-hover-reply-track", "the reply track stays last");
  assert.deepEqual(view.vs.heightCalls, ["m10"]);

  view.onMsgUpdated(7, message(10, 7, { reactions: [{ emoji: "👍", count: 2, mine: true }] }));
  assert.equal(view.vs.heightCalls.length, 1, "the same reaction does not patch again");

  view.onMsgUpdated(7, message(10, 7, { reactions: [] }));
  assert.equal(bubble.querySelector(".msg-reactions"), null);
  assert.equal(view.vs.heightCalls.length, 2);
});

test("a reaction on an unmounted cached row patches the cache and does not notify height", async t => {
  const { view } = setup(t);
  await view.open(7);
  const row = reactionRow();
  view._rowCache.set("m10", row);
  view._rowSigCache.set("m10", view._rowSignature(message(10, 7)));

  view.onMsgUpdated(7, message(10, 7, { reactions: [{ emoji: "🎉", count: 1, mine: false }] }));
  assert.equal(view._rowCache.get("m10"), row);
  assert.equal(row.querySelector(".msg-reactions").innerHTML.includes("🎉"), true);
  assert.equal(view.vs.heightCalls.length, 0);
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

test("a known chat's msgs-changed refetches without forcing fresh (#43)", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  const calls = [];
  core.getMessages = async (id, opts) => { calls.push(opts); return page(message(10, id)); };
  view.tailRefetchGapMs = 40;

  core.dispatchEvent(new CustomEvent("msgs-changed", { detail: { chatId: 7 } }));
  await wait(80);
  assert.equal(calls.length, 1, "the known-chat event refetched the tail");
  assert.equal(calls[0].fresh, false, "known chat: no forced id-list rebuild");

  core.dispatchEvent(new CustomEvent("msgs-changed", { detail: { chatId: 0 } }));
  await wait(80);
  assert.equal(calls.length, 2, "the unknown-scope event refetched");
  assert.equal(calls[1].fresh, true, "unknown scope still rebuilds the ids");
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

  await held(view._jumpToMessage(7));

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

test("a saved copy renders the show-in-chat arrow", async t => {
  const { view } = setup(t);
  await view.open(7);
  const item = view.msgIndex.get(10);
  item.msg = { ...item.msg, originalMsgId: 42 };
  const el = view._renderItem(item);
  assert.match(el.className, /has-original/);
  assert.match(el.innerHTML, /data-act="show-original"/);
  assert.match(el.innerHTML, /Show in chat/);

  item.msg = { ...item.msg, originalMsgId: null };
  const plain = view._buildItem(item);
  assert.equal(plain.innerHTML.includes("show-original"), false);
});

test("show in chat opens the source chat and jumps to the original", async t => {
  const { view, core } = setup(t);
  await view.open(7);
  const opened = [];
  const jumps = [];
  view.onOpenChat = async (id) => {
    opened.push(id);
    view.chat = { id, kind: "single" };
  };
  view._jumpToMessage = (id) => { jumps.push(id); };
  core.getMessage = async (id) => ({ id, chatId: 3 });

  await view._showOriginal({ originalMsgId: 42 });
  assert.deepEqual(opened, [3]);
  assert.deepEqual(jumps, [42]);

  opened.length = 0;
  jumps.length = 0;
  core.getMessage = async (id) => ({ id, chatId: 7 });
  view.chat = { id: 7, kind: "saved" };
  await view._showOriginal({ originalMsgId: 42 });
  assert.deepEqual(opened, [], "same chat does not reopen");
  assert.deepEqual(jumps, [42]);

  jumps.length = 0;
  core.getMessage = async () => null;
  await view._showOriginal({ originalMsgId: 99 });
  assert.deepEqual(jumps, []);
});

function selectableRow(text = "hello there friend") {
  const row = document.createElement("div");
  row.className = "msg-row";
  row.dataset.msgid = "10";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const body = document.createElement("div");
  body.className = "msg-text";
  body.textContent = text;
  bubble.append(body);
  row.append(bubble);
  return row;
}

function installSelection(t, node, text) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied = null;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: (s) => { copied = s; return Promise.resolve(); } }, userAgent: "test" },
    configurable: true,
  });
  const prevSel = window.getSelection;
  window.getSelection = () => ({
    isCollapsed: !text,
    rangeCount: text ? 1 : 0,
    toString: () => text,
    getRangeAt: () => ({ commonAncestorContainer: node }),
    removeAllRanges() {},
  });
  t.after(() => {
    window.getSelection = prevSel;
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
  });
  return () => copied;
}

test("Select text opens an in-bubble bar and blocks the message menu", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const row = selectableRow();
  node("history").appendChild(row);
  const text = row.querySelector(".msg-text");

  view._msgContextMenu(view.msgIndex.get(10), 8, 8);
  const menu = node("popups").querySelector(".ctx-menu");
  const select = [...menu.children].find(b => b.innerHTML.includes(">Select text<"));
  assert.ok(select, "the message menu offers Select text");
  await select.fire("click");

  assert.ok(text.className.split(/\s+/).includes("text-selecting"));
  const bar = row.querySelector(".msg-select-bar");
  assert.deepEqual(bar.children.map(b => b.textContent), ["Reply", "Copy", "Close"]);
  assert.equal(bar, row.querySelector(".bubble").children[0], "the bar sits at the top of the bubble");
  assert.deepEqual(view.vs.heightCalls, ["m10"]);
  assert.equal(view._selChip.hidden, true);

  view._selChip.hidden = false;
  view._updateSelChip();
  assert.equal(view._selChip.hidden, true, "the floating Reply chip stays hidden while the bar is up");

  node("popups").replaceChildren();
  view._msgContextMenu(view.msgIndex.get(10), 8, 8);
  assert.equal(node("popups").querySelector(".ctx-menu"), null, "the menu cannot open while selecting");

  const outside = document.createElement("div");
  view._textSelect.exit({ target: outside });
  assert.equal(view._textSelect, null);
  assert.equal(text.className.includes("text-selecting"), false);
  assert.equal(row.querySelector(".msg-select-bar"), null);
  assert.deepEqual(view.vs.heightCalls, ["m10", "m10"]);
});

test("Reply quotes the selected span and Copy writes that span", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const row = selectableRow("hello there friend");
  node("history").appendChild(row);
  const text = row.querySelector(".msg-text");
  const copied = installSelection(t, text, "there");

  view._enterBubbleTextSelection(row);
  view._textSelect.exit({ target: text });
  assert.ok(view._textSelect, "a tap on the selected text stays in the mode");
  view._textSelect.exit({ target: row.querySelector(".msg-select-btn") });
  assert.ok(view._textSelect, "a tap on the bar stays in the mode");

  const click = { preventDefault() {}, stopPropagation() {} };
  await row.querySelector(".msg-select-bar").children.find(b => b.textContent === "Reply").fire("click", click);
  assert.equal(view.replyFragment, "there");
  assert.equal(view.replyTo.id, 10);
  assert.equal(view._textSelect, null);

  view._enterBubbleTextSelection(row);
  await row.querySelector(".msg-select-bar").children.find(b => b.textContent === "Copy").fire("click", click);
  assert.equal(copied(), "there");
  assert.equal(view._textSelect, null);
});

test("a read-only chat's select bar has no Reply", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const row = selectableRow();
  node("history").appendChild(row);
  view.readOnly = true;
  view._enterBubbleTextSelection(row);
  assert.deepEqual(row.querySelector(".msg-select-bar").children.map(b => b.textContent), ["Copy", "Close"]);
});

test("Select text is offered for a caption, Copy text stays plain-text only", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const item = view.msgIndex.get(10);
  item.msg = { ...item.msg, viewtype: "image", text: "caption" };
  view._msgContextMenu(item, 4, 4);
  const html = [...node("popups").querySelector(".ctx-menu").children].map(b => b.innerHTML);
  assert.ok(html.some(h => h.includes(">Select text<")));
  assert.equal(html.some(h => h.includes(">Copy text<")), false);
});

test("a second finger cancels long-press and does not select text", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const item = view.msgIndex.get(10);
  const row = view._buildItem(item);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = "hello";
  bubble.append(text);
  row.append(bubble);

  let opened = 0;
  const orig = view._msgContextMenu.bind(view);
  view._msgContextMenu = (...args) => { opened++; return orig(...args); };

  await row.fire("touchstart", { touches: [{ clientX: 2, clientY: 2 }] });
  await wait(600);
  assert.equal(opened, 1, "a still long-press still opens the menu");

  opened = 0;
  node("popups").replaceChildren();
  await row.fire("touchstart", { touches: [{ clientX: 2, clientY: 2 }] });
  await row.fire("touchstart", { touches: [{ clientX: 2, clientY: 2 }, { clientX: 8, clientY: 9 }] });
  await row.fire("touchend", { touches: [] });
  await wait(600);
  assert.equal(opened, 0, "a second finger cancels the long-press timer");
  assert.equal(text.className.includes("text-selecting"), false);
  assert.equal(row.querySelector(".msg-select-bar"), null);
});

test("Close clears the selection while the text is still selectable", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const row = selectableRow("hello there");
  node("history").appendChild(row);
  const text = row.querySelector(".msg-text");
  let clearedWhileSelectable = false;
  window.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: false,
    toString: () => "hello",
    getRangeAt: () => ({ commonAncestorContainer: text }),
    removeAllRanges() {
      if (text.className.split(/\s+/).includes("text-selecting")) clearedWhileSelectable = true;
    },
  });
  t.after(() => { delete window.getSelection; });

  view._enterBubbleTextSelection(row);
  const closeBtn = [...row.querySelector(".msg-select-bar").children].find(b => b.textContent === "Close");
  let prevented = false;
  await closeBtn.fire("pointerdown", { preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, false, "Close lets the WebView dismiss its handles");
  await closeBtn.fire("click", { preventDefault() {}, stopPropagation() {} });
  assert.equal(clearedWhileSelectable, true, "the range is cleared before user-select flips to none");
  assert.equal(text.className.includes("text-selecting"), false);
  assert.equal(text.style.userSelect, "", "the inline user-select override does not stick");
  assert.equal(view._textSelect, null);
});

test("Select text is hidden on a fine pointer and shown on a coarse one", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const item = view.msgIndex.get(10);
  t.after(() => { delete globalThis.matchMedia; });

  globalThis.matchMedia = (q) => ({ matches: q === "(hover: hover) and (pointer: fine)" });
  view._msgContextMenu(item, 4, 4);
  let html = [...node("popups").querySelector(".ctx-menu").children].map(b => b.innerHTML);
  assert.equal(html.some(h => h.includes(">Select text<")), false, "desktop menu has no Select text");
  assert.ok(html.some(h => h.includes(">Copy text<")));

  node("popups").replaceChildren();
  globalThis.matchMedia = () => ({ matches: false });
  view._msgContextMenu(item, 4, 4);
  html = [...node("popups").querySelector(".ctx-menu").children].map(b => b.innerHTML);
  assert.ok(html.some(h => h.includes(">Select text<")), "a coarse pointer still gets Select text");
});

test("the message menu has no Read up to here item", async t => {
  const { view, node } = setup(t);
  await view.open(7);
  const item = view.msgIndex.get(10);
  view._tracked = true;
  view._msgContextMenu(item, 4, 4);
  let labels = [...node("popups").querySelector(".ctx-menu").children].map(b => b.innerHTML);
  assert.equal(labels.some(h => h.includes("Read up to here")), false);
  assert.equal(labels.some(h => h.includes("Remove read marker")), false);

  view.readMarkerId = item.msg.id;
  node("popups").replaceChildren();
  view._msgContextMenu(item, 4, 4);
  labels = [...node("popups").querySelector(".ctx-menu").children].map(b => b.innerHTML);
  assert.equal(labels.some(h => h.includes("Read up to here") || h.includes("Remove read marker")), false);
});

function mobileGestures(t, on) {
  globalThis.matchMedia = (q) => {
    if (q === "(max-width: 820px)") return { matches: on };
    if (q === "(hover: hover) and (pointer: fine)") return { matches: !on };
    return { matches: false };
  };
  t.after(() => { delete globalThis.matchMedia; });
}

function touchOn(target) {
  return {
    target,
    closest(sel) {
      if (sel === ".bubble") return target;
      return null;
    },
  };
}

test("swipe right on a bubble replies, and only on mobile", async t => {
  const { view } = setup(t);
  await view.open(7);
  mobileGestures(t, true);
  const row = view._buildItem(view.msgIndex.get(10));
  const bubble = document.createElement("div");
  const target = touchOn(bubble);
  const move = (x, y) => row.fire("touchmove", {
    touches: [{ clientX: x, clientY: y }], target, cancelable: true, preventDefault() {},
  });

  await row.fire("touchstart", { touches: [{ clientX: 10, clientY: 40 }], target });
  await move(200, 42);
  assert.equal(bubble.style.transform, "translateX(64px)");
  await row.fire("touchend", { touches: [] });
  assert.equal(view.replyTo.id, 10);
  assert.equal(bubble.style.transform, "");

  view.replyTo = null;
  await row.fire("touchstart", { touches: [{ clientX: 10, clientY: 40 }], target });
  await move(30, 40);
  await row.fire("touchend", { touches: [] });
  assert.equal(view.replyTo, null, "a short drag does not reply");

  await row.fire("touchstart", { touches: [{ clientX: 10, clientY: 40 }], target });
  await move(14, 80);
  assert.equal(bubble.style.transform, "");
  await row.fire("touchend", { touches: [] });
  assert.equal(view.replyTo, null, "a vertical drag stays a scroll");

  view.readOnly = true;
  await row.fire("touchstart", { touches: [{ clientX: 10, clientY: 40 }], target });
  await move(80, 40);
  assert.equal(bubble.style.transform, "", "a read-only chat does not slide");
  view.readOnly = false;

  mobileGestures(t, false);
  await row.fire("touchstart", { touches: [{ clientX: 10, clientY: 40 }], target });
  await move(80, 40);
  assert.equal(bubble.style.transform, "", "a fine pointer does not swipe-reply");
});

test("swipe left on the history slides the chat column away and goes back", async t => {
  let backs = 0;
  const { view, node } = setup(t);
  view.onBack = () => { backs++; };
  await view.open(7);
  mobileGestures(t, true);
  const scroller = node("history-scroll");
  const main = node("main");
  const app = document.querySelector(".app");
  const slide = async (x) => {
    await scroller.fire("touchstart", { touches: [{ clientX: 200, clientY: 80 }] });
    await scroller.fire("touchmove", {
      touches: [{ clientX: x, clientY: 84 }], cancelable: true, preventDefault() {},
    });
  };

  await slide(120);
  assert.equal(main.style.transform, "translateX(-80px)");
  assert.ok(app.className.includes("swipe-back"));
  await scroller.fire("touchend", { touches: [] });
  assert.equal(main.style.transform, "translateX(-100%)");
  await main.fire("transitionend");
  assert.equal(backs, 1);
  assert.equal(main.style.transform, "");
  assert.equal(app.className.includes("swipe-back"), false);

  await view.open(7);
  await slide(180);
  await scroller.fire("touchend", { touches: [] });
  await main.fire("transitionend");
  assert.equal(backs, 1, "a short drag snaps back");

  view._replySwipe = true;
  await slide(100);
  assert.equal(main.style.transform, "", "a reply swipe owns the finger");
  view._replySwipe = false;

  await slide(120);
  await scroller.fire("touchend", { touches: [] });
  assert.equal(main.style.transform, "translateX(-100%)");
  view.close();
  assert.equal(main.style.transform, "translateX(100%)", "close parks the column on the closed side");
  assert.equal(app.className.includes("swipe-back"), false);
});
