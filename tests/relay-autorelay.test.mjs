import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDocument } from "./helpers/fake-dom.mjs";

// VENDORISSUES #23: automatic relay onboarding is opt-in. The one-time
// migration flips autorelay=1 (upstream's init_transports default) off for
// profiles that predate the toggle; the per-account marker keeps it from
// re-running after the user opts back in through the Relays modal.

const withStorage = (t) => {
  installFakeDocument();
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  t.after(() => { delete globalThis.localStorage; });
  return store;
};

test("migration flips a legacy autorelay=1 off, once per account", async (t) => {
  withStorage(t);
  const { JsonRpcCore } = await import("../app/js/rpc-core.js");
  const calls = [];
  const self = {
    accountId: 7,
    getConfig: async (key) => (calls.push(["get", key]), "1"),
    setConfig: async (key, value) => { calls.push(["set", key, value]); },
  };
  assert.equal(await JsonRpcCore.prototype.migrateAutorelayDefault.call(self), true, "legacy value flipped");
  assert.deepEqual(calls, [["get", "autorelay"], ["set", "autorelay", "0"]]);

  // Second open: the marker holds — an opted-in value must not be re-flipped.
  const again = {
    accountId: 7,
    getConfig: async () => { throw new Error("must not re-read after the marker"); },
    setConfig: async () => { throw new Error("must not re-write after the marker"); },
  };
  assert.equal(await JsonRpcCore.prototype.migrateAutorelayDefault.call(again), false);
});

test("no flip when autorelay is off; a failed core read stays retryable", async (t) => {
  const store = withStorage(t);
  const { JsonRpcCore } = await import("../app/js/rpc-core.js");

  // Already off: marker written, config untouched.
  const self = {
    accountId: 7,
    getConfig: async () => "0",
    setConfig: async () => { throw new Error("no write for an off value"); },
  };
  assert.equal(await JsonRpcCore.prototype.migrateAutorelayDefault.call(self), false);
  assert.equal(JSON.parse(globalThis.localStorage.getItem("velta-autorelay-default"))["7"], 1);

  // Core read fails: no marker — the migration retries on the next open.
  const failing = {
    accountId: 8,
    getConfig: async () => { throw new Error("core down"); },
    setConfig: async () => { throw new Error("no write on a failed read"); },
  };
  assert.equal(await JsonRpcCore.prototype.migrateAutorelayDefault.call(failing), false);
  assert.equal(JSON.parse(globalThis.localStorage.getItem("velta-autorelay-default"))["8"], undefined, "retryable");
  assert.ok(store.has("velta-autorelay-default"), "account 7's marker survives");
});
