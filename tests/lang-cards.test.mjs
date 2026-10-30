import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const lc = await import("../app/js/lang-cards.js");
const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const src = f => readFileSync(new URL(`../app/js/${f}`, import.meta.url), "utf8");

test("card only for a shipped non-en OS language that differs from the UI", () => {
  assert.equal(lc.pendingLangCard({ languages: ["ru-RU", "en"], ui: "en", done: false }), "ru");
  assert.equal(lc.pendingLangCard({ languages: ["fr-CA"], ui: "ru", done: false }), "fr");
  assert.equal(lc.pendingLangCard({ languages: ["ru"], ui: "ru", done: false }), null);
  assert.equal(lc.pendingLangCard({ languages: ["de-DE", "ru"], ui: "en", done: false }), null);
  assert.equal(lc.pendingLangCard({ languages: ["en-US"], ui: "fr", done: false }), null);
  assert.equal(lc.pendingLangCard({ languages: ["ru"], ui: "en", done: true }), null);
});

test("done flag: set by tap or switch, then nothing is added", async () => {
  store.clear();
  const calls = [];
  const core = { addDeviceMessage: async (l, t) => { calls.push([l, t]); return 1; } };
  await lc.maybeAddLangCard(core, { languages: ["fr-FR"], ui: "en" });
  assert.deepEqual(calls, [["velta-lang-fr", "Velta est disponible en français 🇫🇷\n\nvelta://lang/fr"]]);
  lc.markLangCardDone();
  assert.equal(lc.langCardDone(), true);
  await lc.maybeAddLangCard(core, { languages: ["fr-FR"], ui: "en" });
  assert.equal(calls.length, 1);
  assert.equal(lc.langCardText("ru").startsWith("Velta поддерживает русский язык 🇷🇺"), true);
});

test("untrusted messages never get a card; only shipped languages", () => {
  const text = lc.langCardText("ru");
  assert.equal(lc.langCardCode(text, { trusted: false }), null);
  assert.equal(lc.langCardCode(text, { trusted: true }), "ru");
  assert.equal(lc.langCardCode("hi\n\nvelta://lang/de", { trusted: true }), null);
  assert.equal(lc.langCardCode("hi\n\nvelta://lang/en", { trusted: true }), null);
  assert.equal(lc.langCardCode("xvelta://lang/ru", { trusted: true }), null);
  assert.equal(lc.stripLangLink(text), "Velta поддерживает русский язык 🇷🇺");
});

test("button switches, or shows current when already on", () => {
  assert.match(lc.langCardHtml("fr", { ui: "en", esc }), /data-lang-card="fr"[^>]*>Passer au français</);
  const on = lc.langCardHtml("fr", { ui: "fr", esc });
  assert.doesNotMatch(on, /data-lang-card/);
  assert.match(on, /disabled[^>]*aria-current="true">Le français est déjà activé</);
});

test("theme-following styles: design-system primary button, no dark .ivc panel", async () => {
  const { readFile } = await import("node:fs/promises");
  const off = lc.langCardHtml("ru", { ui: "en", esc });
  assert.match(off, /class="btn-text btn-primary lang-card-btn"/);
  assert.doesNotMatch(off + lc.langCardHtml("ru", { ui: "ru", esc }), /\bivc/);
  const css = await readFile(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /\.lang-card \{[^}]*background: var\(--bg-reply\)[^}]*border: 1px solid var\(--border\)[^}]*border-radius: 10px/);
  assert.match(css, /\.lang-card-btn\.btn-primary:not\(\[disabled\]\) \{ color: var\(--on-accent\); background: var\(--accent\)/);
  assert.match(css, /\.lang-card \.lang-card-on \{[^}]*color: var\(--text\)/);
});

test("wiring: device chat + device sender gate, reload switch, core label", () => {
  const cv = src("chat-view.js");
  assert.match(cv, /langCardCode\(m\.text, \{ trusted: this\.chat\?\.kind === "device" && m\.fromDevice === true \}\)/);
  assert.match(cv, /langBtn && this\.chat\?\.kind === "device" && m\.fromDevice === true/);
  assert.match(src("rpc-core.js"), /fromDevice: m\.fromId === 5/);
  assert.match(src("rpc-core.js"), /"add_device_message", this\.accountId, label, \{ text \}/);
  assert.match(src("ui.js"), /setLang\(v\);\s*markLangCardDone\(\)/);
  // OS deeplink handler must not route velta://lang
  assert.doesNotMatch(src("app.js"), /hostname !== "lang"|hostname === "lang"/);
});
