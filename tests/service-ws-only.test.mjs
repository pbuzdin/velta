import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// The service's HTTP bridge (127.0.0.1:20809) was removed: the WebSocket
// bridge on 20808 is the only service transport. Nothing may still probe
// or allow the old port.
test("the service is reached over the 20808 WebSocket only", () => {
  const transport = src("app/js/transport.js");
  assert.match(transport, /ws:\/\/127\.0\.0\.1:20808/);
  const lib = src("velta-core-service/rust/src/lib.rs");
  assert.match(lib, /run_ws_bridge/);
  assert.doesNotMatch(src("velta-core-service/rust/Cargo.toml"), /tiny_http/);
  for (const f of [
    "app/js/transport.js", "app/index.html", "app/diag.html",
    "velta-app/src-tauri/tauri.conf.json", "velta-app/src-tauri/tauri.android.conf.json",
    "velta-core-service/rust/src/lib.rs",
  ]) {
    assert.doesNotMatch(src(f), /20809/, f);
  }
});
