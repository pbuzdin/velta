import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #182 phase 2: /design/components is GENERATED from app/css/main.css
// (tools/gen-design-components.mjs) — the real component rules, scoped under
// .vc with themes on .vc[data-vt], plus class-forced state rules so the
// static page can render hover/pressed/focus side by side. This test pins
// the committed fragment to the CSS: a component change cannot land without
// the preview following (same gate as design-tokens-doc).

process.env.VELTA_GEN_NO_WRITE = "1";
const { generateDesignComponents } = await import("../tools/gen-design-components.mjs");

test("committed docs/design-components.html matches the current main.css", () => {
  const committed = readFileSync(new URL("../docs/design-components.html", import.meta.url), "utf8");
  assert.equal(generateDesignComponents(), committed, "stale — run: node tools/gen-design-components.mjs");
});

test("every emitted selector is scoped under .vc — no bare app rules leak", () => {
  const gen = generateDesignComponents();
  const style = gen.split("<style>")[1].split("</style>")[0];
  const sels = style.split("\n").filter(l => l.includes("{") && !l.trim().startsWith("@")).map(l => l.split("{")[0].trim());
  for (const s of sels) {
    for (const part of s.split(",")) {
      assert.match(part.trim(), /^\.vc(\[data-vt|[\s.:[]|$)/, `unscoped selector part: ${part.trim()}`);
    }
  }
});

test("forced state rules exist for every interactive component state", () => {
  const gen = generateDesignComponents();
  for (const sel of [
    ".vc .btn-text.btn-primary.is-hover",
    ".vc .btn-text.btn-primary.is-pressed",
    ".vc .icon-btn.is-hover",
    ".vc .chat-cats button.is-hover:not(.active)",
    ".vc .msg-actions .ctx-item.is-focus",
    ".vc .text-field.is-focus",
  ]) {
    assert.ok(gen.includes(sel), `missing forced rule: ${sel}`);
  }
  // hover bodies must equal their forced bodies (verbatim from main.css)
  assert.match(gen, /\.vc \.icon-btn:hover \{ background: var\(--bg-hover\); \}\n\.vc \.icon-btn\.is-hover \{ background: var\(--bg-hover\); \}/);
});

test("the demo ships every contract component", () => {
  const gen = generateDesignComponents();
  for (const id of ["button-primary", "button-text", "icon-button", "tabs", "menu-item", "chip", "day-chip", "text-field", "dialog", "link"]) {
    assert.ok(gen.includes(`id="${id}"`), `demo section missing: ${id}`);
  }
  assert.match(gen, /<button class="btn-text btn-primary" type="button" disabled>/, "disabled is real, not a class");
});
