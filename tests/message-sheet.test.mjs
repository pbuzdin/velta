import test from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { messageSheetRows } = await import("../app/js/ui.js");
const { searchEmoji } = await import("../app/js/emoji.js");

test("related actions share a row and delete is full width", () => {
  const rows = messageSheetRows([
    { label: "Reply", pair: "send" },
    { label: "Forward", pair: "send" },
    { label: "Pin", pair: "keep" },
    { label: "Save", pair: "keep" },
    { label: "Edit", pair: "own" },
    "-",
    { label: "Delete", danger: true },
  ]);
  assert.deepEqual(rows.map(r => r.items.map(i => i.label)), [
    ["Reply", "Forward"],
    ["Pin", "Save"],
    ["Edit"],
    ["Delete"],
  ]);
  assert.equal(rows.at(-1).full, true);
  assert.equal(rows[0].full, false);
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
