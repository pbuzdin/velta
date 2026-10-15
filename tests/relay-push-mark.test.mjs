import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePushDiagnostic, notePushDiagnostic, relaySupportsPush, pushMarkHtml } from "../app/js/relay-push.js";

const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test("parses core patch #13 push events with addr", () => {
  assert.deepEqual(parsePushDiagnostic("Transport 2 (bob@nine.testrun.org): push notifications registered — the relay will wake the app on new mail"),
    { domain: "nine.testrun.org", supported: true });
  assert.deepEqual(parsePushDiagnostic("Transport 3 (a@x.org): relay did not accept the push token (NO) — no push notifications for this relay"),
    { domain: "x.org", supported: false });
  // old format without addr: cannot be attributed -> ignored, never guessed
  assert.equal(parsePushDiagnostic("Transport 2: push notifications registered — x"), null);
  assert.equal(parsePushDiagnostic("Transport 2 (): push notifications registered"), null);
});

test("cache: unknown -> no mark, confirmed -> mark, rejection clears", () => {
  const s = mem();
  assert.equal(relaySupportsPush("me@r.org", s), false);
  notePushDiagnostic("Transport 1 (me@R.org): push notifications registered — y", s);
  assert.equal(relaySupportsPush("other@r.org", s), true);
  notePushDiagnostic("Transport 1 (me@r.org): relay did not accept the push token (e) — n", s);
  assert.equal(relaySupportsPush("me@r.org", s), false);
});

test("mark is accessible and wired into the Relays modal", () => {
  assert.match(pushMarkHtml(), /aria-label="Supports UnifiedPush push notifications"/);
  assert.match(pushMarkHtml(), /title="Supports UnifiedPush push notifications"/);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /relaySupportsPush\(t\.addr\) \? pushMarkHtml\(\)/);
  assert.match(app, /notePushDiagnostic\(message\)/);
  const tool = readFileSync(new URL("../tools/apply-core-patches.py", import.meta.url), "utf8");
  assert.match(tool, /Transport \{transport_id\} \(\{addr\}\): push notifications registered/);
});
