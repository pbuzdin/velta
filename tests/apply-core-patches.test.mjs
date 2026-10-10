import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// tools/apply-core-patches.py is the only sanctioned way to change the
// vendored core (AGENTS.md). Its verify mode used to be a false green: an op
// whose marker AND anchor were both gone was skipped and still counted.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL = join(ROOT, "tools", "apply-core-patches.py");
const python = process.platform === "win32" ? "python" : "python3";
const run = (...args) => spawnSync(python, [TOOL, ...args], { encoding: "utf8" });

test("quilt tool self-test passes", () => {
  const r = run("self-test");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("vendored core carries every quilt op (verify)", () => {
  const r = run("verify");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /(\d+)\/\1 patch ops present/);
});

test("verify fails when an op's marker AND anchor are both gone (scratch copy)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "velta-quilt-"));
  try {
    for (const f of ["src/smtp.rs", "src/smtp/smtp_tests.rs", "src/scheduler.rs",
      "src/scheduler/connectivity.rs", "src/context.rs", "src/imap.rs"]) {
      cpSync(join(ROOT, "core", f), join(scratch, f), { recursive: true });
    }
    const imap = join(scratch, "src/imap.rs");
    // Remove the #13 block and its anchor text, as an upstream rewrite would.
    const text = readFileSync(imap, "utf8");
    const broken = text.replace(/push notifications registered/g, "x").replace(/Failed to store device token/g, "y");
    assert.notEqual(broken, text);
    writeFileSync(imap, broken);
    const r = run("verify", "--core", scratch);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /MISSING: #13 .*anchor gone/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
