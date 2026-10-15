// Shared stub DOM for the ChatView/ui.js tests that run without a browser.
// Only the surface ChatView's lifecycle and the real modal helpers touch.
// It is the union of the fakes the tests used to copy; layout-heavy tests
// (scroll-restore) keep their own fixed-geometry element.

export class FakeElement {
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
  insertBefore(child, before) {
    child.remove();
    const i = before ? this.children.indexOf(before) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    child.parent = this;
    return child;
  }
  after(child) { const p = this.parent; if (!p) return child; p.children.splice(p.children.indexOf(this) + 1, 0, child); child.parent = p; return child; }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  fire(name, event = {}) { return Promise.all([...this.listeners.get(name) || []].map(fn => fn({ type: name, target: this, currentTarget: this, ...event }))); }
  // ".class", "tag" and [data-msgid="…"] — the selectors ChatView uses on rows.
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
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  scrollTo({ top }) { this.scrollTop = top; }
}

// Globals ChatView/ui.js read at import time. Call BEFORE importing them.
// Node 20 has no global navigator (21+) or localStorage (22+).
export function installChatViewGlobals() {
  if (typeof globalThis.navigator === "undefined") globalThis.navigator = {};
  if (typeof globalThis.localStorage === "undefined") {
    const m = new Map();
    globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
  }
  globalThis.HTMLElement = FakeElement;
  const elements = new Map();
  globalThis.customElements = { get: name => elements.get(name), define: (name, el) => elements.set(name, el) };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.history = { state: null, pushState() {}, back() {}, replaceState() {} };
  globalThis.innerHeight = 800;
  globalThis.innerWidth = 1200;
}

// Fresh document whose getElementById/querySelector hand out one stable
// element per id; returns that lookup as `node`.
export function installFakeDocument() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new FakeElement());
    return nodes.get(id);
  };
  globalThis.document = {
    getElementById: node,
    querySelector: node,
    createElement: tag => new FakeElement(tag),
    body: new FakeElement("body"),
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
  };
  return node;
}

// Manual requestAnimationFrame queue: frames maps id -> callback.
export function installFakeFrames() {
  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  return frames;
}
