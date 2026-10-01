import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const A = 1;
const CHAT = 13;

// The core's MuteDuration is an internally tagged enum (#[serde(tag =
// "kind")]): the wire value must be {kind: ...}, not a bare string — a bare
// "Forever" fails deserialization and the mute silently does nothing
// (device-found bug behind the #52 mute-gate check).
function setup(t) {
  const transport = {
    sent: [],
    setReceiver(fn) { this.receive = fn; },
    send(line) {
      const req = JSON.parse(line);
      this.sent.push(req);
      // Answer immediately so the awaited _call resolves.
      if (req.method !== "get_next_event_batch") {
        this.receive(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
      }
    },
  };
  const core = new JsonRpcCore(transport);
  core.accountId = A;
  transport.setReceiver(core._onLine);
  return { core, transport };
}

function muteCalls(transport) {
  return transport.sent
    .filter(x => x.method === "set_chat_mute_duration")
    .map(x => x.params[2]);
}

test("setChatFlags({muted}) sends internally tagged MuteDuration values", async t => {
  const { core, transport } = setup(t);
  await core.setChatFlags(CHAT, { muted: true });
  await core.setChatFlags(CHAT, { muted: false });
  assert.deepEqual(muteCalls(transport), [{ kind: "Forever" }, { kind: "NotMuted" }]);
});

test("setChatMuted sends tagged NotMuted/Forever/Until shapes", async t => {
  const { core, transport } = setup(t);
  await core.setChatMuted(CHAT, 60 * 60);
  await core.setChatMuted(CHAT, -1);
  await core.setChatMuted(CHAT, 0);
  assert.deepEqual(muteCalls(transport), [
    { kind: "Until", duration: 3600 },
    { kind: "Forever" },
    { kind: "NotMuted" },
  ]);
});
