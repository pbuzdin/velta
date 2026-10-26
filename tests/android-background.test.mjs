import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Android background work (velta-android-bg-audit): pins the Kotlin and Rust
// sources, comment-stripped. There is no Android runtime in these tests;
// on-device checks are listed in the commit messages.
const kt = new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/", import.meta.url);
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const read = (name) => strip(readFileSync(new URL(name, kt), "utf8"));

test("CoreService holds no wake lock", () => {
  const s = read("CoreService.kt");
  assert.doesNotMatch(s, /WakeLock|PARTIAL_WAKE_LOCK|newWakeLock|\.acquire\(/);
});

const rs = (name) => strip(readFileSync(new URL(`../velta-app/src-tauri/src/${name}`, import.meta.url), "utf8"));

test("background reconnect nudge: ~10 min, skipped while push delivers", () => {
  const lib = rs("lib.rs");
  const ev = rs("bg_events.rs");
  const m = ev.match(/BG_KICK_INTERVAL_SECS: u64 = (\d+)/);
  assert.ok(m && Number(m[1]) >= 300 && Number(m[1]) <= 900, "interval 5-15 min");
  const kicker = lib.slice(lib.indexOf("fn start_bg_fetch_kicker"), lib.indexOf("static BG_RPC_COUNTER"));
  assert.match(kicker, /BG_KICK_INTERVAL_SECS/);
  assert.match(kicker, /bg_kick_due_now\(\)/);
  assert.doesNotMatch(kicker, /from_secs\(90\)/);
  assert.match(lib, /PUSH_ENDPOINT_SET\.store\(true/);
  assert.match(lib, /Java_org_velta_UnifiedPushService_pushUnregistered/);
  assert.match(read("UnifiedPushService.kt"), /pushUnregistered\(\)/);
});

test("no call to the non-existent maybe_network_lost JSON-RPC method", () => {
  assert.doesNotMatch(rs("lib.rs"), /spawn_core_rpc\("maybe_network_lost"/);
});
