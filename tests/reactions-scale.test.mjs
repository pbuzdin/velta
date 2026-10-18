import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Reaction chips under bubbles follow the message text size (drawer → Chat
// appearance, --msg-font-size). At the 15.5px default they render exactly as
// before (16px emoji + count, 4px gap, 5px top margin, 2px 8px padding, 12px
// radius) and scale with the setting at that ratio; they wrap, never overflow.
const CSS = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const rule = sel => {
  const re = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(CSS); assert.ok(m, `rule ${sel}`); return m[1];
};
const decl = (body, prop) => {
  const m = new RegExp(`(?:^|[;\\s{])${prop}\\s*:\\s*([^;]+);`).exec(body); return m?.[1].trim();
};
// Tiny evaluator for the calc()/em values used here.
function px(value, msgFont, emBase) {
  const v = value.replace(/var\(--msg-font-size\)/g, String(msgFont)).replace(/^calc\((.*)\)$/, "$1");
  if (/^[\d.]+em$/.test(v)) return parseFloat(v) * emBase;
  assert.match(v, /^[\d.\s*/]+$/, `simple arithmetic only: ${value}`);
  return v.split("*").map(t => t.trim()).reduce((acc, t) => acc * t.split("/").map(Number).reduce((a, b) => a / b), 1);
}

test("reactions box takes its size from --msg-font-size at the 16 : 15.5 ratio", () => {
  const box = rule(".msg-reactions");
  const fs = decl(box, "font-size");
  assert.match(fs, /var\(--msg-font-size\)/);
  for (const [msg, want] of [[15.5, 16], [10, 10.3226], [22, 22.7097]]) {
    assert.ok(Math.abs(px(fs, msg) - want) < 0.001, `${msg}px text → ${want}px chips`);
  }
  assert.equal(decl(box, "flex-wrap"), "wrap", "chips wrap instead of overflowing");
  assert.equal(decl(box, "max-width"), "100%");
  const at = 16;
  assert.equal(px(decl(box, "gap"), 15.5, at), 4);
  assert.equal(px(decl(box, "margin-top"), 15.5, at), 5);
});

test("chips inherit that size and keep their spacing in em (same pixels at the default)", () => {
  assert.match(rule("button.reaction-chip"), /font:\s*inherit/, "the chip button inherits the box size");
  const chip = rule(".msg-reactions .reaction-chip");
  assert.equal(px(decl(chip, "gap"), 15.5, 16), 4);
  assert.equal(decl(chip, "padding"), ".125em .5em"); // 2px 8px at 16px
  assert.equal(px(decl(chip, "border-radius"), 15.5, 16), 12);
  assert.equal(decl(chip, "min-width"), "0");
  assert.equal(decl(chip, "max-width"), "100%");
  // No fixed pixel sizes left in the in-bubble reaction rules.
  assert.doesNotMatch(rule(".msg-reactions") + chip, /\d+px/);
});
