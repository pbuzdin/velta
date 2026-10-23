import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";

// Regression (missing 'Velta dev diary' avatar): an in-place re-render of a
// <velta-chat-item> diffs its bare nested <velta-avatar> and strips the tile;
// the avatar stayed connected but empty (zero width). The avatar now heals
// itself when emptied, the CSS reserves the slot, and a failed image falls
// back to initials on every later render.
installChatViewGlobals();
installFakeDocument();
await import("../app/js/components.js");

const channel = { id: 9, name: "Velta dev diary", kind: "channel", color: "#3a7", lastMsg: "post", ts: Date.now() };

test("channel row embeds an avatar element, with or without an image", () => {
  const Item = customElements.get("velta-chat-item");
  for (const avatar of [undefined, "/blob/broken.png"]) {
    const item = new Item();
    item.chat = { ...channel, avatar };
    const out = item.render().values.map(String).join("");
    assert.match(out, /<velta-avatar[^>]*size="48"/);
  }
});

function avatar(attrs) {
  const A = customElements.get("velta-avatar");
  const a = new A();
  Object.assign(a, { name: "Velta dev diary", color: "#3a7", kind: "channel", size: 48 }, attrs);
  return a;
}

test("missing image renders the initials tile", () => {
  const out = JSON.stringify(avatar({ avatar: "" }).render());
  assert.match(out, /velta-avatar-tile/);
  assert.match(out, /VD|V/);
  assert.doesNotMatch(out, /<img/);
});

test("failed image falls back to initials, also on later re-renders", () => {
  const a = avatar({ avatar: "/blob/broken.png" });
  assert.match(JSON.stringify(a.render()), /<img/);
  let onError;
  const img = { dataset: {}, complete: false, naturalWidth: 0, addEventListener: (t, f) => { if (t === "error") onError = f; } };
  a.querySelector = () => img;
  a.requestUpdate = () => {};
  a._bindImg();
  assert.ok(onError, "error handler bound");
  onError();
  for (let i = 0; i < 3; i++) {
    const out = JSON.stringify(a.render());
    assert.match(out, /velta-avatar-tile/);
    assert.doesNotMatch(out, /<img/);
  }
});

test("avatar emptied by a parent diff while connected re-renders itself", () => {
  const a = avatar({ avatar: "" });
  let rerenders = 0;
  Object.defineProperty(a, "isConnected", { value: true });
  Object.defineProperty(a, "childElementCount", { get: () => 0 });
  a.h = true; a.D = "old"; a.F = "old";
  a.N = () => { rerenders++; assert.equal(a.D, undefined); };
  a.querySelector = () => null;
  a._heal();
  assert.equal(rerenders, 1);
  const src = readFileSync(new URL("../app/js/components.js", import.meta.url), "utf8");
  assert.match(src, /new MutationObserver\(\(\) => this\._heal\(\)\)/);
  assert.match(src, /observe\(this, \{ childList: true \}\)/);
});

test("CSS reserves a fixed, non-shrinking avatar slot", () => {
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /velta-avatar \{[^}]*flex-shrink: 0/);
  assert.match(css, /velta-avatar\[size="48"\] \{ width: 48px; height: 48px; min-width: 48px; \}/);
});

test("initials cover non-Latin names: Cyrillic does not fall to the ? tile", () => {
  assert.match(JSON.stringify(avatar({ name: "Привет мир" }).render()), /ПМ/);
  assert.match(JSON.stringify(avatar({ name: "Велта" }).render()), /В/);
  // Latin behavior unchanged; emoji-only still degrades to "?" (no letters).
  assert.match(JSON.stringify(avatar({ name: "Ada Byron" }).render()), /AB/);
  assert.match(JSON.stringify(avatar({ name: "🚀" }).render()), /\?/);
  const src = readFileSync(new URL("../app/js/components.js", import.meta.url), "utf8");
  assert.ok(src.includes("/[\\p{L}\\p{N}]/u"), "Unicode-letter initials filter");
});
