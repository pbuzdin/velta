import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("webxdc frame close clears the server gate before the next open (audit 5)", () => {
  const m = src("app/js/webxdc-manager.js");
  assert.match(m, /invoke\?\.\("webxdc_end", \{ account: active\.account, msg:/);
  const open = m.indexOf("await webxdcEndPending");
  assert.ok(open > 0 && open < m.indexOf('invoke?.("webxdc_begin"'), "end awaited before begin");
  assert.match(src("velta-app/src-tauri/src/lib.rs"), /webxdc_begin, webxdc_end,/);
});

test("V-07: picked-path commands go through the Rust-side gate (audit 2)", () => {
  const lib = src("velta-app/src-tauri/src/lib.rs");
  assert.match(lib, /fn allow_picked_path[\s\S]{0,200}picked::check\(&app, &p\)\?/);
  assert.match(lib, /async fn prep_backup\(app[\s\S]{0,120}picked::check/);
  assert.match(src("velta-app/src-tauri/src/lufi.rs"), /lufi_open_file\(app[\s\S]{0,250}picked::check/);
});

test("in-app browser hands mailto/tel/market to the system, drops intent/file (audit 4)", () => {
  const k = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/InAppBrowser.kt");
  assert.match(k, /scheme == "mailto" \|\| scheme == "tel" \|\| scheme == "market"/);
  assert.doesNotMatch(k, /scheme == "intent"|scheme == "file"/);
});

test("windows cross installer job may upload release assets (audit 3)", () => {
  const y = src(".github/workflows/build-windows-cross.yml");
  assert.match(y, /build-installer:\r?\n\s+needs: \[?build-sidecar[^\r\n]*\r?\n(\s+#.*\r?\n)?\s+permissions:\r?\n\s+contents: write/);
});
