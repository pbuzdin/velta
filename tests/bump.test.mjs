import test from "node:test";
import assert from "node:assert/strict";
import { bumpVersion } from "../tools/bump.mjs";

// The bump command's contract: rewrite [package].version (first match — the
// [package] section precedes any [[bin]]), the velta-app entry in Cargo.lock,
// regenerate version.gen.js, and mirror the version into tauri.conf.json —
// the tauri-cli Android build reads ONLY the conf field for
// tauri.android.versionName/Code, so a missing conf version ships the APK as
// versionCode 1 / versionName "1.0" (the v1.4.58 regression).

const CARGO = `[package]\nname = "velta-app"\nversion = "1.4.57"\ndescription = "Velta"\n\n[[bin]]\nname = "velta-app"\npath = "src/main.rs"\n`;
const LOCK = `# some crate\n[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "velta-app"\nversion = "1.4.57"\n\ndependencies = []\n`;
const CONF = `{\n  "$schema": "https://schema.tauri.app/config/2",\n  "productName": "Velta",\n  "identifier": "org.velta",\n  "build": {}\n}\n`;

function rig() {
  const files = new Map([
    ["velta-app/src-tauri/Cargo.toml", CARGO],
    ["velta-app/src-tauri/Cargo.lock", LOCK],
    ["velta-app/src-tauri/tauri.conf.json", CONF],
  ]);
  return {
    read: (p) => {
      if (!files.has(p)) throw new Error(`unexpected read: ${p}`);
      return files.get(p);
    },
    write: (p, c) => files.set(p, c),
    files,
  };
}

test("bump rewrites Cargo.toml, lock, version.gen.js; strips v prefix", () => {
  const r = rig();
  const { from, to } = bumpVersion("v1.4.58", r.read, r.write);
  assert.equal(from, "1.4.57");
  assert.equal(to, "1.4.58");
  assert.match(r.files.get("velta-app/src-tauri/Cargo.toml"), /version = "1\.4\.58"/);
  assert.match(r.files.get("velta-app/src-tauri/Cargo.toml"), /\[\[bin\]\]/); // rest intact
  assert.match(
    r.files.get("velta-app/src-tauri/Cargo.lock"),
    /\[\[package\]\]\nname = "velta-app"\nversion = "1\.4\.58"/,
  );
  assert.match(r.files.get("velta-app/src-tauri/Cargo.lock"), /name = "other"\nversion = "9\.9\.9"/); // untouched
  assert.match(r.files.get("app/js/version.gen.js"), /APP_VERSION = "1\.4\.58"/);
  assert.match(
    r.files.get("velta-app/src-tauri/tauri.conf.json"),
    /"identifier": "org\.velta",\n  "version": "1\.4\.58",\n  "build"/,
  ); // inserted after identifier, rest intact
});

test("bump handles CRLF lockfiles (Windows checkout)", () => {
  const r = rig();
  r.write("velta-app/src-tauri/Cargo.lock", LOCK.replace(/\n/g, "\r\n"));
  bumpVersion("1.4.58", r.read, r.write);
  assert.match(r.files.get("velta-app/src-tauri/Cargo.lock"), /name = "velta-app"\r\nversion = "1\.4\.58"/);
});

test("bump is idempotent and rejects junk", () => {
  const r = rig();
  bumpVersion("1.4.57", r.read, r.write);
  bumpVersion("1.4.57", r.read, r.write); // conf now carries a version → update path
  assert.equal(r.files.get("velta-app/src-tauri/Cargo.toml"), CARGO); // no-op rewrite
  assert.match(r.files.get("velta-app/src-tauri/tauri.conf.json"), /"version": "1\.4\.57"/);
  assert.throws(() => bumpVersion("banana", r.read, r.write), /semver/);
  assert.throws(
    () => bumpVersion("1.4.58", () => CARGO.replace(/^version = .*$/m, "name only"), () => {}),
    /version key/,
  );
});

test("bump moves README download links to the new version, sizes untouched", () => {
  const r = rig();
  const README =
    "## Download\n\n" +
    "**[Android](https://github.com/pbuzdin/velta/releases/download/v1.4.57/Velta-1.4.57-arm64.apk)** (~49 MB) · " +
    "**[Windows](https://github.com/pbuzdin/velta/releases/download/v1.4.57/Velta_1.4.57_x64-setup.exe)** (~13 MB) · " +
    "**[macOS](https://github.com/pbuzdin/velta/releases/download/v1.4.57/Velta_1.4.57_universal.dmg)** (~36 MB)\n" +
    "See the [latest release](https://github.com/pbuzdin/velta/releases/latest).\n";
  r.write("README.md", README);
  bumpVersion("1.4.58", r.read, r.write);
  const out = r.files.get("README.md");
  assert.match(out, /releases\/download\/v1\.4\.58\/Velta-1\.4\.58-arm64\.apk\)\*\* \(~49 MB\)/);
  assert.match(out, /releases\/download\/v1\.4\.58\/Velta_1\.4\.58_x64-setup\.exe\)\*\* \(~13 MB\)/);
  assert.match(out, /releases\/download\/v1\.4\.58\/Velta_1\.4\.58_universal\.dmg\)\*\* \(~36 MB\)/);
  assert.doesNotMatch(out, /1\.4\.57/);
  assert.match(out, /releases\/latest\)/); // unrelated links untouched
});
