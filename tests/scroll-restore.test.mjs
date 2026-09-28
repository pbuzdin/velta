import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

// Issue #18: "Remember scroll position in chats" (drawer setting, default
// off) and deterministic open landing. The stub DOM below lays every row out
// at a fixed height (no virtualization) so row rects, scrollHeight and the
// scroll clamp behave like a real scroller: close() measures the topmost
// visible row, open() settles back onto it, and scrollTop writes dispatch
// an async "scroll" event exactly like a browser (programmatic scrolls
// included — the anchor gate must tell them apart from user scrolls).

const ROW_H = 50, VIEW_TOP = 100, VIEW_H = 500;

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
    this.scrollHeight = 1000;
    this.clientHeight = VIEW_H;
    this._scrollTop = 0;
    this.classList = {
      add: (...names) => { this.className += " " + names.join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(" "); },
      toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(v) { this._scrollTop = v; }
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
  fire(name, event = {}) { return Promise.all([...this.listeners.get(name) || []].map(fn => fn({ type: name, target: this, currentTarget: this, ...event }))); }
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

// The history scroller: content height follows the mounted rows, writes
// clamp to [0, max] and fire "scroll" asynchronously (one per write burst).
class ScrollEl extends Element {
  constructor(list) { super(); this.list = list; this.scrollToCalls = []; }
  get scrollHeight() { return Math.max(VIEW_H, this.list.children.length * ROW_H); }
  set scrollHeight(_) {}
  get scrollTop() { return this._scrollTop; }
  set scrollTop(v) {
    const top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, Math.round(v)));
    if (top === this._scrollTop) return;
    this._scrollTop = top;
    if (!this._scrollQueued) {
      this._scrollQueued = true;
      setImmediate(() => { this._scrollQueued = false; this.fire("scroll"); });
    }
  }
  scrollTo({ top, behavior }) { this.scrollToCalls.push(behavior || "auto"); this.scrollTop = top; }
  getBoundingClientRect() { return { top: VIEW_TOP, bottom: VIEW_TOP + VIEW_H, left: 0, right: 400, width: 400, height: VIEW_H }; }
}

function makeRow(msgId, list, scroll) {
  const row = new Element();
  row.className = "msg-row";
  row.dataset.msgid = String(msgId);
  row.getBoundingClientRect = () => {
    const top = VIEW_TOP + list.children.indexOf(row) * ROW_H - scroll.scrollTop;
    return { top, bottom: top + ROW_H, left: 0, right: 400, width: 400, height: ROW_H };
  };
  return row;
}

globalThis.HTMLElement = Element;
const elements = new Map();
globalThis.customElements = { get: name => elements.get(name), define: (name, el) => elements.set(name, el) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.innerHeight = 800;
globalThis.innerWidth = 1200;
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView, REMEMBER_SCROLL_KEY } = await import("../app/js/chat-view.js");
const { pageBounds } = await import("../app/js/mock-core.js");
const { setReadMarker } = await import("../app/js/read-markers.js");
const { closeAllPopups } = await import("../app/js/ui.js");

// A settle runs 40 ms ticks until 4 stable ones, then re-asserts after
// 450 ms — ~700 ms end to end. Ref'd sleep: the app's timers are unref'd.
const wait = ms => sleep(ms);
async function settled(view) {
  await wait(60);
  for (let i = 0; i < 300 && view._settling; i++) await wait(20);
  await wait(20); // the re-assert's own scroll event
}

const msg = (id, chatId, unread = false) => ({
  id, chatId, from: unread ? 2 : 1, text: `m${id}`, ts: 1700000000000 + id * 1000,
  viewtype: "text", state: unread ? "fresh" : "sent", unread, fromContact: { name: "X" },
});

