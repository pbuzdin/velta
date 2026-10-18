import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectTextLang, uiLang } from "../app/js/text-lang.js";

// Message bubbles hyphenate English and Russian (hyphens: auto). The engine
// picks its dictionary from `lang`, set per .msg-text by chat-view from a
// cheap Cyrillic/Latin letter count (text-lang.js). Machine text — links,
// e-mail addresses, hashtags, code — is never hyphenated.
const CSS = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const VIEW = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");

globalThis.HTMLElement = globalThis.HTMLElement || class {};
globalThis.customElements = globalThis.customElements || { get() {}, define() {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {} };
const { renderMarkdown } = await import("../app/js/markdown.js");

test("detectTextLang: Cyrillic vs Latin majority, fallback otherwise", () => {
  assert.equal(detectTextLang("Привет, как дела?"), "ru");
  assert.equal(detectTextLang("Hello there, how are you?"), "en");
  assert.equal(detectTextLang("Открой Velta и проверь синхронизацию"), "ru");
  assert.equal(detectTextLang("Meeting at Москва tomorrow afternoon"), "en");
  assert.equal(detectTextLang("👍 123 !!!", "ru"), "ru", "no letters → fallback");
  assert.equal(detectTextLang("", "en"), "en");
  assert.equal(detectTextLang(null, "ru"), "ru");
  assert.equal(detectTextLang("ab где", "ru"), "ru", "tie → fallback");
});

test("detectTextLang ignores links, addresses and domains", () => {
  assert.equal(detectTextLang("Смотри https://example.org/some/very/long/english/path тут"), "ru");
  assert.equal(detectTextLang("Пиши на pavel.buzdin@example.org"), "ru");
  assert.equal(detectTextLang("Зайди на github.com/pbuzdin/velta"), "ru");
});

test("uiLang: html lang, then navigator.language, ru or en", () => {
  assert.equal(uiLang({ documentElement: { lang: "ru-RU" } }, {}), "ru");
  assert.equal(uiLang({ documentElement: { lang: "" } }, { language: "ru" }), "ru");
  assert.equal(uiLang({ documentElement: { lang: "en" } }, { language: "ru" }), "en");
  assert.equal(uiLang({ documentElement: { lang: "de" } }, {}), "en");
});

test("chat-view sets lang on every message text", () => {
  assert.match(VIEW, /import \{ detectTextLang, uiLang \} from "\.\/text-lang\.js";/);
  assert.match(VIEW, /<div class="msg-text" lang="\$\{detectTextLang\(m\.text, uiLang\(\)\)\}">/);
});

test("CSS: hyphens auto on bubble text, manual on machine text, switch off", () => {
  assert.match(CSS, /\.msg-text \{[^}]*-webkit-hyphens: auto; hyphens: auto;/);
  assert.match(CSS, /html\.no-hyphens \.msg-text \{ -webkit-hyphens: manual; hyphens: manual; \}/);
  const rule = /([^{}]+)\{ -webkit-hyphens: manual; hyphens: manual; \}/g;
  const sels = [...CSS.matchAll(rule)].map(m => m[1]).join(",");
  for (const s of [".msg-text a", ".msg-text code", ".msg-text pre", ".msg-text .hashtag", ".msg-text .msg-nohyph"]) {
    assert.ok(sels.includes(s), `${s} is not hyphenated`);
  }
  // overflow-wrap: anywhere still breaks strings no dictionary knows.
  assert.match(CSS, /\.bubble \{[^}]*overflow-wrap: anywhere;/);
});

test("markdown wraps bare e-mail addresses in a no-hyphenation span", () => {
  const html = renderMarkdown("write to pavel.b@example.org or see example.com");
  assert.match(html, /<span class="msg-nohyph">pavel\.b@example\.org<\/span>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  // Still escaped (no markup injection through the span).
  assert.match(renderMarkdown("<b>x</b>@ex.org"), /&lt;/);
  // Hashtags keep working around addresses.
  assert.match(renderMarkdown("#tag a@b.org #two"), /data-hashtag="#tag"[\s\S]*msg-nohyph[\s\S]*data-hashtag="#two"/);
});
