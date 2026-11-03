// Diagnostics chat filter and the velta://diagnostics support link.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
globalThis.window ??= {};
const { diagnosticLine, parseDiagnosticsLink, diagnosticsShareLink, normalizeDiagLevel } = await import("../app/js/diagnostics.js");

test("a diagnostics link names the levels and whether to copy", () => {
  assert.deepEqual(parseDiagnosticsLink("velta://diagnostics?show=error&copy=1"), { levels: ["error"], copy: true });
  assert.deepEqual(parseDiagnosticsLink("velta://diagnostics?show=warning,error"), { levels: ["error", "warning"], copy: false });
  assert.deepEqual(parseDiagnosticsLink("velta://diagnostics?show=warn"), { levels: ["warning"], copy: false });
  assert.deepEqual(parseDiagnosticsLink("velta://diagnostics"), { levels: ["error", "warning", "info"], copy: false });
  assert.equal(parseDiagnosticsLink("velta://diagnostics?show=nope"), null);
  assert.equal(parseDiagnosticsLink("velta://chat?chat=1"), null);
  const link = diagnosticsShareLink(new Set(["info", "error"]));
  assert.equal(link, "velta://diagnostics?show=error%2Cinfo&copy=1");
  assert.deepEqual(parseDiagnosticsLink(link), { levels: ["error", "info"], copy: true });
  assert.equal(diagnosticsShareLink(new Set()), null);
});

test("warn rows count as warnings and the line matches the row", () => {
  assert.equal(normalizeDiagLevel("warn"), "warning");
  const line = diagnosticLine({ level: "error", text: "[ERROR] boom", ts: 0, count: 2 });
  assert.match(line, /❌ boom ×2/);
  assert.doesNotMatch(line, /\[ERROR\]/);
});

test("the bar filters the chat and the link is handled before chat links", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const man = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  for (const level of ["error", "warning", "info"]) assert.match(html, new RegExp(`data-diag-level="${level}"`));
  assert.match(app, /shownDiagnostics\(\)\.map\(diagnosticRow\)/);
  const handler = app.slice(app.indexOf("async function handleDeeplinkFromUrl"), app.indexOf("function chooseRelayOrNewProfile"));
  assert.ok(handler.includes("parseDiagnosticsLink"));
  assert.ok(handler.indexOf("parseDiagnosticsLink") < handler.indexOf("extractChatLink"));
  assert.match(man, /android:host="diagnostics"/);
});