function setup(t, { remember = false } = {}) {
  if (remember) localStorage.setItem(REMEMBER_SCROLL_KEY, "1");
  else localStorage.removeItem(REMEMBER_SCROLL_KEY);
  const list = new Element();
  const scroll = new ScrollEl(list);
  const nodes = new Map([["history", list], ["history-scroll", scroll]]);
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
  globalThis.requestAnimationFrame = () => 0; // seen-marking is not under test
  globalThis.cancelAnimationFrame = () => {};
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => timer(...args).unref());
  window.__TAURI__ = null;

  // Per-account chats: 7 has 200 fully read messages (ids 1..200), 8 is short.
  const data = { A: { 7: [], 8: [] }, B: { 7: [], 8: [] } };
  for (const acct of ["A", "B"]) {
    for (let id = 1; id <= 200; id++) data[acct][7].push(msg(id, 7));
    for (let id = 501; id <= 520; id++) data[acct][8].push(msg(id, 8));
  }
  const calls = [];
  const core = Object.assign(new EventTarget(), {
    accountId: "A", accountEpoch: 0,
    getChat: async id => ({ id, kind: "group", unread: data[core.accountId][id].filter(m => m.unread).length, encrypted: true }),
    getMessages: async (id, opts = {}) => {
      calls.push({ chatId: id, ...opts });
      const all = data[core.accountId][id];
      const ids = all.map(m => m.id);
      const { start, end } = pageBounds(ids, opts);
      return { messages: all.slice(start, end), hasMore: start > 0, hasNewer: end < ids.length };
    },
    getFirstUnreadMessageId: async id => data[core.accountId][id].find(m => m.unread)?.id ?? null,
    markSeen: async () => {},
    markRead: async () => {},
  });
  const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
  // Non-virtual scroller: every item is mounted; prepends keep the view
  // where it was (preserveScrollPositionOnPrependItems).
  const mount = (items) => list.replaceChildren(...items.map(it => makeRow(it.msg.id, list, scroll)));
  view._createScroller = function () {
    mount(this.items);
    this.vs = {
      stop() {},
      setItems(items, opts) {
        const before = list.children.length;
        mount(items);
        if (opts?.preserveScrollPositionOnPrependItems) scroll.scrollTop += (items.length - before) * ROW_H;
      },
      onItemHeightDidChange() {},
    };
  };
  view.startLive = () => {};
  t.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; localStorage.removeItem(REMEMBER_SCROLL_KEY); });

  const open = async (chatId) => { assert.equal(await view.open(chatId), true); await settled(view); };
  // A genuine user scroll: input event first (wheel over the rows, bubbling
  // to the scroller), then the scroll.
  const userScroll = async (top) => {
    await list.fire("wheel");
    await scroll.fire("wheel");
    scroll.scrollTop = top;
    await wait(20);
  };
  const topVisible = () => view._topVisibleAnchor();
  const atBottom = () => scroll.scrollTop === scroll.scrollHeight - scroll.clientHeight;
  return { view, core, data, calls, scroll, list, open, userScroll, topVisible, atBottom };
}

// Opens chat 7, scrolls up to mid-history like a user, returns the anchor.
async function scrolledUp(h, top = 600) {
  await h.open(7);
  assert.ok(h.atBottom(), "a fully read chat opens at the bottom");
  await h.userScroll(top);
  const anchor = h.topVisible();
  assert.ok(anchor && !h.view._nearBottom(), "scrolled off the bottom");
  return anchor;
}

test("setting off (default): reopening a scrolled fully-read chat lands at the bottom, nothing is remembered", async t => {
  const h = setup(t);
  assert.equal(localStorage.getItem(REMEMBER_SCROLL_KEY), null, "default is off");
  await scrolledUp(h);
  await h.open(8);
  assert.equal(h.view._scrollAnchors.size, 0, "no anchor saved while the setting is off");
  h.calls.length = 0;
  await h.open(7);
  assert.ok(h.atBottom(), "lands at the bottom exactly as before");
  assert.deepEqual(h.calls[0], { chatId: 7, limit: 40 }, "tail page, no aroundId");
});

test("setting on: a fully-read chat scrolled mid-history reopens at the saved anchor and offset", async t => {
  const h = setup(t, { remember: true });
  const anchor = await scrolledUp(h, 625); // row partly scrolled out → dy < 0
  assert.ok(anchor.dy < 0);
  await h.open(8);
  assert.deepEqual(h.view._scrollAnchors.get(JSON.stringify(["A", "7"])), anchor);
  h.calls.length = 0;
  await h.open(7);
  assert.equal(h.calls[0].aroundId, anchor.anchorId, "opens a window around the anchor");
  assert.deepEqual(h.topVisible(), anchor, "same top row at the same viewport offset");
  assert.equal(h.view.goDownBtn.hidden, false, "the way back down is offered");
  // Leaving again without touching anything keeps the position (A→B→A→B→A).
  await h.open(8);
  await h.open(7);
  assert.deepEqual(h.topVisible(), anchor);
});

test("setting on: scrolling back to the bottom forgets the anchor", async t => {
  const h = setup(t, { remember: true });
  await scrolledUp(h);
  await h.userScroll(1e9);
  await h.open(8);
  assert.equal(h.view._scrollAnchors.size, 0);
  await h.open(7);
  assert.ok(h.atBottom());
});

test("setting on: the first unread message and the read marker still win over a saved anchor", async t => {
  const h = setup(t, { remember: true });
  const anchor = await scrolledUp(h);
  await h.open(8);
  assert.ok(h.view._scrollAnchors.size === 1);
  // New unread messages arrived meanwhile.
  for (const m of h.data.A[7].slice(190)) m.unread = true;
  h.calls.length = 0;
  await h.open(7);
  assert.equal(h.calls[0].aroundId, 191, "first unread wins");
  assert.notEqual(h.topVisible().anchorId, anchor.anchorId);
  assert.equal(h.view._scrollAnchors.size, 0, "new unread messages retire the saved anchor");

  // Read marker (only honoured while unread remain) beats the anchor too.
  for (const m of h.data.A[7]) m.unread = false;
  await h.open(7);
  await h.userScroll(600);
  await h.open(8);
  assert.equal(h.view._scrollAnchors.size, 1);
  setReadMarker("A", 7, 185);
  for (const m of h.data.A[7].slice(195)) m.unread = true;
  h.calls.length = 0;
  await h.open(7);
  assert.equal(h.calls[0].aroundId, 185, "read marker wins");
  assert.equal(h.view._scrollAnchors.size, 0);
});

