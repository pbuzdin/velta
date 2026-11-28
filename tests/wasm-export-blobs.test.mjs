import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const series = src("docs/research/wasm-patches/series.txt");
const p13 = src("docs/research/wasm-patches/series/0013-wasm-imex-export_backup_stream-blob-loop-read_bytes.patch");

// #331: export_backup_stream buffered blobs through SyncIoBridge +
// spawn_blocking, both of which call Handle::current() — no Tokio runtime on
// wasm32, so any profile with a blob (avatar, attachment) panicked before
// writing a file.

test("the wasm series carries the export blob-loop patch", () => {
  assert.match(series, /0013-wasm-imex-export_backup_stream-blob-loop-read_bytes\.patch/);
  assert.match(p13, /WASM-CORE: imex\./);
  assert.match(p13, /Native impact: none/);
});

test("0013 reads blobs directly on wasm32 and keeps the native duplex path", () => {
  assert.match(p13, /#\[cfg\(target_arch = "wasm32"\)\]/);
  assert.match(p13, /let bytes = blob\.read_bytes\(context\)\?;/);
  assert.match(p13, /append_data\(&mut header, path_in_archive, &bytes\[\..\]\)/);
  // The native branch (SyncIoBridge + spawn_blocking) stays, cfg-gated.
  assert.match(p13, /#\[cfg\(not\(target_arch = "wasm32"\)\)\]/);
  assert.match(p13, /SyncIoBridge::new/);
  assert.match(p13, /spawn_blocking/);
});
