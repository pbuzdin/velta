import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reactionToggle, myReaction } from "../app/js/reactions.js";
import { JsonRpcCore } from "../app/js/rpc-core.js";

test("tapping own reaction removes it (send [])", () => {
  const p = reactionToggle([{ emoji: "👍", count: 1, mine: true }], "👍");
  assert.deepEqual(p.send, []);
  assert.equal(p.removing, true);
  assert.equal(p.reactions, null);
});

test("own reaction among others decrements, keeps others", () => {
  const p = reactionToggle([{ emoji: "👍", count: 3, mine: true }, { emoji: "❤️", count: 1, mine: false }], "👍");
  assert.deepEqual(p.reactions, [{ emoji: "👍", count: 2, mine: false }, { emoji: "❤️", count: 1, mine: false }]);
});

test("different emoji replaces own reaction", () => {
  const p = reactionToggle([{ emoji: "👍", count: 1, mine: true }, { emoji: "❤️", count: 2, mine: false }], "❤️");
  assert.deepEqual(p.send, ["❤️"]);
  assert.equal(p.removing, false);
  assert.deepEqual(p.reactions, [{ emoji: "❤️", count: 3, mine: true }]);
});

test("first reaction adds a mine chip; input not mutated", () => {
  const src = [{ emoji: "😂", count: 1, mine: false }];
  const p = reactionToggle(src, "🎉");
  assert.deepEqual(p.reactions.at(-1), { emoji: "🎉", count: 1, mine: true });
  assert.deepEqual(src, [{ emoji: "😂", count: 1, mine: false }]);
  assert.equal(myReaction(p.reactions), "🎉");
  assert.equal(myReaction(null), null);
});

test("rpc setReaction sends the list to send_reaction", async () => {
  const calls = [];
  class P extends JsonRpcCore { async _call(m, ...a) { calls.push([m, ...a]); return null; } }
  const c = new P(); c.accountId = 3;
  await c.setReaction(4, 11, []);
  await c.setReaction(4, 11, ["👍"]);
  assert.deepEqual(calls.filter(x => x[0] === "send_reaction"), [["send_reaction", 3, 11, []], ["send_reaction", 3, 11, ["👍"]]]);
});

test("chat-view wires toggle, aria-pressed and rollback; local chats get no reactions", () => {
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(src, /aria-pressed="\$\{r\.mine \? "true" : "false"\}"/);
  assert.match(src, /_toggleReaction\(chatId, msgId, emoji\)/);
  assert.match(src, /reactions: before\.reactions/); // rollback
  assert.match(src, /canReact = !this\.chat\?\.isP2p/);
  assert.doesNotMatch(src, /this\.core\.addReaction\(session/);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /selected = null/);
  assert.match(ui, /aria-pressed/);
});
