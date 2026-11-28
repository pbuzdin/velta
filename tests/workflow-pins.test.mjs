// Workflow hygiene: every third-party action is pinned to a commit SHA, and
// the sidecar/bundle cache keys of the desktop workflows hash the shim crate
// that produces the sidecar (a key without it can ship a stale sidecar).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));

test("every `uses:` in a workflow is pinned to a 40-hex commit", () => {
  const bad = [];
  for (const f of files) {
    readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line, i) => {
      const m = line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/);
      if (!m || m[1].startsWith("./")) return;
      if (!/@[0-9a-f]{40}$/.test(m[1])) bad.push(`${f}:${i + 1} ${m[1]}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("Linux and Windows sidecar/bundle cache keys include the rpc-shim crate", () => {
  for (const f of ["build-linux.yml", "build-windows.yml"]) {
    const keys = [...readFileSync(new URL(f, dir), "utf8").matchAll(/hash=\$\{\{ hashFiles\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(keys.length >= 2, `${f}: sidecar + bundle keys`);
    for (const k of keys) assert.ok(k.includes("velta-kmp/native/rpc-shim/**"), `${f}: ${k}`);
  }
});
