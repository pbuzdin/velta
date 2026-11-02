// Second-device transfer: one get_backup at a time, long RPC
// timeouts for provide/get_backup, and the sender only cancels on an
// explicit Cancel once a receiver is connected.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JsonRpcCore, BACKUP_TRANSFER_TIMEOUT_MS } from "../app/js/rpc-core.js";

function fixture() {
  const core = new JsonRpcCore({});
  core.accountId = 1;
  const calls = [];
  let finish;
  const backup = new Promise(r => { finish = r; });
  const handler = async (timeout, method, ...params) => {
    calls.push([method, timeout, ...params]);
    if (method === "get_account_info") return { kind: "Unconfigured" };
    if (method === "get_backup") return backup;
    return null;
  };
  core._call = (m, ...p) => handler(30000, m, ...p);
  core._callWithTimeout = handler;
  core._proxyReapply = async () => {};
  return { core, calls, finish };
}

test("a second addAccountWithBackup while one is receiving is refused", async () => {
  const { core, calls, finish } = fixture();
  await core.addAccountWithBackup("DCBACKUP2:a");
  await assert.rejects(core.addAccountWithBackup("DCBACKUP2:a"), /already running/);
  assert.equal(calls.filter(c => c[0] === "get_backup").length, 1);
  finish();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(core.backupReceiveRunning, false);
  await core.addAccountWithBackup("DCBACKUP2:a"); // allowed again after it settles
});

test("get_backup uses the long transfer timeout, not 30 s", async () => {
  const { core, calls } = fixture();
  await core.addAccountWithBackup("DCBACKUP2:a");
  const gb = calls.find(c => c[0] === "get_backup");
  assert.equal(gb[1], BACKUP_TRANSFER_TIMEOUT_MS);
  assert.ok(BACKUP_TRANSFER_TIMEOUT_MS >= 30 * 60 * 1000);
});

test("app.js: sender cancel only explicit after receiver connected; receive does not stop_ongoing", () => {
  const src = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(src, /if \(receiverConnected && !explicit\)/);
  assert.match(src, /onClose: \(\) => cleanupTransfer\(false\)/);
  assert.match(src, /cleanupTransfer\(true\)/);
  assert.doesNotMatch(src, /receiveSecondDeviceProfile\(epoch, \(\) => \{ transferStarted = true; \}\)/);
  assert.match(src, /profileReceiveRunning \|\| core\.backupReceiveRunning/);
});

test("new strings are translated", () => {
  for (const l of ["ru", "fr"]) {
    const j = JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url), "utf8"));
    assert.ok(j["A profile transfer is already running — wait for it to finish"]);
    assert.ok(j["Profile transfer continues in the background — keep Velta open on both devices"]);
  }
});
