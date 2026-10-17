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
