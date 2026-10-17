import test from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { messageSheetRows, footButtons } = await import("../app/js/ui.js");
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
