import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { MockCore } from "../app/js/mock-core.js";

// Issue #13: the archived-chats folder button rides getChatList's list_flags.
// Flag value matters: DC_GCL_ARCHIVED_ONLY is 0x01 — 0x02 is DC_GCL_NO_SPECIALS
// and silently returns the UNARCHIVED list (archived chats became unfindable).
test("rpc-core getChatList passes DC_GCL_ARCHIVED_ONLY only when asked", async () => {
  const calls = [];
  class Probe extends JsonRpcCore {
    async _call(method, ...args) {
      calls.push([method, ...args]);
      if (method === "get_chatlist_entries") return [];
      return null;
    }
  }
  const core = new Probe();
  core.accountId = 7;
  await core.getChatList({ archived: true });
  await core.getChatList();
  assert.deepEqual(calls[0], ["get_chatlist_entries", 7, 1, null, null]);
  assert.deepEqual(calls[1], ["get_chatlist_entries", 7, null, null, null]);
});

test("mock getChatList filters archived chats", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref();
  const archived = await mock.getChatList({ archived: true });
  assert.ok(archived.length >= 1, "demo ships archived chats");
  assert.ok(archived.every(c => c.archived));
  const all = await mock.getChatList();
  assert.ok(all.every(c => !c.archived));
});

// Delta Chat pattern: an "Archived chats (N)" row closes the main list and
// opens the search screen's Archived tab. Updated in place, no list rebuild.
test("chat list ends with an archived-chats row bound to the archived tab", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function syncArchivedLink()"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /archivedCount > 0/);
  assert.match(body, /createElement\("button"\)/);
  assert.match(body, /t\("Archived chats \(\{n\}\)"/);
  assert.match(body, /setAttribute\("aria-label", label\)/);
  assert.match(body, /searchScreenTab = "archived"; setListView\("search"\)/);
  assert.match(body, /ICON\.archive/);
  assert.match(src, /archivedCount = n;\s*syncHeaderButtons\(\);\s*syncArchivedLink\(\);/);
  assert.match(src, /child\.id === "archived-link"/, "renderChatList keeps the row");
});
