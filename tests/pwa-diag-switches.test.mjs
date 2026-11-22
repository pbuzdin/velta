import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #458: the Logging / DevTools switches are shell-only — the PWA has no
// velta.log file and no DevTools target behind them, so the Diagnostics
// panel hides both rows there instead of offering placebo toggles.
const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("diagnostics panel hides the shell-only switches in the PWA", () => {
  const app = strip(read("app/js/app.js"));
  assert.match(app, /if \(!tauriInvoke\(\)\) \{\s*loggingSw\?\.closest\("\.diag-switch"\)\?\.setAttribute\("hidden", ""\);\s*devtoolsSw\?\.closest\("\.diag-switch"\)\?\.setAttribute\("hidden", ""\);\s*\}/);
  // the handlers stay bound (shell builds keep the rows functional)
  assert.match(app, /devtoolsSw\.dataset\.bound/);
  assert.match(app, /loggingSw\.dataset\.bound/);
});

test("the static markup keeps both rows (shell builds still show them)", () => {
  const html = read("app/index.html");
  assert.match(html, /id="sw-logging"/);
  assert.match(html, /id="sw-devtools"/);
});
