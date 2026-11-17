import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// velta-kmp's per-choice logomark is generated from the launcher vectors.
// Fails when any output is stale — run `node tools/gen-kmp-logomark.mjs`.
process.env.VELTA_GEN_NO_WRITE = "1";
const { generateKmpLogomark, KOTLIN_OUT } = await import("../tools/gen-kmp-logomark.mjs");
const fresh = generateKmpLogomark();

test("VeltaLogomark.kt is in sync with the launcher vectors", () => {
  const committed = readFileSync(new URL(`../${KOTLIN_OUT}`, import.meta.url), "utf8");
  assert.equal(committed, fresh.kotlin, "stale: run node tools/gen-kmp-logomark.mjs");
});

for (const [path, content] of Object.entries(fresh.xmls)) {
  test(`${path} is in sync`, () => {
    const committed = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.equal(committed, content, "stale: run node tools/gen-kmp-logomark.mjs");
  });
}

test("every choice has a logomark builder and a notification glyph", () => {
  assert.match(fresh.kotlin, /buildDefaultLogomark/);
  assert.match(fresh.kotlin, /buildBadgeLogomark/);
  assert.match(fresh.kotlin, /buildClassicLogomark/);
  for (const name of ["default", "badge", "classic"]) {
    assert.ok(fresh.xmls[`velta-kmp/composeApp/src/androidMain/res/drawable/ic_notify_${name}.xml`]);
  }
});
