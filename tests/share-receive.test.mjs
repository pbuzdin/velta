import test from "node:test";
import assert from "node:assert/strict";
// #97 share-in: ChatView.receiveShare against the same stub DOM as
// chat-account-isolation.test.mjs (only the surface ChatView touches).
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
  after(child) { const p = this.parent; if (!p) return child; p.children.splice(p.children.indexOf(this) + 1, 0, child); child.parent = p; return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  scrollTo({ top }) { this.scrollTop = top; }
}

globalThis.HTMLElement = Element;
const elements = new Map();
globalThis.customElements = { get: name => elements.get(name), define: (name, el) => elements.set(name, el) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.history = { state: null, pushState() {}, back() {}, replaceState() {} };
globalThis.innerHeight = 800;
globalThis.innerWidth = 1200;
const { ChatView, voiceFileExt } = await import("../app/js/chat-view.js");
const { closeAllPopups, confirmModal, confirmDeleteMessagesModal, showModal } = await import("../app/js/ui.js");


const message = (id, chatId = 7) => ({ id, chatId, from: 1, text: `message ${id}`, ts: 1700000000000, viewtype: "text", fromContact: { name: "Me" } });
const page = (...messages) => ({ messages, hasMore: true });

// #97: what the chosen chat does with a share (ChatView.receiveShare).
function shell(view, files = {}) {
  const calls = [];
  window.__TAURI__ = { core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "resolve_content_uri") return files[args.uri];
    if (cmd === "resolve_upload_path") return `/acc/uploads/${args.filename}`;
    if (cmd === "plugin:fs|read_file") return [1, 2, 3];
    return null;
  } } };
  return calls;
}

async function opened(t) {
  const s = setup(t);
  const sent = [];
  s.core.sendMessage = async (chatId, data) => { sent.push({ chatId, ...data }); return { id: 100 + sent.length, chatId }; };
  s.view.appendOutgoing = () => {};
  assert.equal(await s.view.open(7), true);
  return { ...s, sent };
}

test("shared text lands in the composer, not sent", async t => {
  const { view, node, sent } = await opened(t);
  shell(view);
  node("composer-input").value = "";
  assert.equal(await view.receiveShare({ text: "https://example.com/a", files: [] }), "staged");
  assert.equal(node("composer-input").value, "https://example.com/a");
  assert.equal(sent.length, 0);
  // an existing draft is kept
  assert.equal(await view.receiveShare({ text: "more", files: [] }), "staged");
  assert.equal(node("composer-input").value, "https://example.com/a\nmore");
});

test("one shared photo goes to the attachment strip with the text as caption", async t => {
  const { view, node, sent } = await opened(t);
  const calls = shell(view, { "content://media/1": "/acc/uploads/IMG_1.jpg" });
  node("composer-input").value = "";
  assert.equal(await view.receiveShare({ text: "look", files: ["content://media/1"] }), "staged");
  assert.equal(view.pendingMedia?.kind, "image");
  assert.equal(view.pendingMedia?.corePath, "/acc/uploads/IMG_1.jpg");
  assert.equal(view.pendingMedia?.name, "IMG_1.jpg");
  assert.equal(node("composer-input").value, "look");
  assert.equal(sent.length, 0);
  assert.deepEqual(calls[0], ["resolve_content_uri", { uri: "content://media/1", filename: calls[0][1].filename }]);
});

test("a shared document is sent with the text as caption; several files go one by one", async t => {
  const { view, sent, changed } = await opened(t);
  shell(view, { "content://d/1": "/acc/uploads/report.pdf", "content://d/2": "/acc/uploads/a.jpg", "content://d/3": "/acc/uploads/b.mp4" });
  assert.equal(await view.receiveShare({ text: "fyi", files: ["content://d/1"] }), "sent");
  assert.deepEqual(sent, [{ chatId: 7, text: "fyi", viewtype: "file", file: "/acc/uploads/report.pdf", filename: "report.pdf" }]);
  sent.length = 0;
  assert.equal(await view.receiveShare({ text: "trip", files: ["content://d/2", "content://d/3"] }), "sent");
  assert.deepEqual(sent.map(m => [m.text, m.viewtype, m.filename]), [["trip", undefined, undefined], ["", "image", "a.jpg"], ["", "video", "b.mp4"]]);
  assert.ok(changed() >= 1);
});

test("a Windows Send to path is allowed and copied before it is staged", async t => {
  const { view } = await opened(t);
  const calls = shell(view);
  assert.equal(await view.receiveShare({ text: "", files: ["C:\\Users\\p\\Pictures\\cat.png"] }), "staged");
  assert.deepEqual(calls.map(c => c[0]).slice(0, 2), ["allow_picked_path", "resolve_upload_path"]);
  assert.equal(view.pendingMedia?.kind, "image");
  assert.match(view.pendingMedia.corePath, /^\/acc\/uploads\/\d+-cat\.png$/);
});

test("a profile switch while the file is copied drops the share", async t => {
  const { view, sent, switchTo } = await opened(t);
  window.__TAURI__ = { core: { invoke: async cmd => {
    if (cmd === "resolve_content_uri") { switchTo("B"); return "/acc/uploads/x.pdf"; }
    return null;
  } } };
  assert.equal(await view.receiveShare({ text: "", files: ["content://x"] }), null);
  assert.equal(sent.length, 0);
});

test("a read-only chat refuses the share", async t => {
  const { view } = await opened(t);
  shell(view);
  view.readOnly = true;
  await assert.rejects(view.receiveShare({ text: "hi", files: [] }), /can't write/);
});
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

