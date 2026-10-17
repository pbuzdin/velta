import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MockCore } from "../app/js/mock-core.js";

// Demo mode: "Add second device" → "This is the old device" awaits
// core.getBackupQrSvg(); without a mock twin demo mode threw "not a function".
test("demo core draws the second-device backup QR", async () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /core\.getBackupQrSvg\(\)/);
  const core = new MockCore();
  core._simTimer?.unref(); // demo traffic loop would keep node alive
  for (const m of ["provideBackup", "getBackupQrSvg", "stopOngoingProcess", "addAccountWithBackup"]) {
    assert.equal(typeof core[m], "function", m);
  }
  const svg = await core.getBackupQrSvg();
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.ok(svg.endsWith("</svg>"));
  assert.equal(svg, await core.getBackupQrSvg(), "deterministic");
});

// app.js treats a resolved provideBackup() as "transferred" and closes the
// pane, so the demo twin must stay pending until cancelled, like the core.
test("demo provideBackup stays pending until stopOngoingProcess", async () => {
  const core = new MockCore();
  core._simTimer?.unref();
  let settled = null;
  const p = core.provideBackup().then(() => { settled = "resolved"; }, (e) => { settled = e.message; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, null);
  await core.stopOngoingProcess();
  await p;
  assert.equal(settled, "cancelled");
  await core.stopOngoingProcess(); // nothing pending: no throw
});
