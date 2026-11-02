import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VAPID_KEY } from "../app/js/web-push.js";

const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

test("Android UnifiedPush VAPID_KEY is injected via veltaVapidKey BuildConfig", () => {
  const gradle = src("velta-app/src-tauri/gen/android/app/build.gradle.kts");
  assert.match(gradle, /veltaVapidKey/);
  assert.match(gradle, /VELTA_VAPID_KEY/);
  assert.match(gradle, /buildConfigField\("String", "VAPID_KEY"/);
  assert.ok(gradle.includes(VAPID_KEY), "default remains the upstream notifier key");
  const kt = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/UnifiedPushService.kt");
  assert.match(kt, /BuildConfig\.VAPID_KEY/);
  assert.doesNotMatch(strip(kt), /private const val VAPID_KEY/);
  assert.ok(!kt.includes(VAPID_KEY), "long key is not a private const in the service");
});

test("KMP VeltaPushService uses the same veltaVapidKey BuildConfig", () => {
  const gradle = src("velta-kmp/composeApp/build.gradle.kts");
  assert.match(gradle, /veltaVapidKey/);
  assert.match(gradle, /VELTA_VAPID_KEY/);
  assert.match(gradle, /buildConfigField\("String", "VAPID_KEY"/);
  assert.ok(gradle.includes(VAPID_KEY), "default remains the upstream notifier key");
  const kt = src("velta-kmp/composeApp/src/androidMain/kotlin/org/velta/kmp/push/VeltaPushService.kt");
  assert.match(kt, /BuildConfig\.VAPID_KEY/);
  assert.doesNotMatch(strip(kt), /private const val VAPID_KEY/);
  assert.ok(!kt.includes(VAPID_KEY), "long key is not a private const in the service");
});
