import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore, SEND_TRANSPORT_KEY, SEND_TRANSPORT_MIGRATED_KEY } from "../app/js/rpc-core.js";

// VENDORISSUES #11: "Use for sending" pins the SMTP transport through the
// Velta-owned ui key (core patch #11 reads it), not configured_addr, which
// upstream #8711 removes. These tests pin the JS contract on both core shapes.

const A = 1;

// A fake JSON-RPC backend: `hasConfiguredAddr=false` behaves like a core with
// #8711 merged (set/get_config("configured_addr") -> unknown key).
function fixture({ transports = ["a@one.example", "b@two.example"], configured = transports[0], config = {}, hasConfiguredAddr = true } = {}) {
  const core = new JsonRpcCore({});
  core.accountId = A;
  const calls = [];
  const cfg = { ...config };
  let configuredAddr = configured;
  let list = transports.map(addr => ({ addr }));
  core._call = async (method, ...params) => {
    calls.push([method, ...params]);
    const [, key, value] = params;
    switch (method) {
      case "get_config":
        if (key === "configured_addr") {
          if (!hasConfiguredAddr) throw new Error(`unknown key "configured_addr": Matching variant not found`);
          return configuredAddr;
        }
        if (!key.startsWith("ui.")) throw new Error(`unexpected key ${key}`);
        return cfg[key] ?? null;
      case "set_config":
        if (key === "configured_addr") {
          if (!hasConfiguredAddr) throw new Error(`unknown key "configured_addr": Matching variant not found`);
          if (!list.some(t => t.addr === value)) throw new Error("Address does not belong to any transport.");
          configuredAddr = value;
          return;
        }
        if (!key.startsWith("ui.")) throw new Error(`unexpected key ${key}`);
        if (value === null) delete cfg[key]; else cfg[key] = value;
        return;
      case "list_transports": return list;
      case "delete_transport": list = list.filter(t => t.addr !== params[1]); return;
      case "get_account_info": return { kind: "Configured" };
      case "get_contact": return { id: 1, color: "#123456", profileImage: null };
      case "get_all_account_ids": return [A];
      default: throw new Error(`Unexpected RPC: ${method}`);
    }
  };
  return { core, calls, cfg, get configuredAddr() { return configuredAddr; } };
}

test("setSendRelay writes the ui pin and keeps configured_addr in sync on 2.63", async () => {
  const f = fixture();
  await f.core.setSendRelay("b@two.example");
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], "b@two.example");
  assert.equal(f.configuredAddr, "b@two.example");
});

test("setSendRelay survives a core without configured_addr (#8711): only the pin is written", async () => {
  const f = fixture({ hasConfiguredAddr: false });
  await f.core.setSendRelay("b@two.example");
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], "b@two.example");
});

test("setSendRelay surfaces real validation errors and does not write the pin", async () => {
  const f = fixture();
  await assert.rejects(f.core.setSendRelay("nope@x.example"), /does not belong/);
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], undefined);
});

test("getAccount reports the pin as the sending address", async () => {
  const f = fixture({ config: { [SEND_TRANSPORT_KEY]: "b@two.example", [SEND_TRANSPORT_MIGRATED_KEY]: "1" } });
  const acc = await f.core.getAccount();
  assert.equal(acc.addr, "b@two.example");
  assert.equal(acc.relay, "two.example");
});

test("getAccount falls back to configured_addr, then to the first transport (#8711)", async () => {
  assert.equal((await fixture({ configured: "a@one.example" }).core.getAccount()).addr, "a@one.example");
  assert.equal((await fixture({ hasConfiguredAddr: false }).core.getAccount()).addr, "a@one.example");
});

test("a stale pin naming a removed relay is not shown as the sending address", async () => {
  const f = fixture({ config: { [SEND_TRANSPORT_KEY]: "gone@x.example", [SEND_TRANSPORT_MIGRATED_KEY]: "1" } });
  assert.equal((await f.core.getAccount()).addr, "a@one.example");
});

test("migration adopts a non-first configured_addr once", async () => {
  const f = fixture({ configured: "b@two.example" });
  await f.core.getAccount();
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], "b@two.example");
  assert.equal(f.cfg[SEND_TRANSPORT_MIGRATED_KEY], "1");
  // Done once: the user later clears the pin; it is not re-adopted.
  delete f.cfg[SEND_TRANSPORT_KEY];
  f.core._sendPinMigrated = null;
  await f.core.getAccount();
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], undefined);
});

test("migration leaves a first-transport configured_addr unpinned (upstream order)", async () => {
  const f = fixture({ configured: "a@one.example" });
  await f.core.getAccount();
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], undefined);
  assert.equal(f.cfg[SEND_TRANSPORT_MIGRATED_KEY], "1");
});

test("migration never overrides an existing pin and works without configured_addr", async () => {
  const f = fixture({ configured: "b@two.example", config: { [SEND_TRANSPORT_KEY]: "a@one.example" } });
  await f.core.getAccount();
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], "a@one.example");
  const g = fixture({ hasConfiguredAddr: false });
  await g.core.getAccount();
  assert.equal(g.cfg[SEND_TRANSPORT_KEY], undefined);
  assert.equal(g.cfg[SEND_TRANSPORT_MIGRATED_KEY], "1");
});

test("deleteTransport clears a pin on the removed relay, keeps other pins", async () => {
  const f = fixture({ transports: ["a@one.example", "b@two.example", "c@three.example"], config: { [SEND_TRANSPORT_KEY]: "B@two.example" } });
  await f.core.deleteTransport("b@two.example");
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], undefined);
  f.cfg[SEND_TRANSPORT_KEY] = "a@one.example";
  await f.core.deleteTransport("c@three.example");
  assert.equal(f.cfg[SEND_TRANSPORT_KEY], "a@one.example");
});

test("getAllAccounts reads the pin per account", async () => {
  const f = fixture({ config: { [SEND_TRANSPORT_KEY]: "b@two.example" } });
  const [row] = await f.core.getAllAccounts();
  assert.equal(row.addr, "b@two.example");
});
