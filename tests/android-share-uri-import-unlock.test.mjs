// Source pins for the Android shell fixes #622 (share/FileProvider/installer),
// #623 (content-URI import) and #624 (biometric cold-start unlock). Kotlin and
// the Android-only Rust have no local compile gate: the Build Android APK
// workflow is the compiler.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const A = "../velta-app/src-tauri/gen/android/app/src/main/";
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const kt = (n) => read(`${A}java/org/velta/${n}.kt`);

test("Share.file does not grant the URI to every candidate app (#622)", () => {
  const s = kt("Share");
  assert.doesNotMatch(s, /grantUriPermission|queryIntentActivities/);
  assert.match(s, /clipData = ClipData\.newRawUri/);
  assert.match(s, /FLAG_GRANT_READ_URI_PERMISSION/);
});

test("the FileProvider exposes the cache dir only, not shared storage (#622)", () => {
  const x = read(`${A}res/xml/file_paths.xml`);
  assert.doesNotMatch(x, /external-path|external-files-path|external-cache-path|root-path/);
  assert.match(x, /<cache-path /);
});

test("install_update only installs the downloaded Velta APK from the cache dir (#622)", () => {
  const s = kt("UpdateInstall");
  assert.match(s, /fun isDownloadedApk\(cacheDir: File, file: File\)/);
  assert.match(s, /startsWith\("Velta-"\)[\s\S]*endsWith\("-arm64\.apk"\)/);
  assert.match(s, /canonicalPath\.startsWith\(root\)/);
  assert.match(s, /if \(!isDownloadedApk\(context\.cacheDir, file\)\) return false/);
});

test("content-URI import reads the name only from a real row and sanitises it (#623)", () => {
  const rs = read("../velta-app/src-tauri/src/lib.rs");
  const f = rs.slice(rs.indexOf("fn resolve_content_uri_blocking("));
  const body = f.slice(0, f.indexOf("fn ", 50));
  assert.match(body, /"moveToFirst", "\(\)Z", &\[\]\)\.and_then\(\|v\| v\.z\(\)\)/);
  assert.match(body, /if has_row \{/);
  assert.doesNotMatch(body, /getString[^\n]*\n[^\n]*\.map_err\(\|e\| e\.to_string\(\)\)\?/, "no early return between moveToFirst and close");
  assert.match(body, /safe_open_name\(Some\(raw_name\)/);
  assert.doesNotMatch(body, /display_name\.replace\(\['\/', '\\\\'\], "_"\)/);
});

test("biometric cold start waits for the core instead of asking twice (#624)", () => {
  const s = kt("VeltaLock");
  assert.match(s, /private fun hideWhenRunning\(attempt: Int = 0\)/);
  assert.match(s, /VeltaCore\.startWithDek\(hex\(dek\)\)\)[\s\S]{0,200}hideWhenRunning\(\)/);
  assert.doesNotMatch(s, /startWithDek\(hex\(dek\)\)\n\s*if \(VeltaCore\.running\(\)\) hideLock\(\)/);
  assert.match(s, /finally \{[^}]*currentDek = ""/);
});
