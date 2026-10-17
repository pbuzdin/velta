import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// wasm-bindgen names the glue after the crate (velta-wasm → velta_wasm.js,
// velta_wasm_bg.wasm) and the glue loads its .wasm by that name, so the
// crate, the dist builder and the page's glue URL must agree.
test("velta-wasm crate, PWA builder and transport agree on the glue names", () => {
  const crate = src("packages/velta-wasm/rust/Cargo.toml").match(/^name = "([^"]+)"/m)[1];
  assert.equal(crate, "velta-wasm");
  const stem = crate.replaceAll("-", "_");
  assert.match(src("app/js/transport.js"), new RegExp(`"wasm/${stem}\\.js"`));
  const build = src("scripts/build-pwa.mjs");
  assert.match(build, new RegExp(`\\['${stem}\\.js', '${stem}_bg\\.wasm'\\]`));
  assert.match(build, new RegExp(`join\\(outDir, 'wasm', '${stem}_bg\\.wasm'\\)`));
  const ci = src(".github/workflows/wasm-core-opt-in.yml");
  assert.match(ci, new RegExp(`${stem}_bg\\.wasm`));
  assert.doesNotMatch(ci, /deltachat[-_]wasm/);
});
