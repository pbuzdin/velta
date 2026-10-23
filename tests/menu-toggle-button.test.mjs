import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// Minimal DOM for bindMenuToggle: a button, a popups root and a MutationObserver
// that fires synchronously on child removal.
function setup() {
  const observers = [];
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() { observers.push(this); } disconnect() { this.off = true; } };
  const root = { children: [], append(m) { this.children.push(m); m.parentNode = this; },
    removeChild(m) { this.children = this.children.filter(x => x !== m); m.parentNode = null; for (const o of observers) if (!o.off) o.cb(); } };
  const mkMenu = () => { const m = { parentNode: null, listeners: {}, get isConnected() { return !!this.parentNode; },
    addEventListener(t, f) { this.listeners[t] = f; }, remove() { this.parentNode?.removeChild(this); } }; root.append(m); return m; };
  const btn = { attrs: { "aria-label": "Attach", title: "Attach" }, innerHTML: "<svg>clip</svg>", listeners: {},
    classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
    set title(v) { this.attrs.title = v; }, get title() { return this.attrs.title; },
    addEventListener(t, f) { this.listeners[t] = f; },
    tap() { this.listeners.pointerdown?.(); this.listeners.click?.({ currentTarget: this }); } };
  return { root, mkMenu, btn };
}

test("bindMenuToggle logic (extracted) restores on any close", () => {
  const ui = src("app/js/ui.js");
  const start = ui.indexOf("export const MENU_CLOSE_SVG");
  const end = ui.indexOf("export function showContextMenu");
  const code = ui.slice(start, end).replace(/export /g, "");
  let closed = 0;
  const { root, mkMenu, btn } = setup();
  let menu = null;
  const closeAllPopups = () => { closed++; menu?.remove(); };
  const { bindMenuToggle, MENU_CLOSE_SVG } = new Function("closeAllPopups", code + "; return { bindMenuToggle, MENU_CLOSE_SVG };")(closeAllPopups);
  const ctl = bindMenuToggle(btn, () => (menu = mkMenu()));
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  btn.tap();
  assert.equal(ctl.isOpen(), true);
  assert.equal(btn.innerHTML, MENU_CLOSE_SVG);
  assert.equal(btn.getAttribute("aria-label"), "Close menu");
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  btn.tap(); // second tap closes
  assert.equal(closed, 1);
  assert.equal(ctl.isOpen(), false);
  assert.equal(btn.innerHTML, "<svg>clip</svg>");
  assert.equal(btn.getAttribute("aria-label"), "Attach");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  btn.tap(); // opens again
  assert.equal(ctl.isOpen(), true);
  menu.remove(); // outside tap / Esc / pick / Back: the menu leaves the DOM
  assert.equal(ctl.isOpen(), false);
  assert.equal(btn.innerHTML, "<svg>clip</svg>");
  // light-dismiss already removed it on this very tap: must not reopen
  btn.tap(); assert.equal(ctl.isOpen(), true);
  btn.listeners.pointerdown(); menu.listeners.toggle({ newState: "closed" }); menu.remove();
  btn.listeners.click({ currentTarget: btn });
  assert.equal(ctl.isOpen(), false);
  assert.equal(root.children.length, 0);
});

test("wired to #btn-attach and #btn-chat-menu; Velta Beam has its own icon", () => {
  const cv = src("app/js/chat-view.js");
  assert.match(cv, /bindMenuToggle\(document\.getElementById\("btn-attach"\), e => \{/);
  assert.match(cv, /label: "Velta Beam", icon: ICO\.beam/);
  assert.match(cv, /beam: `<svg viewBox="0 0 24 24"><path fill="currentColor"/);
  const app = src("app/js/app.js");
  assert.match(app, /bindMenuToggle\(\$\("btn-chat-menu"\), e => \{/);
  assert.match(app, /return showContextMenu\(\[\n\s+\{ label: "Chat info"/);
  assert.match(src("app/css/main.css"), /\.icon-btn\.menu-open svg \{ animation: menu-x-in/);
});
