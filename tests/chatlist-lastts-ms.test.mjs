import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// core's jsonrpc ChatListItem.lastUpdated is milliseconds (get_timestamp()*1000);
// multiplying again gave years like 58757 in the chat list.
test("chat list lastTs uses core lastUpdated as ms without rescaling", () => {
  const src = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  assert.ok(!/lastUpdated\s*\*\s*1000/.test(src));
  assert.match(src, /lastTs: c\.lastUpdated \|\| 0/);
});
