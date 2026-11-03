import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// #182 slice 1, enforced statically: per-theme accent-tint, the --selection-bg
// split from --bg-active, and the --focus-ring contract. Values were chosen to
// keep every rendered pair AA (the e2e-contrast CI measures the real screens);
// this file pins the STRUCTURE so the semantics can't silently rot.

const CSS = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const APP = readFileSync(new URL("../app/js/chat-appearance.js", import.meta.url), "utf8");

const blockOf = (sel) => {
  const i = CSS.indexOf(sel + " {");
  assert.ok(i >= 0, `block ${sel} found`);
  return CSS.slice(i, CSS.indexOf("\n}", i));
};
const dark = blockOf(":root");
const light = blockOf('html[data-theme="light"]');
const brutal = blockOf('html[data-theme="brutal"]');
const tok = (b, n) => (b.match(new RegExp(`--${n}:\\s*([^;]+);`)) || [])[1]?.trim();

test("--selection-bg owns the chat-list selection, separate from --bg-active", () => {
  for (const [name, b] of [["dark", dark], ["light", light], ["brutal", brutal]]) {
    assert.ok(tok(b, "selection-bg"), `${name} defines --selection-bg`);
  }
  assert.match(CSS, /\.chat-item\.active \{ background: var\(--selection-bg\); \}/);
  assert.doesNotMatch(CSS, /\.chat-item\.active \{ background: var\(--bg-active\)/);
  // The custom-accent derivation emits the alias for dark and light.
  assert.match(APP, /selectionBg: "--selection-bg"/);
  assert.match(APP, /out\.selectionBg = bubble;/);
  assert.match(APP, /out\.selectionBg = accent;/);
});

test("--accent-tint is derived per theme and matches each theme's accent", () => {
  for (const [name, b] of [["dark", dark], ["light", light], ["brutal", brutal]]) {
    assert.equal(tok(b, "accent-tint"), tok(b, "accent"), `${name} tint follows its accent`);
  }
});

test("every focus-visible outline uses --focus-ring or a deliberate exception", () => {
  const rules = CSS.match(/[^{}\n][^{}]*focus-visible[^{}]*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 20, `found ${rules.length} focus-visible rules`);
  const allowed = /outline:\s*(none|2px solid var\(--focus-ring\)|3px solid var\(--focus-ring\)|2px solid currentColor|2px solid var\(--text\))/;
  for (const r of rules) {
    const outlines = r.match(/outline:[^;]+;/g) || [];
    assert.ok(outlines.length, `rule declares an outline: ${r.trim().slice(0, 70)}`);
    for (const o of outlines) assert.match(o, allowed, `outline in ${r.trim().slice(0, 70)}`);
  }
  // The tokens exist in every theme.
  assert.ok(tok(dark, "focus-ring") && tok(light, "focus-ring") && tok(brutal, "focus-ring"));
});

test("light --focus-ring clears 3:1 against the surfaces it is drawn on", () => {
  const ctx = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, document: { documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} }, head: { appendChild() {} } }, matchMedia: () => ({ matches: false }) };
  ctx.globalThis = ctx;
  vm.runInNewContext(APP, ctx);
  const A = ctx.VeltaChatAppearance;
  const ring = tok(light, "focus-ring");
  for (const bg of [tok(light, "bg"), tok(light, "bg-bubble-in"), "#e9e9e9"]) {
    assert.ok(A.contrast(ring, bg) >= 3, `${ring} on ${bg} = ${A.contrast(ring, bg).toFixed(2)}:1`);
  }
});
