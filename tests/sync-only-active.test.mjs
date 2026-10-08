import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// #101 "sync only active profile": when the flag is set, only the selected
// account runs mail IO — boot, reconnect, network-gate and account switches
// all funnel through _startIo; switches stop the OLD account's IO only after
// the selection committed.

class Probe extends JsonRpcCore {
  constructor() {
    super();
    this.calls = [];
    this.accountId = 1;
    this.accountEpoch = 0;
  }
  async _call(method, ...args) {
    this.calls.push([method, ...args]);
    if (method === "get_all_account_ids") return [1, 2, 3];
    return null;
  }
  async getAccount() { return { id: this.accountId }; }
}

const names = core => core.calls.map(c => c[0]);
const argsOf = (core, method) => core.calls.filter(c => c[0] === method).map(c => c.slice(1));

test("default (flag off): start paths use start_io_for_all_accounts", async () => {
  const core = new Probe();
  await core._startIo();
  await core.applySyncMode();
  assert.deepEqual(names(core), ["start_io_for_all_accounts", "start_io_for_all_accounts"]);
});

test("flag on: start paths start only the selected account", async () => {
  const core = new Probe();
  core.syncOnlyActive = true;
  core.accountId = 5;
  await core._startIo();
  await core.applySyncMode();
  assert.deepEqual(argsOf(core, "start_io"), [[5]]);
  assert.deepEqual(argsOf(core, "stop_io"), [[1], [2], [3]].filter(x => x[0] !== 5), "non-selected accounts quiesced");
  assert.equal(names(core).includes("start_io_for_all_accounts"), false);
});

test("switch with flag on: stop old IO strictly after the switch committed", async () => {
  const core = new Probe();
  core.syncOnlyActive = true;
  await core.switchAccount(2);
  const seq = names(core);
  const select = seq.indexOf("select_account");
  const stop = seq.indexOf("stop_io");
  const start = seq.indexOf("start_io");
  assert.ok(select !== -1 && select < stop && stop < start, `select < stop < start, got ${seq.join(",")}`);
  assert.deepEqual(argsOf(core, "stop_io"), [[1]]);
  assert.deepEqual(argsOf(core, "start_io"), [[2]]);
});

test("switch with flag off: no per-account IO calls (unchanged behavior)", async () => {
  const core = new Probe();
  await core.switchAccount(2);
  assert.equal(names(core).includes("stop_io"), false);
  assert.equal(names(core).includes("start_io"), false);
});

test("init reads the persisted flag before starting IO (guarded without localStorage)", async () => {
  const core = new Probe();
  // no localStorage in Node — the guarded read must not throw
  await core._startIo();
  assert.deepEqual(names(core), ["start_io_for_all_accounts"]);
});
