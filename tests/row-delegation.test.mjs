import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, FakeElement } from "./helpers/fake-dom.mjs";

installChatViewGlobals();
const { routeRowEvent, wireRowDelegation, ROW_EVENT_TYPES } = await import("../app/js/chat-view.js");

// Fix 3: message rows no longer register their own gesture listeners; one
// listener per type on the container routes to row._rowEvents.

const rowWith = (handlers) => {
  const row = new FakeElement();
  row.className = "msg-row out";
  row._rowEvents = handlers;
  const bubble = new FakeElement();
  bubble.className = "bubble";
  const text = new FakeElement("span");
  bubble.append(text);
  row.append(bubble);
  return { row, bubble, text };
};

test("a container listener reaches the row handler for a nested target", () => {
  const got = [];
  const { text } = rowWith({ click: e => got.push(["click", e.target]), touchmove: e => got.push(["move", e.target]) });
  routeRowEvent({ type: "click", target: text });
  routeRowEvent({ type: "touchmove", target: text });
  routeRowEvent({ type: "contextmenu", target: text }); // no handler: no throw
  assert.deepEqual(got.map(g => g[0]), ["click", "move"]);
  assert.equal(got[0][1], text);
});

test("a Text-node target (selectstart) resolves through its parent element", () => {
  let hit = 0;
  const { text } = rowWith({ selectstart: () => hit++ });
  routeRowEvent({ type: "selectstart", target: { nodeType: 3, parentElement: text } });
  assert.equal(hit, 1);
});

test("targets outside any message row are ignored", () => {
  const stray = new FakeElement();
  assert.doesNotThrow(() => routeRowEvent({ type: "click", target: stray }));
  assert.doesNotThrow(() => routeRowEvent({ type: "click", target: null }));
});

test("wireRowDelegation adds one listener per type; touchmove is non-passive", () => {
  const opts = {};
  const box = { addEventListener: (type, fn, o) => { opts[type] = o; } };
  wireRowDelegation(box);
  assert.deepEqual(Object.keys(opts).sort(), [...ROW_EVENT_TYPES].sort());
  assert.equal(opts.touchmove.passive, false);
});

test("_renderMsgItem no longer wires gesture listeners on each row", () => {
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  for (const type of ROW_EVENT_TYPES) assert.ok(!src.includes(`row.addEventListener("${type}"`), type);
  assert.ok(!/hover(Reply|More)\.addEventListener\("click"/.test(src));
});
