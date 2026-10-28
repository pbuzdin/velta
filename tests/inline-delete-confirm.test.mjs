import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.HTMLElement = class {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { deleteConfirmChoices } = await import("../app/js/ui.js");
const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");

test("inline delete offers for-everyone only when the modal would", () => {
  assert.deepEqual(deleteConfirmChoices(true).map(c => c.value), [null, "me", "everyone"]);
  assert.deepEqual(deleteConfirmChoices(false).map(c => c.label), ["Cancel", "Delete for me"]);
  assert.ok(deleteConfirmChoices(true).slice(1).every(c => c.danger));
});

test("sheet delete and modal share one code path; desktop keeps the modal", () => {
  assert.match(cv, /inlineConfirm: \{ canForAll: this\._canDeleteForAll\(\[m\.id\]\), onChoose: \(choice\) => this\._applyDeleteChoice\(session, \[m\.id\], choice\) \}/);
  assert.match(cv, /confirmDeleteMessagesModal\(ids\.length, this\._canDeleteForAll\(ids\)\);\n\s*this\._applyDeleteChoice\(session, ids, choice\);/);
  assert.match(cv, /_applyDeleteChoice\(session, ids, choice\) \{[\s\S]{0,120}this\._holdDelete\(session, ids, choice === "everyone"\)/);
});

test("inline confirm row: wraps at 320px, focus to first button, reduced motion", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /buttons\[0\]\.focus\(\)/);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /\.msg-del-confirm \.ctx-item \{[^}]*white-space: normal/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.msg-del-confirm \{ animation: none/);
});
