import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ui.js pulls the component module graph, which extends HTMLElement.
class Element {}
globalThis.HTMLElement ??= Element;
globalThis.customElements ??= { get() {}, define() {} };
globalThis.document ??= { getElementById() { return null; }, createElement: () => new Element(), addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { wireDisclosure } = await import("../app/js/ui.js");
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// Minimal <details>: `open` fires an async "toggle" like the platform does.
function fakeDetails() {
  const summary = { focused: 0, focus() { this.focused++; } };
  const inside = { name: "inside" };
  const d = new EventTarget();
  let open = false;
  Object.defineProperty(d, "open", {
    get: () => open,
    set: (v) => { if (open === !!v) return; open = !!v; queueMicrotask(() => d.dispatchEvent(new Event("toggle"))); },
  });
  d.contains = (n) => n === d || n === summary || n === inside;
  d.querySelector = (sel) => (sel === "summary" ? summary : null);
  return { d, summary, inside };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ev = (type, props) => ({ type, stopPropagation() {}, ...props });
// Document stand-in: plain event objects (a DOM Event's target is read-only).
function fakeDoc() {
  const map = new Map();
  return {
    addEventListener(t, f) { if (!map.has(t)) map.set(t, new Set()); map.get(t).add(f); },
    removeEventListener(t, f) { map.get(t)?.delete(f); },
    dispatchEvent(e) { for (const f of [...(map.get(e.type) || [])]) f(e); },
  };
}

test("the opening tap cannot close it: dismiss listeners attach only after toggle", async () => {
  const doc = fakeDoc();
  const { d, summary } = fakeDetails();
  wireDisclosure(d, { doc });
  // The tap that opens the menu: its pointerdown precedes the open.
  doc.dispatchEvent(ev("pointerdown", { target: summary }));
  d.open = true;
  await tick();
  assert.equal(d.open, true);
});

test("outside pointerdown closes, inside does not", async () => {
  const doc = fakeDoc();
  const { d, inside } = fakeDetails();
  wireDisclosure(d, { doc });
  d.open = true; await tick();
  doc.dispatchEvent(ev("pointerdown", { target: inside }));
  assert.equal(d.open, true);
  doc.dispatchEvent(ev("pointerdown", { target: { name: "chat list" } }));
  assert.equal(d.open, false);
});

test("Escape closes and returns focus to the summary; other keys don't", async () => {
  const doc = fakeDoc();
  const { d, summary } = fakeDetails();
  wireDisclosure(d, { doc });
  d.open = true; await tick();
  doc.dispatchEvent(ev("keydown", { key: "Tab" }));
  assert.equal(d.open, true);
  doc.dispatchEvent(ev("keydown", { key: "Escape" }));
  assert.equal(d.open, false);
  assert.equal(summary.focused, 1);
});

test("closed or unwired: no document listeners left behind", async () => {
  const doc = fakeDoc();
  const added = []; const removed = [];
  const add = doc.addEventListener.bind(doc), rem = doc.removeEventListener.bind(doc);
  doc.addEventListener = (t, f, o) => { added.push(t); add(t, f, o); };
  doc.removeEventListener = (t, f, o) => { removed.push(t); rem(t, f, o); };
  const { d } = fakeDetails();
  const unwire = wireDisclosure(d, { doc });
  assert.deepEqual(added, [], "nothing on the document while closed");
  d.open = true; await tick();
  assert.deepEqual(added.sort(), ["keydown", "pointerdown"]);
  d.open = false; await tick();
  // closed: an outside tap is a no-op (would have thrown nothing anyway)
  doc.dispatchEvent(ev("pointerdown", { target: {} }));
  d.open = true; await tick();
  unwire(); // drawer rebuilt while open
  doc.dispatchEvent(ev("pointerdown", { target: {} }));
  assert.equal(d.open, true, "unwired disclosure ignores document taps");
  assert.ok(removed.filter((t) => t === "pointerdown").length >= 2);
});

test("drawer markup: native details/summary, no popover or hidden toggle", () => {
  const ui = read("app/js/ui.js");
  const app = read("app/js/app.js");
  const css = read("app/css/main.css");
  assert.match(ui, /<details class="acct-switch" data-acct-switch>/);
  // #148: always rendered (also with a single profile — the popover is now
  // Profile management's door) and labeled "Accounts".
  assert.match(ui, /<summary data-act="switch-account">Accounts(<|\$\{ICON\.chevronDown\})/);
  assert.doesNotMatch(ui, /accounts\.length \? `<details class="acct-switch"/);
  // Profile management has two doors (#148): the row inside the switcher
  // popover and the standalone mid-drawer item — both open the same modal.
  assert.match(ui, /class="acct-pop" role="group" aria-label="Accounts"[\s\S]*?data-act="profile-management"/);
  assert.equal((ui.match(/data-act="profile-management"/g) || []).length, 2);
  assert.match(ui, /aria-current="true"/);
  assert.doesNotMatch(ui, /popovertarget", "acct-pop"|acctPop/);
  assert.match(ui, /wireDisclosure\(acctSwitch\)/);
  assert.match(ui, /if \(acctSwitch\) acctSwitch\.open = false;/); // drawer close (and a pick) closes it
  assert.match(ui, /if \(act === "switch-account"\) return;/);
  // rebuildDrawer unhooks the old drawer and keeps the drawer + switcher open
  assert.match(app, /drawer\?\.destroy\?\.\(\);\s*drawer\?\.el\.remove\(\);/);
  assert.match(app, /if \(switcherWasOpen && drawer\.acctSwitch\) drawer\.acctSwitch\.open = true;/);
  assert.doesNotMatch(css, /\.acct-pop\[popover\]|\.acct-pop\[hidden\]/);
  assert.match(css, /\.acct-switch > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(css, /\.acct-switch > summary \{ list-style: none;/);
});
