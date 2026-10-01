// #45: fingerprints are cached per (accountId, contactId) — switching
// accounts re-wires the source without wiping other accounts' entries, and
// a contact resolved once is never fetched again.
import test from "node:test";
import assert from "node:assert/strict";
import { setFingerprintSource, fingerprintFor, cachedFingerprint } from "../app/js/avatar.js";

const ALICE_KEY = "0123 4567 89AB CDEF 0123 4567 89AB CDEF 0123 4567";

function wire(accountId, log) {
  setFingerprintSource(async (contactId) => {
    log.push(`${accountId}:${contactId}`);
    return `Me (me@x):\n\nAlice (alice@x):\n${ALICE_KEY}`;
  }, accountId);
}

test("fingerprints are cached per (accountId, contactId)", async () => {
  const log = [];
  wire("A", log);

  const p1 = fingerprintFor(5, "alice@x");
  const p2 = fingerprintFor(5, "alice@x");
  assert.equal(p1, p2, "same contact reuses the in-flight promise");
  assert.equal(await p1, ALICE_KEY.replaceAll(" ", ""));
  assert.deepEqual(log, ["A:5"], "fetched exactly once");

  wire("B", log);
  assert.equal(cachedFingerprint(5), null, "account B has its own namespace");
  await fingerprintFor(5, "alice@x");
  assert.deepEqual(log, ["A:5", "B:5"]);

  wire("A", log);
  assert.equal(cachedFingerprint(5), ALICE_KEY.replaceAll(" ", ""), "switching back does not refetch");
  assert.deepEqual(log, ["A:5", "B:5"], "account A entry survived the round trip");
});
