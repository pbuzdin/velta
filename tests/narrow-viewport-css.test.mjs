// Small-viewport overflow guards (320–360 px phones, interface scale).
// The full browser audit is scripts/e2e-narrow-overflow.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("no raw viewport units outside the zoom-corrected --vw/--vh/--dvh definitions", () => {
  // ui-scale.js zooms <html>; CSS zoom multiplies vw/vh/dvh, so 100vw sheets
  // were 414px wide on a 360px phone at the Large scale.
  const raw = code.split("\n").filter(l => /\d(vw|vh|dvh|svh|lvh)\b/.test(l) && !/--(vw|vh|dvh):/.test(l));
  assert.deepEqual(raw, []);
  assert.match(code, /--vw: calc\(100vw \/ var\(--ui-zoom\)\)/);
});

test("ui-scale writes --ui-zoom next to zoom", () => {
  const pre = readFileSync(new URL("../app/js/ui-scale.js", import.meta.url), "utf8");
  assert.match(pre, /setProperty\("--ui-zoom", s\)/);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /root\.setProperty\("--ui-zoom", v\)/);
  assert.match(ui, /removeProperty\("--ui-zoom"\)/);
});

test("bubble cards cap their min-width at the bubble width", () => {
  for (const sel of [".msg-file", ".msg-webxdc", ".msg-voice", ".msg-audio", ".msg-transfer"]) {
    const m = code.match(new RegExp(sel.replace(".", "\\.") + " \\{[^}]*\\}"));
    assert.ok(m, sel);
    assert.doesNotMatch(m[0], /min-width: \d+px/, sel);
  }
  assert.match(code, /\.bubble \{[^}]*overflow-wrap: anywhere;/);
});

test("key/value rows wrap and their columns may shrink", () => {
  assert.match(code, /\.info-row \{[^}]*flex-wrap: wrap;/);
  assert.match(code, /\.info-row \.v \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  assert.match(code, /\.info-row \.k \{[^}]*min-width: 0;/);
});
