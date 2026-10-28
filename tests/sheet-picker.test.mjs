import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.HTMLElement = class {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { SHEET_QUICK_REACTIONS, sheetEscapeAction, deleteConfirmChoices } = await import("../app/js/ui.js");
const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");

test("two rows of six: 11 quick reactions + the more smiley", () => {
  assert.equal(SHEET_QUICK_REACTIONS + 1, 12);
  assert.match(ui, /reactions\.slice\(0, SHEET_QUICK_REACTIONS\)/);
});

test("Escape leaves the picker first, then closes", () => {
  assert.equal(sheetEscapeAction(true), "back");
  assert.equal(sheetEscapeAction(false), "close");
});

test("picker fills the locked sheet height; grid scrolls below the drag strip", () => {
  assert.match(ui, /menu\.style\.height = menu\.getBoundingClientRect\(\)\.height \+ "px"/);
  assert.match(css, /\.msg-sheet\.picking > :not\(\.msg-sheet-grab\):not\(\.msg-sheet-picker\) \{ display: none; \}/);
  assert.match(css, /\.msg-sheet-picker \.msg-emoji-grid \{[^}]*overflow: auto/);
  assert.match(ui, /back\.innerHTML = ICON\.arrowLeft/);
  for (const l of ["ru", "fr"]) {
    const j = JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url)));
    for (const k of ["Back", "Search emoji", "More emoji", "No emoji"]) assert.ok(j[k], `${l} ${k}`);
  }
});

test("two-per-row layouts go icon-beside-label", () => {
  assert.match(css, /@media \(max-width: 339\.98px\) \{\n  \.msg-actions \.msg-grid \.ctx-item\.msg-tile \{\n    flex-direction: row;/);
  assert.match(css, /\.msg-del-confirm\[data-count="2"\] \.ctx-item \{ flex-direction: row;/);
  assert.equal(deleteConfirmChoices(false).length, 2);
  assert.ok(deleteConfirmChoices(true).every(c => c.icon));
});
