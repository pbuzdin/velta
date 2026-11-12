import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #318: velta-kmp's Compose tokens are generated from app/css/main.css.
// Fails when VeltaTokens.kt is stale — run `node tools/gen-kmp-theme.mjs`.
process.env.VELTA_GEN_NO_WRITE = "1";
const { generateKmpTheme, KMP_THEME_PATH } = await import("../tools/gen-kmp-theme.mjs");
const committed = readFileSync(new URL(`../${KMP_THEME_PATH}`, import.meta.url), "utf8");

test("VeltaTokens.kt is in sync with main.css", () => {
  assert.equal(committed, generateKmpTheme(), "stale: run node tools/gen-kmp-theme.mjs");
});

const theme = (name) => {
  const i = committed.indexOf(`val ${name} = VeltaTokens(`);
  assert.ok(i >= 0, `${name} emitted`);
  return committed.slice(i, committed.indexOf("\n    )", i));
};
const val = (block, k) => (block.match(new RegExp(`\\b${k} = ([^,]+),`)) || [])[1];

test("the known Theme.kt mismatches are fixed by the generated values", () => {
  const light = theme("Light"), dark = theme("Dark");
  assert.equal(val(light, "bgChat"), "Color(0xFFE7EBF0)");
  assert.equal(val(light, "bgBubbleIn"), "Color(0xFFF4F4F4)");
  assert.equal(val(dark, "bgChat"), "Color(0xFF0B0B10)");
  assert.equal(val(dark, "text"), "Color(0xFFF2F2F5)");
  assert.equal(val(dark, "border"), "Color(0x12F4F4F4)"); // rgba(244,244,244,.07)
});

test("brutal and AMOLED are emitted with their overrides", () => {
  assert.equal(val(theme("Brutal"), "radiusBubble"), "6.dp");
  assert.equal(val(theme("Brutal"), "textOut"), "Color(0xFF211D05)"); // --nb-main-ink
  assert.equal(val(theme("Amoled"), "bg"), "Color(0xFF000000)");
  assert.equal(val(theme("Amoled"), "bgSidebar"), val(theme("Dark"), "bgSidebar"));
});

test("Theme.kt hard-codes no colors (everything goes through the tokens)", () => {
  const src = readFileSync(new URL("../velta-kmp/composeApp/src/commonMain/kotlin/org/velta/kmp/ui/Theme.kt", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Color\(0x/);
});