test("setting on: a deleted anchor message falls back to the bottom", async t => {
  const h = setup(t, { remember: true });
  const anchor = await scrolledUp(h);
  await h.open(8);
  h.data.A[7] = h.data.A[7].filter(m => m.id !== anchor.anchorId);
  h.calls.length = 0;
  await h.open(7);
  assert.equal(h.calls[0].aroundId, anchor.anchorId);
  assert.deepEqual(h.calls[1], { chatId: 7, limit: 40 }, "reloads the tail page");
  assert.ok(h.atBottom(), "lands at the bottom");
  assert.equal(h.view._scrollAnchors.size, 0, "the stale anchor is dropped");
});

test("setting on: anchors are per account and never leak across an account switch", async t => {
  const h = setup(t, { remember: true });
  const anchor = await scrolledUp(h);
  await h.open(8);
  h.core.accountId = "B";
  h.core.accountEpoch++;
  h.calls.length = 0;
  await h.open(7); // same chat id, other account
  assert.deepEqual(h.calls[0], { chatId: 7, limit: 40 }, "account B never sees A's anchor");
  assert.ok(h.atBottom());
  await h.open(8);
  h.core.accountId = "A";
  h.core.accountEpoch++;
  await h.open(7);
  assert.deepEqual(h.topVisible(), anchor, "A's own anchor survives the round trip");
});

test("setting on: programmatic settles and scrolls never create an anchor", async t => {
  const h = setup(t, { remember: true });
  // Opens at the first unread message: the settle parks the view
  // mid-history (the window reaches the tail — the chat really is fully
  // read afterwards), then everything gets seen without any user scroll.
  for (const m of h.data.A[7].slice(170)) m.unread = true;
  await h.open(7);
  assert.equal(h.view._nearBottom(), false, "settled mid-history");
  assert.equal(h.view.hasNewer, false);
  h.view._markSeenThrough(h.view.items.length - 1); // flips the shared msgs = core seen state
  assert.equal(h.view._unreadIds.size, 0, "fully read now");
  assert.equal(h.view._newWhileAway, 0);
  // A programmatic scroll outside any settle (no user input) either.
  h.scroll.scrollTop = 900;
  await wait(20);
  h.view._scrollToMessageSettling(150);
  await settled(h.view);
  assert.equal(h.view._nearBottom(), false);
  await h.open(8);
  assert.equal(h.view._scrollAnchors.size, 0, "no anchor without a genuine user scroll");
});

test("setting on: leaving with unseen messages loaded does not save an anchor", async t => {
  const h = setup(t, { remember: true });
  await scrolledUp(h);
  // An incoming message lands while scrolled up (not seen yet).
  await h.view.onIncoming(7, msg(201, 7, true));
  await h.open(8);
  assert.equal(h.view._scrollAnchors.size, 0);
});

test("setting off: turning the setting off forgets anchors on the next close", async t => {
  const h = setup(t, { remember: true });
  await scrolledUp(h);
  await h.open(8);
  assert.equal(h.view._scrollAnchors.size, 1);
  localStorage.removeItem(REMEMBER_SCROLL_KEY);
  h.calls.length = 0;
  await h.open(7);
  assert.deepEqual(h.calls[0], { chatId: 7, limit: 40 }, "ignored while off");
  assert.ok(h.atBottom());
  await h.open(8);
  assert.equal(h.view._scrollAnchors.size, 0);
});

test("deterministic landing: reopening lands at the exact bottom with no paging during the open settle", async t => {
  const h = setup(t);
  for (let round = 0; round < 3; round++) {
    await h.open(7);
    await h.userScroll(0); // user paged up into older history
    await wait(20);
    await h.open(8);
    h.calls.length = 0;
    h.scroll.scrollToCalls.length = 0;
    const opened = h.view.open(7);
    // close() left scrollTop at 0: its scroll event must not page older
    // history in under the settle (that prepend moved the landing).
    await opened;
    await settled(h.view);
    assert.deepEqual(h.calls.map(c => c.beforeId ?? null), [null], `round ${round}: only the tail page loads during open`);
    assert.equal(h.view.items.length, 40);
    assert.ok(h.atBottom(), `round ${round}: exactly at the bottom`);
    assert.ok(!h.scroll.scrollToCalls.includes("smooth"), "the settle's final re-assert is instant, not smooth");
  }
});
