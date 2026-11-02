import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// @mention chip: soft tinted background (no outline outside brutal), no fixed
// height, em padding, per-line clone so tall glyphs (DCLyДЙр, Zalgo, emoji)
// and wrapped names are never clipped by the chip.
const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const rule = sel => {
  const i = css.indexOf("\n" + sel + " {") + 1;
  assert.ok(i > 0, `rule ${sel} exists`);
  return css.slice(i, css.indexOf("}", i));
};

test("chip grows with glyph extents", () => {
  const r = rule(".msg-text .mention");
  assert.match(r, /line-height: normal/);
  assert.match(r, /padding: [\d.]+em [\d.]+em/);
  assert.doesNotMatch(r, /(^|[\s;])(height|min-height|max-height):/);
  assert.doesNotMatch(r, /white-space: nowrap/);
});

test("tinted background, outline only in brutal", () => {
  assert.match(rule(".msg-text .mention"), /background: color-mix\(in srgb, currentColor \d+%, transparent\)/);
  assert.doesNotMatch(rule(".msg-text .mention-me"), /box-shadow|outline|border:/);
  const b = rule('html[data-theme="brutal"] .msg-text .mention');
  assert.match(b, /background: transparent/);
  assert.match(b, /box-shadow: inset 0 0 0 1px currentColor/);
});

test("wrapped names get a chip per line", () => {
  const r = rule(".msg-text .mention");
  assert.match(r, /-webkit-box-decoration-break: clone/);
  assert.match(r, /[^-]box-decoration-break: clone/);
});

test("code is smaller, inside the chip, and cannot grow it", () => {
  assert.match(rule(".mention-code"), /font-size: \.\d+em/);
  assert.match(rule(".msg-text .mention .mention-code"), /line-height: 0/);
});
