import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { channelAuthorId } from "../app/js/format.js";

// Issue #132: "Message author" in a channel header opens the 1:1 chat with
// the channel's one author.

test("channelAuthorId: only an incoming broadcast with one real author", () => {
  assert.equal(channelAuthorId("InBroadcast", [1, 42]), 42);
  assert.equal(channelAuthorId("InBroadcast", [42]), 42);
  assert.equal(channelAuthorId("InBroadcast", [1]), null);          // author unknown
  assert.equal(channelAuthorId("InBroadcast", []), null);
  assert.equal(channelAuthorId("InBroadcast", [42, 43]), null);     // ambiguous
  assert.equal(channelAuthorId("OutBroadcast", [1, 42, 43]), null); // we are the author
  assert.equal(channelAuthorId("Mailinglist", [42]), null);
  assert.equal(channelAuthorId("Group", [42]), null);
});

function core(chatType, contacts) {
  const c = new JsonRpcCore({});
  c.accountId = 3;
  c.calls = [];
  c._call = async (method, ...params) => {
    c.calls.push([method, ...params]);
    if (method === "get_basic_chat_info") return { chatType };
    if (method === "get_chat_contacts") return contacts;
    throw new Error("unexpected " + method);
  };
  return c;
}

test("getChannelAuthorId asks the core for the chat type and contacts", async () => {
  const c = core("InBroadcast", [1, 77]);
  assert.equal(await c.getChannelAuthorId(9), 77);
  assert.deepEqual(c.calls, [["get_basic_chat_info", 3, 9], ["get_chat_contacts", 3, 9]]);
  const out = core("OutBroadcast", [1, 77, 78]);
  assert.equal(await out.getChannelAuthorId(9), null);
  assert.deepEqual(out.calls.map(x => x[0]), ["get_basic_chat_info"]); // no contact lookup
});

test("chat items carry the core chatType so the header can tell in/out channels apart", () => {
  const c = new JsonRpcCore({});
  const item = c._mapChatListItem({ id: 5, name: "News", chatType: "InBroadcast", summaryText1: "", summaryText2: "" });
  assert.equal(item.kind, "channel");
  assert.equal(item.chatType, "InBroadcast");
});

test("header button: accessible, hidden by default, wired to the author lookup", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(html, /id="btn-channel-author"[^>]*title="Message author"[^>]*aria-label="Message author"[^>]*\bhidden\b/);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /refreshChannelAuthorButton\(chat, current\);/);
  assert.match(app, /core\.getChannelAuthorId\(chatId\)/);
  assert.match(app, /if \(!authorId \|\| authorId === 1\) return;/);
  assert.match(app, /btn\.onclick = \(\) => openDirectChat\(authorId\);/);
  assert.match(app, /hideChannelAuthorButton\(\);\n  renderChatList\(\);/); // closeChatUI resets it
});
