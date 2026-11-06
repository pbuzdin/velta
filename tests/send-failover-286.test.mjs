import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendFailover, createFailoverLog, isStrictOn, SEND_STRICT_KEY } from "../app/js/relay-failover.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("sendFailover: only when the bound relay differs from the pin", () => {
  assert.equal(sendFailover("me@a.org", null), null);
  assert.equal(sendFailover("me@a.org", "me@A.org"), null);
  assert.deepEqual(sendFailover("me@a.org", "me@b.org"), { via: "me@b.org", failed: "me@a.org" });
});

test("failover log fires on transitions only", () => {
  const log = createFailoverLog();
  assert.equal(log(null), null);
  const fo = { via: "x@b", failed: "x@a" };
  assert.match(log(fo), /sending via x@b, x@a failed/);
  assert.equal(log(fo), null);
  assert.match(log(null), /ended/);
  assert.equal(log(null), null);
});

test("strict key + parsing", () => {
  assert.equal(SEND_STRICT_KEY, "ui.velta.send_strict");
  assert.ok(isStrictOn("1")); assert.ok(!isStrictOn(null)); assert.ok(!isStrictOn("0"));
});

test("Relays modal: strict checkbox, status banner, segment title", () => {
  const app = read("app/js/app.js");
  assert.match(app, /data-send-strict/);
  assert.match(app, /core\.setConfig\(SEND_STRICT_KEY, strictEl\.checked \? "1" : null\)/);
  assert.match(app, /className = "relay-failover"/);
  assert.match(app, /relayFailoverLog\(failover\)/);
  assert.match(read("app/css/main.css"), /\.relay-failover \{[^}]*background: var\(--bg-sidebar\); color: var\(--text\)/);
});

test("core patch #30 (#286): strict pin keeps sending on the pin only", () => {
  const tool = read("tools/apply-core-patches.py");
  assert.match(tool, /ui\.velta\.send_strict/);
  assert.match(tool, /transports\.retain\(\|\(id, _\)\| Some\(\*id\) == velta_pin\);/);
  assert.match(tool, /Only sending via the pinned relay \{addr\}/);
});

test("strings in ru + fr", () => {
  for (const l of ["ru", "fr"]) {
    const d = JSON.parse(read(`app/locales/${l}.json`));
    for (const k of ["Sending via {via} — {failed} failed", "Only send via the pinned relay",
      "Only sending via {relay} — it is not reachable, messages wait for it",
      "No fallback: if the pinned relay fails, messages wait for it. Receiving still uses every relay. Applies to this device."]) assert.ok(d[k], `${l}: ${k}`);
  }
});
