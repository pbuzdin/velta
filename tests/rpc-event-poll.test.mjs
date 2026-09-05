import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const A = 1;
const B = 2;
const CHAT = 10;
const MSG = 20;

const wait = ms => new Promise(r => setTimeout(r, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Poll condition until it holds (real timers; the poll loop runs on real timers too).
async function eventually(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("eventually: condition not met");
    await new Promise(r => setImmediate(r));
  }
}

// Real transport stub: responses are injected by the test via respond().
// pollTimeoutMs shrinks the 240 s backstop to test scale.
function setup(t, { pollTimeoutMs = 30 } = {}) {
  const transport = {
    sent: [],
    receive: null,
    setReceiver(fn) { this.receive = fn; },
    send(line) { this.sent.push(JSON.parse(line)); },
  };
  const core = new JsonRpcCore(transport);
  core.accountId = A;
  core.eventPollTimeoutMs = pollTimeoutMs;
  transport.setReceiver(core._onLine);
  const events = [];
  const diagnostics = [];
  core.addEventListener("msg-state", e => events.push(e.detail));
  core.addEventListener("diagnostic", e => diagnostics.push(e.detail.message));
  const respond = (request, result) =>
    transport.receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  // Park the poll loop once assertions are done: the next iteration awaits
  // forever, so no timers remain and the test process can exit.
  const park = async () => {
    core._callEventPoll = () => new Promise(() => {});
    respond(transport.sent.at(-1), delivered);
    await eventually(() => core.pending.size === 0);
    await new Promise(r => setTimeout(r, 260)); // loop reaches the parked poll
  };
  t.after(park);
  return { core, transport, events, diagnostics, respond, park };
}

const delivered = { contextId: A, event: { kind: "MsgDelivered", chatId: CHAT, msgId: MSG } };
const read = { contextId: A, event: { kind: "MsgRead", chatId: CHAT, msgId: MSG } };

test("a late response to an expired long poll is dispatched, not dropped", async t => {
  const { core, transport, events, diagnostics, respond, park } = setup(t);
  void core._pollEvents();

  // Backstop fires: the poll re-issues while the backend still holds the
  // first waiter — the idle scenario that used to lose the event handed to
  // the forgotten request.
  await eventually(() => transport.sent.length >= 2);
  assert.equal(transport.sent[0].method, "get_next_event");
  assert.ok(diagnostics.some(m => m.includes("rpc timeout: get_next_event")));

  // The backend answers the OLD waiter; the entry was kept for salvage.
  transport.receive(JSON.stringify({ jsonrpc: "2.0", id: transport.sent[0].id, result: read }));
  await eventually(() => events.length >= 1);
  assert.deepEqual(events[0], { chatId: CHAT, msgId: MSG, state: "read" });

  // The re-issued poll is answered through the normal path.
  transport.receive(JSON.stringify({ jsonrpc: "2.0", id: transport.sent[1].id, result: read }));
  await eventually(() => events.length >= 2);
  assert.deepEqual(events[1], { chatId: CHAT, msgId: MSG, state: "read" });

  await park();
  assert.equal(core.pending.size, 0, "answered entries must be settled and cleared");
});

test("salvaged events still respect account attribution and the epoch", async t => {
  const { core, transport, events, respond, park } = setup(t);
  void core._pollEvents();
  await eventually(() => transport.sent.length >= 2);

  // Foreign account: reaches the dispatcher but is filtered — no UI event.
  transport.receive(JSON.stringify({
    jsonrpc: "2.0", id: transport.sent[0].id,
    result: { contextId: B, event: { kind: "MsgDelivered", chatId: CHAT, msgId: MSG } },
  }));
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(events, []);

  // Current account at dispatch, but the epoch advances while the event's
  // async decoration is in flight: the late result must be suppressed.
  const gate = deferred();
  const rawMessage = { kind: "message", id: MSG, chatId: CHAT, fromId: 1, state: 26, text: "x", timestamp: 1 };
  const originalCall = core._call;
  core._call = (method, ...params) => method === "get_message"
    ? (core.calls?.push?.([method, ...params]), gate.promise)
    : JsonRpcCore.prototype._call.call(core, method, ...params);
  transport.receive(JSON.stringify({
    jsonrpc: "2.0", id: transport.sent[1].id,
    result: { contextId: A, event: { kind: "IncomingMsg", chatId: CHAT, msgId: MSG } },
  }));
  // Let the dispatcher reach the parked get_message, then switch accounts.
  await new Promise(r => setTimeout(r, 40));
  core.accountEpoch += 2; // A -> B -> A equivalent
  gate.resolve(rawMessage);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(events, [], "stale-epoch decoration must not reach the UI");
  core._call = originalCall;

  await park();
});

test("reconnect fails parked and salvaged polls and the loop recovers", async t => {
  const { core, transport, diagnostics, respond, park } = setup(t);
  void core._pollEvents();
  await eventually(() => transport.sent.length >= 2);

  transport.reconnect = async () => true;
  core._call = async method => {
    if (method === "select_account" || method === "start_io_for_all_accounts") return;
    throw new Error(`unexpected RPC: ${method}`);
  };
  assert.equal(await core.reconnect(), true);

  // The dead connection's pending calls were failed, including the salvaged
  // long poll; the loop re-polls on the fresh transport.
  assert.ok(diagnostics.includes("Event polling failed: reconnecting"));
  await eventually(() => transport.sent.length >= 3);
  assert.equal(transport.sent[2].method, "get_next_event");

  await park();
});
