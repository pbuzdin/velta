// README version pins must match tauri.conf.json / core/Cargo.toml (#200).
// A local sidecar, if present, must print that same core version (gitignored;
// CI Ubuntu has no exe, so that assertion is skipped when the file is absent).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

function appVersion() {
  const conf = JSON.parse(read("velta-app/src-tauri/tauri.conf.json"));
  assert.equal(typeof conf.version, "string");
  assert.match(conf.version, /^\d+\.\d+\.\d+/);
  return conf.version;
}

function coreVersion() {
  const cargo = read("core/Cargo.toml");
  const pkg = cargo.match(/^\[package\][^\[]*/m);
  assert.ok(pkg, "core/Cargo.toml [package] section");
  const m = pkg[0].match(/^version = "([^"]+)"/m);
  assert.ok(m, "core/Cargo.toml [package].version");
  return m[1];
}

function hostTriple() {
  const r = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = (r.status === 0 ? r.stdout : "").match(/^host:\s+(\S+)/m);
  return m?.[1] ?? null;
}

function sidecarPath() {
  const dir = join(ROOT, "velta-app", "src-tauri", "binaries");
  const names = ["deltachat-rpc-server-x86_64-pc-windows-msvc.exe"];
  const triple = hostTriple();
  if (triple) {
    names.push(`deltachat-rpc-server-${triple}`);
    names.push(`deltachat-rpc-server-${triple}.exe`);
  }
  for (const name of names) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function re(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("velta-app README pins the tauri.conf and core Cargo.toml versions", () => {
  const app = appVersion();
  const core = coreVersion();
  const readme = read("velta-app/README.md");
  assert.match(readme, new RegExp(`Current stable version:\\*\\*\\s*\`${re(app)}\``));
  assert.match(readme, new RegExp(`deltachat-core-rust ${re(core)}`));
  assert.match(readme, /tauri\.conf\.json/);
  assert.match(readme, /core\/Cargo\.toml/);
});

const sidecar = sidecarPath();
test("bundled sidecar --version matches vendored core", { skip: !sidecar && "sidecar binary not present" }, () => {
  const core = coreVersion();
  const r = spawnSync(sidecar, ["--version"], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const printed = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.ok(
    printed.includes(core),
    `--version printed ${JSON.stringify(printed)}, expected ${core}`,
  );
});
