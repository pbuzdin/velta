import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chatsInCommon, JsonRpcCore } from "../app/js/rpc-core.js";

test("chatsInCommon asks for ids and stops when the sheet closes", async () => {
  const calls = [];
  const chats = [
    { id: 1, kind: "single", name: "dm" },
    { id: 2, kind: "group", name: "a" },
    { id: 3, kind: "channel", name: "b" },
    { id: "p2pg:x", kind: "group", name: "local" },
    { id: 4, kind: "group", name: "c" },
  ];
  let alive = true;
  const common = await chatsInCommon(chats, "7", async (id) => {
    calls.push(id);
    if (id === 3) throw new Error("nope");
    if (id === "p2pg:x") { alive = false; return [7]; }
    if (id === 2) return [1, 7];
    return [8];
  }, () => alive);
  assert.deepEqual(calls, [2, 3, "p2pg:x"]);
  assert.deepEqual(common.map(c => c.id), [2]);
});

test("getChatContactIds is one get_chat_contacts call", async () => {
  const core = new JsonRpcCore({});
  core.accountId = 4;
  const calls = [];
  core._call = async (method, ...params) => {
    calls.push([method, ...params]);
    return [1, 9];
  };
  assert.deepEqual(await core.getChatContactIds(12), [1, 9]);
  assert.deepEqual(calls, [["get_chat_contacts", 4, 12]]);
});

test("opening a profile does not scan chats in common", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const start = app.indexOf("Chats in common. An open used to");
  const block = app.slice(start, app.indexOf("if (chat.isP2pGroup)", start));
  assert.ok(start > 0 && block.includes("chatsInCommon("));
  assert.match(block, /addEventListener\("toggle"/);
  assert.doesNotMatch(block, /getChatList/);
  assert.match(block, /getChatContactIds/);
});
