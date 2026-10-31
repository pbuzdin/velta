// Refs #176: chat-open stall diagnostics and recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JsonRpcCore } from "../app/js/rpc-core.js";

function setup() {
  const transport = { sent: [], receive: null, setReceiver(fn) { this.receive = fn; }, send(line) { this.sent.push(JSON.parse(line)); } };
  const core = new JsonRpcCore(transport);
  core.accountId = 1;
  transport.setReceiver(core._onLine);
  const logs = [];
  core._rpcLog = m => logs.push(m);
  const respond = (req, result) => transport.receive(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
  return { core, transport, logs, respond };
}

test("slow rpc logs its method and duration", async () => {
  const { core, transport, logs, respond } = setup();
  core.slowRpcMs = 0;
  const p = core._callWithTimeout(1000, "get_messages", 1, [5]);
  respond(transport.sent[0], { ok: 1 });
  assert.deepEqual(await p, { ok: 1 });
  assert.match(logs[0], /^rpc slow: get_messages took \d+ ms$/);
});

test("fast rpc logs nothing", async () => {
  const { core, transport, logs, respond } = setup();
  const p = core._callWithTimeout(1000, "get_chat", 1);
  respond(transport.sent[0], 1);
  await p;
  assert.deepEqual(logs, []);
});

test("timeout logs, and a late answer logs rpc late", async () => {
  const { core, transport, logs, respond } = setup();
  await assert.rejects(core._callWithTimeout(5, "get_message_ids", 1, 2), /rpc timeout: get_message_ids/);
  assert.ok(logs.some(l => /^rpc timeout: get_message_ids after \d+ ms/.test(l)));
  respond(transport.sent[0], []);
  assert.ok(logs.some(l => /^rpc late: get_message_ids answered after \d+ ms$/.test(l)));
});

test("getChat does not chain fallbacks after a timeout", async () => {
  const { core, transport } = setup();
  core._call = (method, ...a) => core._callWithTimeout(5, method, ...a);
  await assert.rejects(core.getChat(7), /rpc timeout/);
  assert.deepEqual(transport.sent.map(r => r.method), ["get_chatlist_items_by_entries"]);
});

test("openChat releases its same-chat guard on a stall and logs steps", () => {
  const src = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function openChat("), src.indexOf("function closeChat()"));
  assert.match(body, /guard released/);
  assert.match(body, /state\.pendingChatId = null;\s*renderChatList\(\);\s*\}, \d+\)/);
  assert.match(body, /clearTimeout\(guard\)/);
  assert.match(body, /open chat \$\{chatId\}: \$\{name\} took \$\{ms\} ms/);
});

test("re-tapping a chat joins the pending getChat instead of a new RPC", async () => {
  const { core, transport, respond } = setup();
  const a = core.getChat(7), b = core.getChat(7);
  assert.equal(a, b);
  assert.equal(transport.sent.length, 1);
  respond(transport.sent[0], { 7: { kind: "Error", error: "x" } });
  await a.catch(() => {});
  core.getChat(7).catch(() => {});
  assert.equal(transport.sent.filter(r => r.method === "get_chatlist_items_by_entries").length, 2);
});

test("a timeout line names the oldest calls still in flight", async () => {
  const { core, logs } = setup();
  core._callWithTimeout(60000, "get_chatlist_items_by_entries", 1, [3]).catch(() => {});
  await assert.rejects(core._callWithTimeout(5, "get_chat", 1), /rpc timeout/);
  assert.ok(logs.some(l => /still pending; oldest: get_chatlist_items_by_entries \d/.test(l)), logs.join("\n"));
  for (const e of core.pending.values()) e.reject(new Error("done"));
  core.pending.clear();
});
