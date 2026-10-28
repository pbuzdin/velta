import test from "node:test";
import assert from "node:assert/strict";
globalThis.window ??= {};
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
const { DiagnosticsStore, stripBuildPaths } = await import("../app/js/diagnostics.js");

test("CI build path prefix is stripped, core/src/…:line kept", () => {
  assert.equal(stripBuildPaths("/home/runner/work/velta/velta/core/src/sql.rs:971: Start housekeeping..."), "core/src/sql.rs:971: Start housekeeping...");
  assert.equal(stripBuildPaths("D:\\a\\velta\\velta\\core\\src\\imap.rs:12: x"), "core\\src\\imap.rs:12: x");
  assert.equal(stripBuildPaths("core/src/a.rs:1"), "core/src/a.rs:1");
  assert.equal(stripBuildPaths("saved /home/u/file.txt"), "saved /home/u/file.txt");
});

test("store keeps the stripped text and logs quota root-name lines once", () => {
  const s = new DiagnosticsStore();
  const line = '/home/runner/work/velta/velta/core/src/scheduler/connectivity.rs:457: connectivity: root name hidden: "User quota"';
  for (let i = 0; i < 10; i++) { s.append("info", line); s.append("info", "other"); }
  const hits = s.messages.filter(m => m.text.includes("root name hidden"));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 1);
  assert.match(hits[0].text, /^\[INFO\] core\/src\/scheduler\/connectivity\.rs:457:/);
});
