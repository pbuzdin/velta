// #127 regression: the live PWA (nginx) served app/vendor/sjcl.mjs
// as application/octet-stream, so Chromium's strict module MIME check refused
// it, the whole app.js module graph (lufi.js -> sjcl) failed to load, and the
// welcome splash with its version line never rendered from the fresh build.
// Many static hosts only map ".js" to a JavaScript type, so runtime modules
// under app/ must use .js — never .mjs — and no import may name a .mjs file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../app/", import.meta.url));
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(appDir);

test("no .mjs files ship in app/ (servers may send them as octet-stream)", () => {
  assert.deepEqual(files.filter(f => f.endsWith(".mjs")).map(f => relative(appDir, f)), []);
});

test("no app/ script imports a .mjs specifier", () => {
  const bad = [];
  const re = /(?:\bimport\s*(?:[\w*{}\s,]+from\s*)?|\bimport\s*\(\s*)["'`]([^"'`]+\.mjs)["'`]/g;
  for (const f of files.filter(f => /\.(js|html)$/.test(f))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) bad.push(`${relative(appDir, f)}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test("lufi.js imports the vendored sjcl as .js", () => {
  const src = readFileSync(join(appDir, "js/lufi.js"), "utf8");
  assert.match(src, /from\s+"\.\.\/vendor\/sjcl\.js"/);
});
