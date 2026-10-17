import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// #126: identity restore reloaded 800 ms after the key import without saving,
// so the next load had no login or keys.
test("identity restore saves before it reloads", () => {
  const app = src("app/js/app.js");
  const fn = app.slice(app.indexOf("async function runIdentityRestore"), app.indexOf("function openIdentityBackup"));
  const save = fn.indexOf("await core.transport.checkpoint?.()");
  const reload = fn.indexOf("location.reload()");
  assert.ok(save > 0 && reload > save, "checkpoint is awaited before the reload");
  assert.ok(fn.indexOf("importSelfKeys") < save, "after the keys are in");
});

// Stale deploys: the new SW filled its cache through the HTTP cache, so a host
// with max-age gave a new VERSION full of old files.
test("the dist service worker installs fresh files and loads the page from the network", () => {
  const b = src("scripts/build-pwa.mjs");
  assert.match(b, /new Request\(u, \{ cache: 'reload' \}\)/);
  assert.match(b, /e\.request\.mode === 'navigate'/);
  assert.match(b, /reg\.update\(\)/, "a resumed PWA checks for an update");
  assert.match(b, /velta-sw-updated/);
  assert.match(b, /sqlite_export/, "refuses a wasm core that cannot save databases");
  assert.match(b, /brotliCompressSync/, "precompresses the wasm for static hosts");
  assert.match(b, /!f\.endsWith\('\.br'\) && !f\.endsWith\('\.gz'\)/, "brotli/gzip sidecars stay out of the SW precache");
});

test("the wasm wrapper exports the database snapshot bindings", () => {
  const lib = src("packages/velta-wasm/rust/src/lib.rs");
  for (const f of ["sqlite_list", "sqlite_export", "sqlite_import"]) assert.match(lib, new RegExp(`pub fn ${f}\\(`));
});

test("the page saves when hidden and tells the user about a new version", () => {
  const t = src("app/js/transport-worker-wasm.js");
  assert.match(t, /visibilitychange[\s\S]{0,200}checkpoint\(\)/);
  const app = src("app/js/app.js");
  assert.match(app, /addEventListener\("velta-sw-updated"[\s\S]{0,300}toast\(/);
});
