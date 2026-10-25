// UI language (#129): English in the source is the key. fr.json and ru.json
// translate it; a missing value stays English.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { applySettings, parseSettings, readSettings, serializeSettings, HEADER } from "../app/js/settings-transfer.js";
import { DEVICE_CHAT_HINT, VELTA_WELCOME, UPDATE_REMINDER, ENJOYING_VELTA } from "../app/js/velta-strings.js";
import { MD_HINT, MD_REENABLED_NOTE, DL_LIMIT_HINT } from "../app/js/multidevice.js";
import fr from "../app/locales/fr.json" with { type: "json" };
import ru from "../app/locales/ru.json" with { type: "json" };

const mem = new Map();
globalThis.localStorage = {
  getItem: k => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
const { t, normalizeLang, setLang, currentLang, LANGS, LANG_KEY } = await import("../app/js/i18n.js");

function quoted(src, re) {
  const out = [];
  for (const m of src.matchAll(re)) out.push(JSON.parse('"' + m[1] + '"'));
  return out;
}
function requiredKeys() {
  const keys = new Set();
  const addT = (src) => { for (const k of quoted(src, /\bt\(\s*"((?:\\.|[^"\\])*)"/g)) keys.add(k); };
  const addAttr = (src) => {
    for (const m of src.matchAll(/data-i18n(?:-label|-placeholder|-aria)?="([^"]+)"/g)) {
      if (!m[1].includes("${")) keys.add(m[1]);
    }
  };
  for (const f of readdirSync(new URL("../app/js/", import.meta.url))) {
    if (f.endsWith(".js")) addT(readFileSync(new URL("../app/js/" + f, import.meta.url), "utf8"));
  }
  addAttr(readFileSync(new URL("../app/index.html", import.meta.url), "utf8"));
  addAttr(readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8"));
  const labelRe = /(?:label|search|empty|short):\s*"((?:\\.|[^"\\])*)"/g;
  for (const file of ["chat-view.js", "local-chat.js", "chat-media.js"]) {
    for (const k of quoted(readFileSync(new URL("../app/js/" + file, import.meta.url), "utf8"), labelRe)) keys.add(k);
  }
  for (const line of readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8").split("\n")) {
    if (line.includes("backend")) continue;
    for (const k of quoted(line, /label:\s*"((?:\\.|[^"\\])*)"/g)) keys.add(k);
  }
  const st = readFileSync(new URL("../app/js/settings-transfer.js", import.meta.url), "utf8");
  for (const k of quoted(st, /(?:oneOf|onByDefault|offByDefault|visibleList)\(\s*"[^"]+",\s*"((?:\\.|[^"\\])*)"/g)) keys.add(k);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  const themes = ui.slice(ui.indexOf("THEME_LABELS"), ui.indexOf("export const UI_SCALES"));
  for (const m of themes.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  for (const m of ui.matchAll(/\["[^"]+", "([^"]+)"\]/g)) keys.add(m[1]);
  for (const s of [
    "Add member", "Add member (group is full)", "Disband group", "Leave group",
    DEVICE_CHAT_HINT, VELTA_WELCOME, UPDATE_REMINDER, ENJOYING_VELTA,
    MD_HINT, MD_REENABLED_NOTE, DL_LIMIT_HINT,
    readFileSync(new URL("../app/js/link-preview.js", import.meta.url), "utf8").match(/LINK_PREVIEW_IP_WARNING =\n  "([^"]+)"/)[1],
  ]) keys.add(s);
  return keys;
}

test("normalizeLang accepts tags and rejects junk", () => {
  assert.equal(normalizeLang("fr"), "fr");
  assert.equal(normalizeLang("FR-ca"), "fr");
  assert.equal(normalizeLang("french"), "fr");
  assert.equal(normalizeLang("ru_RU"), "ru");
  assert.equal(normalizeLang("russian"), "ru");
  assert.equal(normalizeLang("en"), "en");
  assert.equal(normalizeLang("english"), "en");
  assert.equal(normalizeLang(""), "en");
  assert.equal(normalizeLang(null), "en");
  assert.equal(normalizeLang("from"), "en");
  assert.equal(normalizeLang("zz"), "en");
});

test("english is the source, blanks and unknown keys stay english", () => {
  setLang("en");
  assert.equal(currentLang(), "en");
  assert.equal(localStorage.getItem(LANG_KEY), null);
  assert.equal(t("Search chats"), "Search chats");
  assert.equal(t("not a real key"), "not a real key");
  assert.equal(t("Delete {n} messages?", { n: 4 }), "Delete 4 messages?");
  setLang("fr");
  assert.equal(t("Search chats"), fr["Search chats"]);
  assert.notEqual(t("Search chats"), "Search chats");
  assert.equal(t("not a real key"), "not a real key");
  assert.equal(t("Delete {n} messages?", { n: 3 }), fr["Delete {n} messages?"].replace("{n}", "3"));
  setLang("ru");
  assert.equal(t("Language"), ru["Language"]);
  assert.equal(t(VELTA_WELCOME).includes("Velta"), true);
  setLang("en");
});

test("picker names are the native names, not translated keys", () => {
  assert.deepEqual(LANGS, [["en", "English"], ["fr", "Français"], ["ru", "Русский"]]);
  assert.equal(fr["English"], undefined);
  assert.equal(ru["Français"], undefined);
});

test("french and russian cover the same wired strings", () => {
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(ru).sort());
  const missing = [];
  for (const k of requiredKeys()) {
    if (!fr[k] || !ru[k]) missing.push(k);
  }
  assert.deepEqual(missing, []);
  assert.equal((VELTA_WELCOME.match(/^• /gm) || []).length, 7);
  assert.equal((fr[VELTA_WELCOME].match(/^• /gm) || []).length, 7);
  assert.equal((ru[VELTA_WELCOME].match(/^• /gm) || []).length, 7);
});

test("language rides along in a settings export and english removes the key", () => {
  const src = { getItem: k => (k === "velta-lang" ? "fr" : null), setItem() {}, removeItem() {} };
  assert.equal(readSettings(src).language, "french");
  const text = serializeSettings({ getItem: k => (k === "velta-lang" ? "ru" : null), setItem() {}, removeItem() {} }, new Date(2026, 9, 18));
  assert.match(text, /^language: russian$/m);
  assert.match(text, new RegExp("^" + HEADER));
  const parsed = parseSettings(`${HEADER}\nlanguage: french\ntheme: dark`);
  assert.equal(parsed.values.language, "french");
  const dst = new Map();
  const ls = { getItem: k => dst.get(k) ?? null, setItem: (k, v) => dst.set(k, String(v)), removeItem: k => dst.delete(k) };
  applySettings(ls, parsed.values);
  assert.equal(ls.getItem("velta-lang"), "fr");
  applySettings(ls, parseSettings(`${HEADER}\nlanguage: english`).values);
  assert.equal(ls.getItem("velta-lang"), null);
  const bad = parseSettings(`${HEADER}\nlanguage: klingon\ntheme: dark`);
  assert.ok(bad.invalid.includes("language"));
  assert.equal(bad.values.theme, "dark");
});
