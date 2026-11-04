// #277 pure black (AMOLED) dark theme and #278 stickers in the attach menu.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { readSettings, applySettings, SETTINGS } from "../app/js/settings-transfer.js";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const CA = read("app/js/chat-appearance.js");
const CSS = read("app/css/main.css");
const APP = read("app/js/app.js");
const UI = read("app/js/ui.js");
const VIEW = read("app/js/chat-view.js");

function pin({ theme, amoled, light = false }) {
  const store = new Map(Object.entries({ "dw-theme": theme, ...(amoled ? { "velta-amoled": "1" } : {}) }));
  const attrs = new Set();
  const meta = { content: "" };
  const doc = {
    documentElement: { dataset: {}, setAttribute: k => attrs.add(k), style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} } },
    querySelector: s => (s.includes("theme-color") ? meta : null), getElementById: () => null, createElement: () => ({}), head: { appendChild() {} },
  };
  const ctx = { localStorage: { getItem: k => store.get(k) ?? null, setItem() {}, removeItem() {} }, document: doc, matchMedia: () => ({ matches: light }) };
  ctx.globalThis = ctx;
  vm.runInNewContext(CA, ctx);
  doc.documentElement.dataset = {}; attrs.clear();
  ctx.VeltaChatAppearance.pinTheme(doc);
  return { amoled: attrs.has("data-amoled"), meta: meta.content, theme: doc.documentElement.dataset.theme };
}

test("pre-paint pin: AMOLED only on an effective dark theme", () => {
  assert.deepEqual(pin({ theme: "dark", amoled: true }), { amoled: true, meta: "#000000", theme: "dark" });
  assert.equal(pin({ theme: "auto", amoled: true }).amoled, true);
  assert.equal(pin({ theme: "auto", amoled: true, light: true }).amoled, false);
  assert.equal(pin({ theme: "light", amoled: true }).amoled, false);
  assert.equal(pin({ theme: "brutal", amoled: true }).amoled, false);
  assert.equal(pin({ theme: "dark", amoled: false }).amoled, false);
});

test("AMOLED CSS: #000 grounds, dark theme only, elevated surfaces untouched", () => {
  const blocks = [...CSS.matchAll(/([^{}]*\[data-amoled\][^{}]*)\{([^}]*)\}/g)];
  assert.ok(blocks.length >= 1);
  for (const [, sel, body] of blocks) {
    assert.match(sel, /html\[data-theme="dark"\]\[data-amoled\]/, sel);
    assert.doesNotMatch(body, /--bg-sidebar|--bg-bubble/, "elevated surfaces keep their greys");
  }
  assert.match(CSS, /\[data-amoled\] \{ --bg: #000000; --bg-chat: #000000; \}/);
});

test("app.js applyTheme toggles data-amoled for dark only and the drawer switch follows the theme", () => {
  assert.match(APP, /const amoled = effective === "dark" && localStorage\.getItem\("velta-amoled"\) === "1"/);
  assert.match(APP, /toggleAttribute\("data-amoled", amoled\)/);
  assert.match(UI, /data-amoled-opt/);
  assert.match(UI, /amoledOpt\.hidden = document\.documentElement\.dataset\.theme !== "dark"/);
});

test("settings export/apply covers both switches", () => {
  const keys = SETTINGS.map(s => s.key);
  assert.ok(keys.includes("amoled") && keys.includes("stickers-in-attach"));
  const m = new Map([["velta-amoled", "1"], ["velta-stickers-in-attach", "1"]]);
  const ls = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  const v = readSettings(ls);
  assert.equal(v.amoled, "on");
  assert.equal(v["stickers-in-attach"], "on");
  applySettings(ls, { amoled: "off", "stickers-in-attach": "off" });
  assert.equal(m.has("velta-amoled"), false);
  assert.equal(m.has("velta-stickers-in-attach"), false);
});

test("stickers in attach: composer button hidden, Attach → Stickers opens the same picker", () => {
  assert.match(VIEW, /b\.hidden = !!chat\?\.isP2pGroup \|\| stickersInAttach\(\)/);
  assert.match(VIEW, /if \(stickersInAttach\(\) && !this\.chat\?\.isP2pGroup\) \{\s*attachItems\.push\(\{ label: "Stickers", icon: ICO\.sticker, onClick: \(\) => this\._toggleStickerPicker\(\) \}\)/);
  // #264: the picker's send keeps the active reply.
  assert.match(VIEW, /viewtype: "sticker", file: path, \.\.\.this\._quoteFields\(\)/);
  assert.match(VIEW, /addEventListener\("velta-stickers-pref", \(\) => this\._applyGroupComposer\(this\.chat\)\)/);
  assert.doesNotMatch(VIEW, /label: "Article"/);
});
