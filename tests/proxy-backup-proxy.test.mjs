import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

// A backup or second-device transfer must never carry this device's proxy,
// and a restored profile gets its proxy fixed right away.
function withShell(fn) {
  const calls = [];
  globalThis.window = { __TAURI__: { core: { invoke: async (cmd, args) => { calls.push([cmd, args]); } } } };
  return fn(calls).finally(() => { delete globalThis.window; });
}

test("export runs between detaching and re-attaching the shell proxy", () => withShell(async (calls) => {
  const self = { accountId: 7, _callWithTimeout: async (...a) => { calls.push(["export", a[2]]); } };
  self._withoutShellProxy = JsonRpcCore.prototype._withoutShellProxy;
  await JsonRpcCore.prototype.exportBackup.call(self, "/tmp/out", null);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls.map(c => c[0]), ["proxy_backup_begin", "export", "proxy_backup_end"]);
  assert.deepEqual(calls[0][1], { accountId: 7 });
}));

test("a failed transfer still re-attaches the proxy", () => withShell(async (calls) => {
  const self = { accountId: 3, _callWithTimeout: async () => { throw new Error("cancelled"); } };
  self._withoutShellProxy = JsonRpcCore.prototype._withoutShellProxy;
  await assert.rejects(JsonRpcCore.prototype.provideBackup.call(self), /cancelled/);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls.map(c => c[0]), ["proxy_backup_begin", "proxy_backup_end"]);
}));

test("without the shell, export just runs", async () => {
  let exported = false;
  const self = { accountId: 1, _callWithTimeout: async () => { exported = true; } };
  self._withoutShellProxy = JsonRpcCore.prototype._withoutShellProxy;
  await JsonRpcCore.prototype.exportBackup.call(self, "/tmp/out");
  assert.equal(exported, true);
});

test("an import asks the shell to fix the restored profile's proxy", () => withShell(async (calls) => {
  const self = { accountId: 2, _call: async (m) => { calls.push([m]); return "ok"; } };
  self._proxyReapply = JsonRpcCore.prototype._proxyReapply;
  assert.equal(await JsonRpcCore.prototype.importBackup.call(self, "/tmp/b.tar"), "ok");
  assert.deepEqual(calls.map(c => c[0]), ["import_backup", "proxy_reapply"]);
}));
