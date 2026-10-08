import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// #100: in-app profile deletion. The deleteAccount wrapper rides the same
// epoch boundaries as switchAccount; deleting the selected account follows
// the core's reconciled selection.

class Probe extends JsonRpcCore {
  constructor(accounts, selected, { busy = false } = {}) {
    super();
    this.accountId = selected;
    this.accountEpoch = 0;
    if (busy) this._accountTransitionBusy = true;
    this._accounts = accounts; // mutable list the fake core reconciles
    this._selected = selected;
    this.calls = [];
  }
  async _call(method, ...args) {
    this.calls.push([method, ...args]);
    switch (method) {
      case "remove_account": {
        const id = Number(args[0]);
        if (!this._accounts.includes(id)) throw new Error("no such account");
        this._accounts = this._accounts.filter(a => a !== id);
        // core reconciles selection when the selected account is removed
        if (this._selected === id) this._selected = this._accounts[0] ?? null;
        return null;
      }
      case "get_all_account_ids": return [...this._accounts];
      case "get_selected_account_id": return this._selected;
      case "select_account": this._selected = Number(args[0]); return null;
      case "get_contact": return { color: "#5aa2e6", profileImage: null };
      default: return null;
    }
  }
  async getAccount() {
    return { id: this.accountId, addr: "x@test.run", displayName: "X" };
  }
}

test("deleteAccount: background deletion keeps the selection, returns null", async () => {
  const core = new Probe([1, 2, 3], 1);
  const r = await core.deleteAccount(2);
  assert.equal(r, null);
  assert.deepEqual(core.calls.filter(c => c[0] === "remove_account"), [["remove_account", 2]]);
  assert.equal(core._selected, 1, "selection untouched");
  assert.equal(core.calls.some(c => c[0] === "select_account"), false);
  assert.equal(core._accountTransitionBusy, false, "transition released");
});

test("deleteAccount: deleting the selected account follows the reconciled selection", async () => {
  const core = new Probe([1, 2, 3], 2);
  const r = await core.deleteAccount(2);
  assert.deepEqual(r, { id: 1, addr: "x@test.run", displayName: "X" });
  assert.equal(core._selected, 1);
  assert.equal(core.accountId, 1);
  assert.ok(core.accountEpoch > 0, "epoch advanced for the UI refresh");
});

test("deleteAccount: refuses the last remaining profile", async () => {
  const core = new Probe([7], 7);
  await assert.rejects(() => core.deleteAccount(7), /last remaining profile/);
  assert.equal(core._accountTransitionBusy, false);
});

test("deleteAccount: guarded during an account transition", async () => {
  const core = new Probe([1, 2], 1, { busy: true });
  await assert.rejects(() => core.deleteAccount(2), /transition already in progress/);
  assert.equal(core.calls.length, 0, "no RPC issued while busy");
});

test("MockCore twin refuses (the demo always has exactly one profile)", async () => {
  const { MockCore } = await import("../app/js/mock-core.js");
  const mock = new MockCore();
  mock._simTimer?.unref();
  await assert.rejects(() => mock.deleteAccount(1), /last remaining profile/);
});
