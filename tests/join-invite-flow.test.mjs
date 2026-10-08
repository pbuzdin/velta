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
