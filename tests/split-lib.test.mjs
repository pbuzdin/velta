import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rs = (p) => readFileSync(new URL(`../velta-app/src-tauri/src/${p}`, import.meta.url), "utf8");
const lib = rs("lib.rs");
const sidecar = rs("sidecar.rs");
const push = rs("push.rs");

test("#205 sidecar spawn and reader live in sidecar.rs", () => {
  assert.match(lib, /\bmod sidecar;/);
  assert.doesNotMatch(lib, /fn spawn_sidecar\(/);
  assert.match(sidecar, /pub\(crate\) fn spawn_sidecar\(/);
  assert.match(sidecar, /fn route_sidecar_line\(line: &str\) -> Route/);
  assert.match(lib, /sidecar::spawn_sidecar\(/);
});

test("#205 UnifiedPush commands and JNI live in push.rs", () => {
  assert.match(lib, /\bmod push;/);
  assert.doesNotMatch(lib, /fn push_status\(/);
  assert.match(push, /pub fn push_status\(/);
  assert.match(push, /Java_org_velta_UnifiedPushService_pushEndpointReceived/);
  assert.match(lib, /push::push_status/);
  assert.match(lib, /\bpush_status\b.*share_text/);
});
