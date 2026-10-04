import test from "node:test";
import assert from "node:assert/strict";
import { bumpVersion } from "../tools/bump.mjs";

// The bump command's contract: rewrite [package].version (first match — the
// [package] section precedes any [[bin]]), the velta-app entry in Cargo.lock,
// and regenerate version.gen.js. tauri.conf.json must stay untouched (it has
// no version — Tauri falls back to Cargo.toml natively).

const CARGO = `[package]\nname = "velta-app"\nversion = "1.4.57"\ndescription = "Velta"\n\n[[bin]]\nname = "velta-app"\npath = "src/main.rs"\n`;
const LOCK = `# some crate\n[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "velta-app"\nversion = "1.4.57"\n\ndependencies = []\n`;

function rig() {
  const files = new Map([
    ["velta-app/src-tauri/Cargo.toml", CARGO],
    ["velta-app/src-tauri/Cargo.lock", LOCK],
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
  assert.equal(r.files.get("velta-app/src-tauri/Cargo.toml"), CARGO); // no-op rewrite
  assert.throws(() => bumpVersion("banana", r.read, r.write), /semver/);
  assert.throws(
    () => bumpVersion("1.4.58", () => CARGO.replace(/^version = .*$/m, "name only"), () => {}),
    /version key/,
  );
});
