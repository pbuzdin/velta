import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #113: the floating "Reply" selection chip (sel-quote-chip) is a
// desktop affordance — mouse selections get the floating chip, touch
// selections get the in-bubble "Select text" bar with its own Reply.
// The chip binding must carry the fine-pointer gate.

const source = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("selection chip binds only on fine-pointer (desktop) devices", () => {
  const start = stripped.indexOf("_bindSelectionQuote() {");
  const chipCreate = stripped.indexOf('document.createElement("button")', start);
  assert.ok(start !== -1 && chipCreate > start, "binding exists and creates the chip");
  const head = stripped.slice(start, chipCreate);
  assert.match(head, /matchMedia\("\(hover: hover\) and \(pointer: fine\)"\)/);
  assert.match(head, /return;/, "gated off on coarse pointers before the chip is created");
});

test("touch keeps its fragment-quote path (in-bubble Select-text Reply)", () => {
  // The complementary mobile affordance must stay: the select-text flow
  // offers Reply on the fragment it selects.
  assert.match(stripped, /_offerSelectText\(\)/);
  const selFlow = stripped.indexOf("_textSelect = { row, target, bar, exit };");
  assert.ok(selFlow !== -1, "select-text flow intact");
});
