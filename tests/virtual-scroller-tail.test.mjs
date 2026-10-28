// A send rebuilds the history rows. If the viewport then sits past every
// measured row, the stock scroller paints item 0 and the screen stays blank.
// The tail window has to include the last item, and scroll has to land on it.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

function el(tag) {
  const node = {
    tagName: tag,
    childNodes: [],
    parent: null,
    _scrollTop: 0,
    clientHeight: 500,
    clientWidth: 400,
    offsetHeight: 500,
    offsetWidth: 400,
    clientTop: 0,
    rowHeight: 40,
    classList: { contains() { return false }, add() {}, remove() {} },
    listeners: {},
    appendChild(ch) {
      if (ch.parent) ch.parent.removeChild(ch);
      ch.parent = this;
      this.childNodes.push(ch);
      return ch;
    },
    removeChild(ch) {
      const i = this.childNodes.indexOf(ch);
      if (i < 0) throw new Error("not a child");
      this.childNodes.splice(i, 1);
      ch.parent = null;
    },
    insertBefore(ch, ref) {
      if (ch.parent) ch.parent.removeChild(ch);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      ch.parent = this;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, ch);
      return ch;
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    get firstChild() { return this.childNodes[0] || null; },
    contentHeight() {
      const pad = (k) => parseFloat(this.style[k]) || 0;
      let h = pad("paddingTop") + pad("paddingBottom");
      for (const c of this.childNodes) h += c.rowHeight || 0;
      return h;
    },
    // scrollTo clamps like a browser. Direct scrollTop does not, so a test
    // can park the viewport on the padding just past the last row.
    scrollTo(x, y) {
      if (x && typeof x === "object") y = x.top ?? 0;
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      const target = Number.isFinite(y) ? y : max;
      this._scrollTop = Math.max(0, Math.min(target, max));
    },
    get scrollTop() { return this._scrollTop; },
    set scrollTop(v) { this._scrollTop = Number(v) || 0; },
    get scrollHeight() { return this.itemsEl ? this.itemsEl.contentHeight() : this.contentHeight(); },
    getBoundingClientRect() {
      if (this.tagName === "SCROLL") {
        return { top: 0, left: 0, width: 400, height: this.clientHeight, bottom: this.clientHeight, right: 400 };
      }
      if (this.tagName === "ITEMS") {
        const top = -(this.scrollParent?.scrollTop || 0);
        const h = this.contentHeight();
        return { top, left: 0, width: 400, height: h, bottom: top + h, right: 400 };
      }
      const h = this.rowHeight || 40;
      return { top: 0, left: 0, width: 400, height: h, bottom: h, right: 400 };
    },
  };
  node.style = {};
  return node;
}

function intersects(scroll, itemsEl) {
  const padT = parseFloat(itemsEl.style.paddingTop) || 0;
  const rowsH = itemsEl.childNodes.reduce((h, c) => h + (c.rowHeight || 0), 0);
  const viewTop = scroll.scrollTop;
  const viewBot = viewTop + scroll.clientHeight;
  return rowsH > 0 && padT + rowsH > viewTop && padT < viewBot;
}

globalThis.window = globalThis;
globalThis.document = {
  documentElement: { style: {} },
  getElementById() { return null; },
  createElement: (tag) => el(String(tag).toUpperCase()),
  addEventListener() {},
  removeEventListener() {},
  fullscreenElement: null,
};
globalThis.getComputedStyle = () => ({ zoom: "" });
window.getComputedStyle = globalThis.getComputedStyle;
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.document = document;
globalThis.requestAnimationFrame = (fn) => {
  const id = setTimeout(() => fn(Date.now()), 0);
  id.unref?.();
  return id;
};
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const VirtualScroller = createRequire(import.meta.url)("../app/vendor/virtual-scroller.js");

function mount(count) {
  const scroll = el("SCROLL");
  const itemsEl = el("ITEMS");
  scroll.itemsEl = itemsEl;
  itemsEl.scrollParent = scroll;
  const items = Array.from({ length: count }, (_, i) => ({ key: "m" + i }));
  const vs = new VirtualScroller(itemsEl, items, () => el("ROW"), {
    getScrollableContainer: () => scroll,
    getItemId: (item) => item.key,
    getEstimatedItemHeight: () => 40,
  });
  return { scroll, itemsEl, items, vs };
}

test("opening at the top stays on the first rows", () => {
  const { scroll, itemsEl, vs } = mount(80);
  const st = vs.virtualScroller.getState();
  assert.equal(st.firstShownItemIndex, 0);
  assert.equal(scroll.scrollTop, 0);
  assert.equal(intersects(scroll, itemsEl), true);
  vs.stop();
});

test("a viewport past the last measured row shows the tail", () => {
  const { scroll, itemsEl, vs } = mount(80);
  for (let i = 0; i < 6; i++) {
    scroll.scrollTo(0, 1e9);
    vs.virtualScroller.updateLayout();
  }
  // Rebuild clamp: scrollTop sits where the rows end, so the viewport is
  // the padding under them. The next layout has to bring a row back.
  scroll.scrollTop = scroll.scrollHeight;
  vs.virtualScroller.updateLayout();
  const st = vs.virtualScroller.getState();
  assert.equal(st.lastShownItemIndex, 79);
  assert.equal(intersects(scroll, itemsEl), true, "tail row is inside the viewport");
  vs.stop();
});

test("appending at the bottom keeps a row on screen", () => {
  const { scroll, itemsEl, items, vs } = mount(80);
  for (let i = 0; i < 6; i++) {
    scroll.scrollTo(0, 1e9);
    vs.virtualScroller.updateLayout();
  }
  const more = items.concat([{ key: "m-new" }]);
  vs.setItems(more);
  scroll.scrollTo(0, 1e9);
  vs.virtualScroller.updateLayout();
  const st = vs.virtualScroller.getState();
  assert.equal(st.lastShownItemIndex, more.length - 1);
  assert.equal(intersects(scroll, itemsEl), true);
  vs.stop();
});
