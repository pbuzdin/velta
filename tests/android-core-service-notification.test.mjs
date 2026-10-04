import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #82: the persistent "Keeping your messages up to date" foreground
// service notification must open Velta when tapped. There is no Android build
// in CI for tests, so this pins the Kotlin/manifest source (comment-stripped)
// the same way other suites pin sources: a content intent exists, it is the
// launcher intent (no velta://chat deep link, which is the #20 path for message
// notifications), PendingIntent flags are safe, and the notification stays
// ongoing.
const dir = new URL("../velta-app/src-tauri/gen/android/app/src/main/", import.meta.url);
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const service = strip(readFileSync(new URL("java/org/velta/CoreService.kt", dir), "utf8"));
const manifest = readFileSync(new URL("AndroidManifest.xml", dir), "utf8");

test("the foreground notification has a content intent that launches MainActivity", () => {
  const builder = service.slice(service.indexOf("NotificationCompat.Builder"), service.indexOf("startForeground"));
  assert.match(builder, /\.setContentIntent\(openAppIntent\(\)\)/);
  assert.match(builder, /\.setOngoing\(true\)/, "stays ongoing");
  assert.doesNotMatch(builder, /setAutoCancel\(true\)/);
});

test("the intent is the launcher intent: MAIN/LAUNCHER, MainActivity, no data, no VIEW", () => {
  const fn = service.slice(service.indexOf("fun openAppIntent"), service.indexOf("override fun onStartCommand"));
  assert.match(fn, /Intent\(Intent\.ACTION_MAIN\)/);
  assert.match(fn, /addCategory\(Intent\.CATEGORY_LAUNCHER\)/);
  assert.match(fn, /setClass\(this, MainActivity::class\.java\)/);
  assert.match(fn, /FLAG_ACTIVITY_NEW_TASK/);
  assert.doesNotMatch(fn, /ACTION_VIEW|setData|Uri\.parse|putExtra|velta:\/\//, "never reaches the #20 chat deep-link path");
});

test("PendingIntent is immutable and updatable", () => {
  const fn = service.slice(service.indexOf("fun openAppIntent"), service.indexOf("override fun onStartCommand"));
  assert.match(fn, /PendingIntent\.getActivity\(/);
  assert.match(fn, /FLAG_IMMUTABLE/);
  assert.match(fn, /FLAG_UPDATE_CURRENT/);
  assert.match(service, /import android\.app\.PendingIntent/);
});

test("MainActivity is singleTask (a tap reuses the running task) and is the launcher activity", () => {
  const act = manifest.slice(manifest.indexOf('android:name=".MainActivity"') - 400, manifest.indexOf("</activity>"));
  assert.match(act, /android:launchMode="singleTask"/);
  assert.match(act, /android\.intent\.action\.MAIN/);
  assert.match(act, /android\.intent\.category\.LAUNCHER/);
});
