import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #135: recent "/" bot commands popup above #main-composer.
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const { commandFromText, recordCommand, recentCommands, attachRecentCommands, KEY } = await import("../app/js/recent-commands.js");

test("commandFromText: first line, trimmed, max 64, must start with /", () => {
  assert.equal(commandFromText("  /start foo  \nsecond"), "/start foo");
  assert.equal(commandFromText("hello /x"), null);
  assert.equal(commandFromText("/"), null);
  assert.equal(commandFromText("/ x"), null);
  assert.equal(commandFromText("/" + "a".repeat(100)).length, 64);
});

test("history: distinct, most recent first, capped at 10, per account", () => {
  mem.clear();
  for (let i = 0; i < 12; i++) recordCommand(1, 5, "/c" + i);
  recordCommand(1, 5, "/c3");
  const l = recentCommands(1, 5);
  assert.equal(l.length, 10);
  assert.equal(l[0], "/c3");
  assert.equal(l.filter(c => c === "/c3").length, 1);
  assert.deepEqual(recentCommands(2, 5), []);
  assert.equal(recordCommand(1, 5, "plain text"), null);
});

test("per-chat with fallback to account-global; prefix filter case-insensitive", () => {
  mem.clear();
  recordCommand(1, 5, "/help");
  recordCommand(1, 6, "/start foo");
  assert.deepEqual(recentCommands(1, 5), ["/help"]);
  assert.deepEqual(recentCommands(1, 7), ["/start foo", "/help"]); // fallback
  assert.deepEqual(recentCommands(1, 7, "/ST"), ["/start foo"]);
});

test("corrupt storage degrades to empty", () => {
  mem.set(KEY, "{nope");
  assert.deepEqual(recentCommands(1, 1), []);
  recordCommand(1, 1, "/ok");
  assert.deepEqual(recentCommands(1, 1), ["/ok"]);
});

// --- tiny fake DOM for the popup controller ---
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {}, add() {} }; this.parent = null; }
  set textContent(v) { this._t = v; if (v === "") this.children = []; }
  get textContent() { return this._t; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatchEvent(e) { (this.listeners[e.type] || []).forEach(f => f(e)); }
  closest() { return this.attrs.role === "option" ? this : null; }
  focus() {}
}
globalThis.Event = class { constructor(type) { this.type = type; } };
function setup() {
  mem.clear();
  recordCommand(1, 5, "/help"); recordCommand(1, 5, "/start foo"); recordCommand(1, 5, "/stop");
  const doc = { createElement: t => new El(t) };
  const input = new El("textarea"); input.ownerDocument = doc; input.value = "";
  const anchor = new El("footer");
  const rc = attachRecentCommands(input, anchor, () => ({ accountId: 1, chatId: 5 }));
  const type = v => { input.value = v; input.dispatchEvent(new Event("input")); };
  const key = k => { let prevented = false; const used = rc.handleKey({ key: k, preventDefault: () => { prevented = true; } }); return used && prevented; };
  return { input, anchor, rc, type, key, pop: () => anchor.children[0] };
}

test("popup opens on /, filters, listbox roles, hides when not /", () => {
  const { anchor, rc, type, pop, input } = setup();
  type("hi"); assert.equal(rc.isOpen(), false);
  type("/");
  assert.equal(rc.isOpen(), true);
  assert.equal(pop().getAttribute("role"), "listbox");
  assert.deepEqual(pop().children.map(c => c.textContent), ["/stop", "/start foo", "/help"]);
  assert.ok(pop().children.every(c => c.getAttribute("role") === "option"));
  assert.equal(input.getAttribute("aria-expanded"), "true");
  type("/st"); assert.equal(pop().children.length, 2);
  type("x/"); assert.equal(rc.isOpen(), false); assert.equal(anchor.children.length, 0);
});

test("keyboard: arrows set aria-activedescendant, Enter inserts (no send), Escape/blur hide", () => {
  const { input, rc, type, key } = setup();
  type("/");
  assert.equal(key("Enter"), false, "Enter with no active option falls through to send");
  assert.equal(key("ArrowDown"), true);
  assert.equal(input.getAttribute("aria-activedescendant"), "recent-cmd-opt-0");
  key("ArrowDown"); key("ArrowUp"); key("ArrowUp");
  assert.equal(input.getAttribute("aria-activedescendant"), "recent-cmd-opt-2");
  assert.equal(key("Enter"), true);
  assert.equal(input.value, "/help ");
  assert.equal(rc.isOpen(), false);
  type("/"); key("Escape"); assert.equal(rc.isOpen(), false);
  type("/"); key("Tab"); assert.equal(input.value, "/stop ");
  type("/"); input.dispatchEvent(new Event("blur")); assert.equal(rc.isOpen(), false);
});

test("click on option inserts it", () => {
  const { input, type, pop } = setup();
  type("/");
  const li = pop().children[1];
  pop().dispatchEvent({ type: "click", target: li });
  assert.equal(input.value, "/start foo ");
});

test("chat-view wiring: records on send, hides, keydown consults popup first", () => {
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(src, /import \{ attachRecentCommands, recordCommand \} from "\.\/recent-commands\.js"/);
  assert.match(src, /if \(this\._recentCmds\.handleKey\(e\)\) return;\s*\/\/ Send on Enter/);
  assert.match(src, /this\._recentCmds\?\.hide\(\);\s*(this\._mentions\?\.hide\(\);\s*)?if \(!this\.editingMsg\) recordCommand\(/);
});
