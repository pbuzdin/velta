import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #156: `code` spans render as click-to-copy <button class="msg-code">; their
// content is opaque to links, emphasis, hashtags and mentions, and escaped
// for display. chat-view copies the span's text on tap (wiring assert below —
// the fake DOM's closest() can't parse attribute selectors).
globalThis.HTMLElement = class {};
globalThis.customElements = { get() {}, define() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
const { renderMarkdown } = await import("../app/js/markdown.js");

test("backticks render a copy button", () => {
  assert.equal(
    renderMarkdown("run `npm test` now"),
    'run <button type="button" class="msg-code" data-copy-code title="Click to copy">npm test</button> now');
});

test("code content is escaped, not linkified, not emphasized, not tagged", () => {
  const html = renderMarkdown('`<b>&"x"</b> https://evil.example **bold** #tag`');
  assert.match(html, /<button[^>]*data-copy-code[^>]*>&lt;b&gt;&amp;&quot;x&quot;&lt;\/b&gt; https:\/\/evil\.example \*\*bold\*\* #tag<\/button>/);
  assert.ok(!html.includes("<a "), "no anchor inside code");
  assert.ok(!html.includes("<strong>"), "no emphasis inside code");
  assert.ok(!html.includes("data-hashtag"), "no hashtag button inside code");
});

test("unpaired backticks stay literal; spans can't be empty or cross lines", () => {
  assert.equal(renderMarkdown("a ` b"), "a ` b");
  assert.equal(renderMarkdown("``"), "``");
  assert.ok(renderMarkdown("`a\nb`").includes("`"), "span can't cross a line");
});

test("code next to a real link keeps both", () => {
  const html = renderMarkdown("see https://example.com/x and `y`");
  assert.match(html, /<a href="https:\/\/example\.com\/x"/);
  assert.match(html, /data-copy-code[^>]*>y</);
});

test("wiring: chat-view copies the span text on click", () => {
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(cv, /closest\("button\[data-copy-code\]"\)/);
  assert.match(cv, /writeText\(copyBtn\.textContent\)/);
});
