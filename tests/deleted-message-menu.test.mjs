import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");

test("a deleted message's menu is Select, Info and Delete only", () => {
  const from = src.indexOf("export function deletedMessageActions");
  const body = src.slice(from, src.indexOf("\n}", from));
  const labels = [...body.matchAll(/label: "([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(labels, ["Select", "Info", "Delete"]);
  const menu = src.slice(src.indexOf("_msgContextMenu(item"), src.indexOf("// #161: the gesture landed on a link"));
  assert.match(menu, /deletedMessageActions\(/);
  assert.match(menu, /reactions: \[\]/);
});

test("the deleted tombstone is compact (no measured min-height)", () => {
  assert.doesNotMatch(src, /msg-deleted"\$\{h \?/);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const rule = css.slice(css.indexOf(".bubble.msg-deleted {"), css.indexOf("}", css.indexOf(".bubble.msg-deleted {")));
  assert.match(rule, /min-height: 0/);
});
