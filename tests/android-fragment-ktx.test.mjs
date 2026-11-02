import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gradle = readFileSync(
  new URL("../velta-app/src-tauri/gen/android/app/build.gradle.kts", import.meta.url),
  "utf8",
);

test("gen/android pins fragment-ktx 1.8.x next to biometric/activity-ktx", () => {
  assert.match(gradle, /androidx\.fragment:fragment-ktx:1\.8\./);
});
