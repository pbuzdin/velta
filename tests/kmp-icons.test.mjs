import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #321 step 2: velta-kmp's Compose icons are generated from app/js/icons.js.
// Fails when VeltaIcons.kt is stale — run `node tools/gen-kmp-icons.mjs`.
process.env.VELTA_GEN_NO_WRITE = "1";
const { generateKmpIcons, KMP_ICONS_PATH } = await import("../tools/gen-kmp-icons.mjs");
const committed = readFileSync(new URL(`../${KMP_ICONS_PATH}`, import.meta.url), "utf8");

test("VeltaIcons.kt is in sync with icons.js", () => {
  assert.equal(committed, generateKmpIcons(), "stale: run node tools/gen-kmp-icons.mjs");
});

test("the icons the KMP client uses are emitted", () => {
  for (const name of [
    "close", "arrowLeft", "info", "camera", "reply", "attach", "send",
    "tick1", "tick2", "warn", "clock", "lock", "lockOpen", "plus",
    "photo", "video", "mic", "webxdc", "globe", "sticker", "fileLarge",
  ]) {
    assert.match(committed, new RegExp(`val ${name}: ImageVector`), `${name} emitted`);
  }
});
