import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const A = 1;
const CHAT = 10;
const MSG = 20;

const wait = ms => new Promise(r => setTimeout(r, ms));

async function eventually(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("eventually: condition not met");
    await new Promise(r => setImmediate(r));
  }
}

function stubShell(mode) {
  const readyCalls = [];
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          if (cmd === "get_event_reader_mode") return mode;
          if (cmd === "events_listener_ready") readyCalls.push(args);
          return null;
        },
      },
    },
  };
  return readyCalls;
}

function wire(t, core) {
  const transport = {
    sent: [],
    receive: null,
    setReceiver(fn) { this.receive = fn; },
    send(line) { this.sent.push(JSON.parse(line)); },
  };
  core.transport = transport;
  transport.setReceiver(core._onLine);
  const events = [];
  core.addEventListener("msg-state", e => events.push(e.detail));
  // Park the poll loop once assertions are done so no timers remain.
  t.after(async () => {
    core._callEventPoll = () => new Promise(() => {});
    if (transport.sent.length) {
      transport.receive(JSON.stringify({ jsonrpc: "2.0", id: transport.sent.at(-1).id, result: [] }));
      await eventually(() => core.pending.size === 0);
    }
    await wait(260);
    delete globalThis.window;
  });
  return { transport, events };
}

test("single-reader mode: the page skips its poll and hands the shell visibility (#40/#52)", async t => {
  const readyCalls = stubShell("rust");
  globalThis.document = { hidden: false };
  const core = new JsonRpcCore({ setReceiver() {} });
  core.accountId = A;
  const { transport, events } = wire(t, core);

  await core._pollEvents(); // must return without starting the loop

  assert.deepEqual(readyCalls, [{ visible: true }], "handshake fired once with visibility");
  assert(!transport.sent.some(r => r.method === "get_next_event_batch"), "no JS event poll");

  // While the JS poll is off, shell-forwarded batches still drive the page.
  const forwarded = {
    jsonrpc: "2.0",
    method: "velta_core_events",
    params: [[{ contextId: A, event: { kind: "MsgDelivered", chatId: CHAT, msgId: MSG } }]],
  };
  transport.receive(JSON.stringify(forwarded));
  await eventually(() => events.length >= 1);
  assert.equal(events.at(-1).msgId, MSG);
  delete globalThis.document;
});

test("webview mode: the JS poll keeps running (desktop, or shell without the command)", async t => {
  const readyCalls = stubShell("webview");
  const core = new JsonRpcCore({ setReceiver() {} });
  core.accountId = A;
  const { transport } = wire(t, core);

  core._pollEvents();
  await eventually(() => transport.sent.some(r => r.method === "get_next_event_batch"));
  assert.deepEqual(readyCalls, [], "no handshake outside single-reader mode");
});

test("shell probe failure falls back to the JS poll (old shell, tests)", async t => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => { throw new Error("no such command"); } } } };
  const core = new JsonRpcCore({ setReceiver() {} });
  core.accountId = A;
  const { transport } = wire(t, core);

  core._pollEvents();
  await eventually(() => transport.sent.some(r => r.method === "get_next_event_batch"));
});
