// Fix 5 (startup): rarely used features load with import() on first use.
// Guards: they stay out of the static boot graph, every dynamic specifier
// resolves to a shipped .js file, and the PWA precache still covers them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const js = fileURLToPath(new URL("../app/js/", import.meta.url));
const read = (f) => readFileSync(join(js, f), "utf8");
const staticImports = (src) => [...src.matchAll(/^\s*import\s+(?:[\w*{}\s,]+from\s+)?["']([^"']+)["']/gm)].map(m => m[1]);

// The static module graph reachable from app.js.
function bootGraph() {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
    }
  };
  visit(join(js, "app.js"));
  return [...seen].map(f => relative(js, f).replaceAll("\\", "/"));
}

const LAZY = ["qr-scan.js", "large-file.js", "lufi.js", "../vendor/sjcl.js", "image-compress.js"];

test("lazy features are not in the static boot graph", () => {
  const graph = bootGraph();
  for (const f of LAZY) assert.ok(!graph.includes(f), `${f} is statically reachable from app.js`);
  // critical path stays eager
  for (const f of ["chat-view.js", "transport.js", "ui.js", "components.js", "calls.js"]) assert.ok(graph.includes(f), f);
});

test("every import() specifier in app/js resolves to a shipped .js file", () => {
  const bad = [];
  let count = 0;
  for (const f of readdirSync(js).filter(n => n.endsWith(".js"))) {
    for (const m of read(f).matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      count++;
      const p = resolve(js, m[1]);
      if (!m[1].endsWith(".js") || !existsSync(p)) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.ok(count >= 5);
  assert.deepEqual(bad, []);
});

test("the PWA service worker precaches the whole dist, lazy modules included", () => {
  const build = readFileSync(new URL("../scripts/build-pwa.mjs", import.meta.url), "utf8");
  assert.match(build, /const files = \[\.\.\.walk\(outDir\)\]/);
  assert.match(build, /const PRECACHE = \$\{JSON\.stringify\(files/);
});
