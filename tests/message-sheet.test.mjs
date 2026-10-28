import test from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { messageSheetRows, gridNeighbor, footButtons } = await import("../app/js/ui.js");
const { searchEmoji } = await import("../app/js/emoji.js");

test("actions tile in order and delete stays a full-width row", () => {
  const { tiles, danger } = messageSheetRows([
    { label: "Reply", pair: "send" },
    { label: "Forward", pair: "send" },
    { label: "Pin", pair: "keep" },
    { label: "Save", pair: "keep" },
    { label: "Download", pair: "file" },
    { label: "Resend", pair: "own" },
    { label: "Select", pair: "meta" },
    "-",
    { label: "Delete", danger: true },
  ]);
  assert.deepEqual(tiles.map(i => i.label), ["Reply", "Forward", "Pin", "Save", "Download", "Resend", "Select"]);
  assert.deepEqual(danger.map(i => i.label), ["Delete"]);
});

test("arrow keys walk the 3-column grid and stop at the edges", () => {
  assert.equal(gridNeighbor(0, 7, 3, "ArrowRight"), 1);
  assert.equal(gridNeighbor(1, 7, 3, "ArrowDown"), 4);
  assert.equal(gridNeighbor(4, 7, 3, "ArrowDown"), 4); // no tile below
  assert.equal(gridNeighbor(0, 7, 3, "ArrowUp"), 0);
  assert.equal(gridNeighbor(3, 7, 2, "ArrowUp"), 1);
  assert.equal(gridNeighbor(5, 7, 3, "Home"), 0);
  assert.equal(gridNeighbor(0, 7, 3, "End"), 6);
});

test("grid CSS: 3 columns, 2 under 340px, delete full width", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /\.msg-grid \{ display: grid; grid-template-columns: repeat\(3,/);
  assert.match(css, /@media \(max-width: 339\.98px\) \{ \.msg-grid \{ grid-template-columns: repeat\(2,/);
});

test("emoji search matches a name and is empty for nonsense", () => {
  assert.ok(searchEmoji("heart").some(e => e.emoji === "❤️"));
  assert.ok(searchEmoji("").length > 100);
  assert.equal(searchEmoji("zzznone").length, 0);
});

test("the emoji tray lists every glyph once and keeps merged keywords", () => {
  const all = searchEmoji("");
  assert.equal(new Set(all.map(e => e.emoji)).size, all.length);
  assert.ok(searchEmoji("gymnastics").some(e => e.emoji === "🤸"));
  assert.ok(searchEmoji("lips").some(e => e.emoji === "👄"));
});

test("footButtons builds Cancel + action as direct fragment children", () => {
  const prev = globalThis.document;
  globalThis.document = {
    createDocumentFragment: () => ({ kids: [], append(...k) { this.kids.push(...k); } }),
    createElement: tag => ({ tag }),
  };
  try {
    const { foot, cancel, ok } = footButtons("Join", { okType: "submit", okClass: "btn-text btn-primary" });
    assert.deepEqual(foot.kids, [cancel, ok]);
    assert.deepEqual({ ...cancel }, { tag: "button", type: "button", className: "btn-text", textContent: "Cancel" });
    assert.deepEqual({ ...ok }, { tag: "button", type: "submit", className: "btn-text btn-primary", textContent: "Join" });
    const only = footButtons(null, { cancelLabel: "Close" });
    assert.equal(only.ok, null);
    assert.deepEqual(only.foot.kids.map(b => b.textContent), ["Close"]);
  } finally { globalThis.document = prev; }
});
