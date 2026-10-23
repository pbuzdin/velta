import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// Audit item 1: the retired background-service bridge (ws://127.0.0.1:20808,
// and before it the HTTP bridge on 20809) is no longer probed or allowed by
// any shipped surface. Nothing authenticated the listener, so after a core
// startup failure any local app on that port could have posed as the core.
test("no shipped surface probes or allows the retired service ports", () => {
  for (const f of [
    "app/js/transport.js", "app/js/app.js", "app/index.html",
    "velta-app/src-tauri/tauri.conf.json", "velta-app/src-tauri/tauri.android.conf.json",
  ]) {
    const s = src(f).split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(s, /2080[89]/, f);
  }
  assert.doesNotMatch(src("app/js/transport.js"), /new WebSocket\(/);
  assert.equal(existsSync(new URL("../app/diag.html", import.meta.url)), false);
});
