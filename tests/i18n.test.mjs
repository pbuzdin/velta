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
  // Helpers that translate their own arguments (showModal titles, menu and
  // sheet items, confirm/ask dialogs, toggles, relay flags) take English
  // literals; each literal is a key too.
  const SKIP = new Set(["mock-core.js", "rpc-core.js", "device-info.js", "settings-transfer.js", "local-chat.js", "i18n.js"]);
  const STR = '"((?:\\\\.|[^"\\\\])*)"';
  const helperRes = [
    new RegExp(`\\b(?:label|short|ariaLabel):\\s*${STR}`, "g"),
    new RegExp(`\\b(?:showModal|acquireCode|sideViewShell)\\(\\{\\s*title:\\s*${STR}`, "g"),
    new RegExp(`\\b(?:confirmModal|footButtons|askText|pickContactModal|toggleText)\\(\\s*${STR}`, "g"),
    new RegExp(`\\bconfirmModal\\([^\\n]*?,\\s*${STR},\\s*(?:true|false)\\)`, "g"),
    new RegExp(`\\bflag\\("[A-Z]",\\s*${STR}`, "g"),
  ];
  for (const f of readdirSync(new URL("../app/js/", import.meta.url))) {
    if (!f.endsWith(".js") || SKIP.has(f)) continue;
    const src = readFileSync(new URL("../app/js/" + f, import.meta.url), "utf8")
      .split("\n").filter(l => !l.includes("backend") && !/^\s*\/\//.test(l)).join("\n");
    for (const re of helperRes) for (const k of quoted(src, re)) if (k.trim()) keys.add(k);
  }
  for (const k of quoted(readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8"), /setToggleUi\("[\w-]+", "([^"]+)"/g)) keys.add(k);
  for (const s of ["on", "off", "unknown", "{label}: {state}"]) keys.add(s);
  // Strings kept in constants and shown through t(CONST) or t(item.field).
  const js = f => readFileSync(new URL("../app/js/" + f, import.meta.url), "utf8");
  const strings = src => quoted(src, /"((?:\\.|[^"\\])*)"/g);
  const span = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  for (const f of ["calls.js", "group-call-ui.js", "group-call-signal.js", "tunnel.js"]) {
    for (const k of quoted(js(f), /\b(?:CAMERA_DENIED_MSG|MIC_DENIED_MSG|CONSENT_TITLE|CONSENT_TEXT|DEFAULT_CALL_TITLE|UNSUPPORTED_MSG) =\s*"((?:\\.|[^"\\])*)"/g)) keys.add(k);
  }
  const tunnel = js("tunnel.js");
  for (const m of span(tunnel, "const MODES = [", "];").matchAll(/\["\w+", "([^"]+)", "([^"]+)"\]/g)) { keys.add(m[1]); keys.add(m[2]); }
  for (const k of quoted(tunnel, /\b(?:btn\("\w+", [\w.]+|fail)\(?,?\s*"((?:\\.|[^"\\])*)"/g)) keys.add(k);
  for (const k of strings(span(js("link-preview.js"), "LINK_PREVIEW_LABELS = {", "}"))) keys.add(k);
  for (const k of quoted(span(js("scheduled-ui.js"), "PRESET_LABEL = {", "}"), /:\s*"([^"]+)"/g)) keys.add(k);
  for (const k of quoted(js("local-chat.js"), /\breason = "([^"]+)"/g)) keys.add(k);
  for (const k of strings(span(js("chat-view.js"), "const FWD_LABELS = {", "}"))) keys.add(k);
  for (const k of quoted(js("relay-push.js"), /PUSH_MARK_LABEL = "([^"]+)"/g)) keys.add(k);
  for (const m of js("chat-appearance.js").matchAll(/\[(?:null|"#[0-9a-f]{6}"), "([^"]+)"\]/g)) keys.add(m[1]);
  // t(cond ? "A" : "B")
  for (const f of readdirSync(new URL("../app/js/", import.meta.url))) {
    if (!f.endsWith(".js") || f === "i18n.js") continue;
    for (const m of js(f).matchAll(/\bt\([^"()\n]{1,80}\?\s*"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
      keys.add(JSON.parse('"' + m[1] + '"')); keys.add(JSON.parse('"' + m[2] + '"'));
    }
  }
  for (const k of quoted(js("scheduled.js"), /\berror: (?:String\(op\.error \|\| )?"([A-Z][^"]+)"/g)) keys.add(k);
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

test("translations keep the placeholders and markup of their key", () => {
  const holes = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  const tags = s => [...s.matchAll(/<\/?([a-z]+)\b/g)].map(m => m[0]).sort();
  const bad = [];
  for (const [lang, pack] of [["fr", fr], ["ru", ru]]) {
    for (const [k, v] of Object.entries(pack)) {
      if (!v) continue;
      if (holes(k).join() !== holes(v).join()) bad.push(`${lang}: placeholders differ in ${JSON.stringify(k)}`);
      if (tags(k).join() !== tags(v).join()) bad.push(`${lang}: markup differs in ${JSON.stringify(k)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("android strings exist in every locale with the same placeholders", () => {
  const res = new URL("../velta-app/src-tauri/gen/android/app/src/main/res/", import.meta.url);
  const read = dir => {
    const out = {};
    for (const f of ["strings.xml", "bg_strings.xml"]) {
      let xml = "";
      try { xml = readFileSync(new URL(dir + "/" + f, res), "utf8"); } catch { continue; }
      for (const m of xml.matchAll(/<string name="([^"]+)"(?![^>]*translatable="false")[^>]*>([\s\S]*?)<\/string>/g)) out[m[1]] = m[2];
    }
    return out;
  };
  const en = read("values");
  delete en.app_name; delete en.main_activity_title;
  const holes = s => [...s.matchAll(/%\d*\$?[sd]/g)].map(m => m[0]).sort().join();
  const kt = readdirSync(new URL("java/org/velta/", new URL("../", res))).filter(f => f.endsWith(".kt"))
    .map(f => readFileSync(new URL("java/org/velta/" + f, new URL("../", res)), "utf8")).join("\n");
  for (const name of kt.matchAll(/R\.string\.(\w+)/g)) assert.ok(name[1] in en, `values/ lacks ${name[1]}`);
  for (const lang of ["values-ru", "values-fr"]) {
    const pack = read(lang);
    for (const [k, v] of Object.entries(en)) {
      assert.ok(pack[k]?.trim(), `${lang} lacks ${k}`);
      assert.equal(holes(pack[k]), holes(v), `${lang}: placeholders differ in ${k}`);
    }
  }
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
