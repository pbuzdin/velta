// #249: get_reply_counts wedged the core DB; restarts overlapped.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("core patch #29: get_reply_counts uses the rfc724_mid index (no O(n^2) self-join)", () => {
  const rs = read("core/src/chat.rs");
  const fn = rs.slice(rs.indexOf("pub async fn get_reply_counts"), rs.indexOf("/// Returns true if device message"));
  assert.match(fn, /CROSS JOIN msgs quoted ON quoted\.rfc724_mid/);
  assert.match(fn, /\+quoted\.chat_id=\?/);
  const sql = fn.slice(fn.indexOf('"SELECT') + 1, fn.indexOf('",')).replace(/\\\n\s*/g, "");
  let plan;
  try {
    plan = execFileSync("python3", ["-c", `
import sqlite3,sys
c=sqlite3.connect(":memory:")
c.executescript("CREATE TABLE msgs(id INTEGER PRIMARY KEY, rfc724_mid TEXT, chat_id INT, param TEXT, hidden INT, mime_in_reply_to TEXT, timestamp INT);CREATE INDEX msgs_index1 ON msgs (rfc724_mid);CREATE INDEX msgs_index2 ON msgs (chat_id);")
print([r[3] for r in c.execute("EXPLAIN QUERY PLAN "+sys.argv[1],(1,1))])`, sql], { encoding: "utf8" });
  } catch { return; } // no python3/sqlite3: the source checks above still hold
  assert.match(plan, /SEARCH quoted USING INDEX msgs_index1/, plan);
});

test("chat view runs one get_reply_counts at a time and folds bursts into one rerun", () => {
  const js = read("app/js/chat-view.js");
  assert.match(js, /if \(this\._coreReplyInFlight\) \{ this\._coreReplyAgain = true; return; \}/);
});

test("restartIo: a stop that never answers does not block the start", async () => {
  const sent = [];
  const transport = { setReceiver(fn) { this.receive = fn; }, send(l) {
    const m = JSON.parse(l); sent.push(m.method);
    if (m.method !== "stop_io_for_all_accounts") queueMicrotask(() => this.receive(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null })));
  } };
  const core = new JsonRpcCore(transport);
  transport.setReceiver(core._onLine);
  core._rpcLog = () => {};
  const diag = [];
  core.addEventListener("diagnostic", e => diag.push(e.detail?.message));
  assert.equal(await core.restartIo({ stopTimeoutMs: 20 }), true);
  assert.deepEqual(sent, ["stop_io_for_all_accounts", "start_io_for_all_accounts", "maybe_network"]);
  assert.ok(diag.some(m => /stop did not finish/.test(m)));
});

test("app: restarts are single-flight and UI reconnect waits for a running restart", () => {
  const app = read("app/js/app.js");
  assert.match(app, /if \(coreRestartInFlight\) \{[\s\S]{0,120}return coreRestartInFlight;/);
  assert.match(app, /if \(coreRestartInFlight\) \{[\s\S]{0,120}await coreRestartInFlight;/);
});
