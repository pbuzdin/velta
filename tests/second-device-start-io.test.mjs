import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// #118: after a second-device transfer the received profile must go online
// without a core restart. The core skips start_io on the still-unconfigured
// account at boot, so the client has to start it once get_backup finishes.

function fakeCore({ accountId = 5, syncOnlyActive = false, kind = "Unconfigured" } = {}) {
  const calls = [];
  let finish;
  const done = new Promise(r => { finish = r; });
  const self = {
    accountId,
    syncOnlyActive,
    _beginAccountChange() {},
    async _finishAccountChange() {},
    _tunnelReapply() { calls.push(["tunnel_reapply"]); finish(); },
    async _call(m, ...a) {
      calls.push([m, ...a]);
      if (m === "get_account_info") return { kind };
      if (m === "add_account") return 9;
      return null;
    },
  };
  self._afterBackupReceived = JsonRpcCore.prototype._afterBackupReceived;
  return { self, calls, done };
}

test("a received transfer starts IO on the new account, then fixes the proxy", async () => {
  const { self, calls, done } = fakeCore();
  assert.equal(await JsonRpcCore.prototype.addAccountWithBackup.call(self, "DCBACKUP2:x"), 5);
  await done;
  const after = calls.slice(calls.findIndex(c => c[0] === "get_backup") + 1).map(c => c.slice(0, 2));
  assert.deepEqual(after, [["start_io", 5], ["maybe_network"], ["tunnel_reapply"]]);
});

test("a transfer into a freshly added account starts IO on that account", async () => {
  const { self, calls, done } = fakeCore({ kind: "Configured" });
  assert.equal(await JsonRpcCore.prototype.addAccountWithBackup.call(self, "DCBACKUP2:x"), 9);
  await done;
  assert.ok(calls.some(c => c[0] === "start_io" && c[1] === 9));
});

test("sync-only mode skips IO when the user already switched away", async () => {
  const { self, calls } = fakeCore({ syncOnlyActive: true });
  self.accountId = 2;
  await self._afterBackupReceived(5);
  assert.deepEqual(calls.map(c => c[0]), ["tunnel_reapply"]);
});

test("a failed transfer starts nothing", async () => {
  const { self, calls } = fakeCore();
  self._call = async (m, ...a) => {
    calls.push([m, ...a]);
    if (m === "get_account_info") return { kind: "Unconfigured" };
    if (m === "get_backup") throw new Error("cancelled");
    return null;
  };
  await JsonRpcCore.prototype.addAccountWithBackup.call(self, "DCBACKUP2:x");
  await new Promise(r => setTimeout(r, 10));
  assert.ok(!calls.some(c => c[0] === "start_io"));
});
