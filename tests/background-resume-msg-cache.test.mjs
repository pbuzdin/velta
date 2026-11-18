import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// #411: the Android background poller consumes core events while the page
// is hidden, so the id-list invalidations those events drive never reach
// JS. Resume must drop the per-chat id caches, or a message that arrived
// in the background shows in the chat list (fresh refetch) but not in the
// chat (stale cached id list, re-pinned on every read).

const CHAT = 10;

function message(id) {
  return { kind: "message", id, chatId: CHAT, fromId: 2, state: 10, text: `m${id}`, timestamp: 1 };
}

function fixture() {
  const core = new JsonRpcCore({});
  core.accountId = 1;
  let ids = [20, 21];
  const idCalls = [];
  core._call = async (method, _account, ...params) => {
    if (method === "get_message_ids") {
      idCalls.push(ids.slice());
      return ids.slice();
    }
    if (method === "get_messages") {
      const out = {};
      for (const id of params[0]) out[String(id)] = message(id);
      return out;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  return { core, idCalls, setIds: next => { ids = next; } };
}

test("resume invalidation refetches the id list a background poller starved", async () => {
  const { core, idCalls, setIds } = fixture();
  await core.getMessages(CHAT, { limit: 40 });
  assert.deepEqual(idCalls.length, 1);

  // Message arrives while hidden: core has it, no event reaches JS.
  setIds([20, 21, 22]);
  const stale = await core.getMessages(CHAT, { limit: 40 });
  assert.deepEqual(idCalls.length, 1, "stale read served from cache (the bug)");
  assert.equal(stale.messages.some(m => m.id === 22), false);

  // Resume: refreshAfterBackground() drops the caches; the same read now sees it.
  core.invalidateAllChats();
  const fresh = await core.getMessages(CHAT, { limit: 40 });
  assert.deepEqual(idCalls.length, 2);
  assert.equal(fresh.messages.some(m => m.id === 22), true);
});

test("invalidateAllChats bumps the generation so an in-flight id fetch is not cached", async () => {
  const { core, idCalls } = fixture();
  const inFlight = core.getMessageIds(CHAT);
  core.invalidateAllChats();
  await inFlight;
  await core.getMessageIds(CHAT);
  assert.deepEqual(idCalls.length, 2, "pre-clear result must not be pinned");
});

test("refreshAfterBackground wires the invalidation before the refetches", () => {
  const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
  const app = strip(readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8"));
  const body = app.slice(app.indexOf("function refreshAfterBackground"), app.indexOf("function reportUiVisible"));
  assert.match(body, /core\.invalidateAllChats\?\.\(\)/);
  const after = body.indexOf("core.invalidateAllChats");
  assert.ok(after >= 0 && after < body.indexOf("scheduleChatListRefresh()"), "before the refetches");
});
