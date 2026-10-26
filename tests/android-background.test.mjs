import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Android background work (velta-android-bg-audit): pins the Kotlin and Rust
// sources, comment-stripped. There is no Android runtime in these tests;
// on-device checks are listed in the commit messages.
const kt = new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/", import.meta.url);
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const read = (name) => strip(readFileSync(new URL(name, kt), "utf8"));

test("CoreService holds no wake lock", () => {
  const s = read("CoreService.kt");
  assert.doesNotMatch(s, /WakeLock|PARTIAL_WAKE_LOCK|newWakeLock|\.acquire\(/);
});
