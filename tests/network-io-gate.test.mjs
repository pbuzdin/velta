import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// #28: connectivity gate on the core's IO loops. setNetworkIo(false) stops
// IO (airplane mode / no interface — stop the IMAP/SMTP retry storms);
// setNetworkIo(true) restarts it with a maybe_network nudge. Both
// transitions are announced on the diagnostics channel. reconnect() must
// not leave IO armed on an offline device.

function setup() {
  const transport = {
    sent: [],
    receive: null,
    setReceiver(fn) { this.receive = fn; },
    send(line) { this.sent.push(JSON.parse(line)); },
  };
  const core = new JsonRpcCore(transport);
  transport.setReceiver(core._onLine);
  const diagnostics = [];
  core.addEventListener("diagnostic", e => diagnostics.push(e.detail.message));
  const methods = () => transport.sent.filter(m => m.method).map(m => m.method);
  const respondAll = () => {
    for (const m of transport.sent) {
      if (m.id != null && !m.responded) {
        m.responded = true;
        transport.receive(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }));
      }
    }
  };
  // Yield macrotasks so pending calls hit the transport, then answer them;
  // a single synchronous respondAll races the awaited call chain.
  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setImmediate(r));
      respondAll();
    }
  };
  return { core, transport, diagnostics, methods, respondAll, flush };
}

test("#28 offline: setNetworkIo(false) stops IO and announces the pause", async () => {
  const { core, diagnostics, methods, flush } = setup();
  const p = core.setNetworkIo(false);
  await flush();
  assert.ok(await p);
  assert.deepEqual(methods(), ["stop_io_for_all_accounts"]);
  assert.ok(diagnostics.some(m => m.includes("I/O paused")));
});

test("#28 back online: setNetworkIo(true) restarts IO + nudge and announces it", async () => {
  const { core, diagnostics, methods, flush } = setup();
  const p = core.setNetworkIo(true);
  await flush();
  assert.ok(await p);
  assert.deepEqual(methods(), ["start_io_for_all_accounts", "maybe_network"]);
  assert.ok(diagnostics.some(m => m.includes("I/O resumed")));
});

test("#28 reconnect pauses IO again when the device is offline", async () => {
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  try {
    const { core, transport, methods, flush } = setup();
    transport.reconnect = async () => true;
    const p = core.reconnect();
    await flush();
    assert.ok(await p);
    assert.deepEqual(methods(), [
      "select_account",
      "start_io_for_all_accounts",
      "stop_io_for_all_accounts",
    ]);
  } finally {
    if (saved === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { value: saved, configurable: true });
  }
});

test("#28 reconnect leaves IO armed when the device is online", async () => {
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  try {
    const { core, transport, methods, flush } = setup();
    transport.reconnect = async () => true;
    const p = core.reconnect();
    await flush();
    assert.ok(await p);
    assert.deepEqual(methods(), ["select_account", "start_io_for_all_accounts"]);
  } finally {
    if (saved === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { value: saved, configurable: true });
  }
});
