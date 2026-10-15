import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #134: #hashtags in message text become focusable buttons; tap searches.
import { findHashtags } from "../app/js/hashtags.js";

globalThis.HTMLElement = class {};
globalThis.customElements = { get() {}, define() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
const { renderMarkdown } = await import("../app/js/markdown.js");

const tags = s => findHashtags(s).map(h => h.tag);

test("basic, Unicode, Cyrillic, digits, underscore", () => {
  assert.deepEqual(tags("#velta"), ["velta"]);
  assert.deepEqual(tags("hi #привет and #Ёлка_2026"), ["привет", "Ёлка_2026"]);
  assert.deepEqual(tags("#日本 #café #tag2 #2tag"), ["日本", "café", "tag2", "2tag"]);
  assert.deepEqual(tags("#a #b"), ["a", "b"]);
});

test("pure numbers are not tags", () => {
  assert.deepEqual(tags("see #123 and #1_000"), []);
  assert.deepEqual(tags("#_"), []);
});

test("punctuation boundaries", () => {
  assert.deepEqual(findHashtags("(#tag), #x. #y! #z?").map(h => h.text), ["#tag", "#x", "#y", "#z"]);
  assert.deepEqual(tags("«#кот»"), ["кот"]);
  assert.deepEqual(tags("#a-b"), ["a"]);
  const [h] = findHashtags("x #tag, y");
  assert.equal(h.start, 2); assert.equal(h.end, 6);
});

test("glued / entity / doubled # are not tags", () => {
  assert.deepEqual(tags("C# a#b &#123; ##x path/#x foo@#x a.#x -#x"), []);
  assert.deepEqual(tags("#"), []);
  assert.deepEqual(tags("# heading"), []);
});

test("length cap: >64 chars is not a tag", () => {
  assert.deepEqual(tags("#" + "a".repeat(64)).length, 1);
  assert.deepEqual(tags("#" + "a".repeat(65)), []);
});

test("render: button with escaped data, keyboard focusable", () => {
  const html = renderMarkdown("go #velta now");
  assert.match(html, /<button type="button" class="hashtag" data-hashtag="#velta" aria-label="Search #velta">#velta<\/button>/);
  assert.equal(renderMarkdown("#привет"), '<button type="button" class="hashtag" data-hashtag="#привет" aria-label="Search #привет">#привет</button>');
});

test("render: URL #fragments are never tags", () => {
  for (const s of ["https://ex.com/page#section", "example.com/a#frag", "[x](https://a.com/#y)", "github.com/a/b#readme"]) {
    assert.doesNotMatch(renderMarkdown(s), /hashtag/, s);
  }
  const mixed = renderMarkdown("https://a.com/#x #real");
  assert.equal((mixed.match(/class="hashtag"/g) || []).length, 1);
  assert.match(mixed, /data-hashtag="#real"/);
});

test("render: emphasis does not mangle underscores in tags; markup escaped", () => {
  const html = renderMarkdown("#a_b_c and _it_");
  assert.match(html, /data-hashtag="#a_b_c">|>#a_b_c<\/button>/);
  assert.match(html, /<em>it<\/em>/);
  const x = renderMarkdown('<img src=x onerror=alert(1)>#tag"><script>');
  assert.doesNotMatch(x, /<img|<script/);
  assert.match(x, /&lt;img/);
  assert.match(renderMarkdown("**#bold**"), /<strong><button[^>]*>#bold<\/button><\/strong>/);
});

test("render: inside lists and quotes", () => {
  assert.match(renderMarkdown("- #one\n- two"), /<li><button[^>]*>#one<\/button><\/li>/);
  assert.match(renderMarkdown("> #q"), /<blockquote><button[^>]*>#q<\/button><\/blockquote>/);
});

test("wiring: chat-view dispatches velta-hashtag, app.js opens prefilled search", () => {
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(cv, /closest\("button\[data-hashtag\]"\)/);
  assert.match(cv, /new CustomEvent\("velta-hashtag"/);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /addEventListener\("velta-hashtag"/);
  assert.match(app, /function openChatSearch\(prefill = ""\)/);
  assert.match(app, /if \(prefill\) \{ input\.value = prefill; search\(\); \}/);
});
