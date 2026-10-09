import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #103: the "Join chat via invite link" modal closed itself right before
// joinFromInvite opened its confirmModal. close() schedules history.back()
// async; the confirm saw history.state still "modal", reused the dying
// entry, and was torn down by the landing pop — resolve(false) → Join did
// nothing, silently. The fix awaits modalHistorySettled() first.
const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("joinFromInvite settles the modal history before its confirm chain", () => {
  const start = stripped.indexOf("async function joinFromInvite(");
  assert.ok(start !== -1, "joinFromInvite exists outside comments");
  const next = stripped.indexOf("\nasync function ", start + 10);
  const body = stripped.slice(start, next === -1 ? undefined : next);
  const settle = body.indexOf("await modalHistorySettled()");
  const confirm = body.indexOf("confirmModal(");
  assert.ok(settle !== -1, "must await modalHistorySettled()");
  assert.ok(confirm !== -1 && settle < confirm, "settle must precede the confirmModal chain");
});

// Same contract for the relay flow: acquireCode closes its modal before
// addRelayFlow opens "Adding relay", and success closes the steps modal
// right before the Relays list reopens — both need the settle first.
test("addRelayFlow settles the modal history at both reopen points", () => {
  const start = stripped.indexOf("async function addRelayFlow(");
  assert.ok(start !== -1, "addRelayFlow exists outside comments");
  const next = stripped.indexOf("\nasync function ", start + 10);
  const body = stripped.slice(start, next === -1 ? undefined : next);
  const settle = body.indexOf("await modalHistorySettled()");
  const adding = body.indexOf('showModal({ title: "Adding relay"');
  const reopen = body.indexOf("openRelaysModal()");
  assert.ok(settle !== -1 && adding !== -1 && settle < adding,
    "settle must precede the Adding-relay modal");
  const settleReopen = body.indexOf("await modalHistorySettled()", settle + 10);
  assert.ok(settleReopen !== -1 && reopen !== -1 && settleReopen < reopen,
    "settle must precede reopening the Relays list");
});
