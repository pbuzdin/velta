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

test("cold start: VeltaApp loads the library; every entry point starts the core", () => {
  const manifest = readFileSync(new URL("../../../AndroidManifest.xml", kt), "utf8");
  assert.match(manifest, /<application[^>]*android:name="\.VeltaApp"/);
  assert.match(read("VeltaApp.kt"), /VeltaCore\.load\(this\)/);
  const core = read("VeltaCore.kt");
  assert.match(core, /System\.loadLibrary\("velta_app"\)/);
  assert.match(core, /external fun startHeadless\(dataDir: String, extDir: String\): Boolean/);
  assert.match(read("CoreService.kt"), /VeltaCore\.ensureStarted\(this\)/);
  const push = read("UnifiedPushService.kt");
  const onMessage = push.slice(push.indexOf("override fun onMessage"), push.indexOf("override fun onRegistrationFailed"));
  assert.ok(onMessage.indexOf("VeltaCore.ensureStarted") < onMessage.indexOf("pushWakeup()"), "core before wake-up");
  assert.match(read("BackgroundFetchJob.kt"), /VeltaCore\.ensureStarted\(this\)/);
  const alarm = read("ScheduledAlarm.kt");
  const recv = alarm.slice(alarm.indexOf("class ScheduledAlarmReceiver"));
  assert.ok(recv.indexOf("VeltaCore.ensureStarted") < recv.lastIndexOf("scheduledWakeup()"), "core before the send");
  assert.match(recv, /ACTION_BOOT_COMPLETED[\s\S]*CoreService\.start/);
});

test("cold start: one core, shared with Tauri setup; no AppHandle needed", () => {
  const lib = rs("lib.rs");
  assert.match(lib, /static ANDROID_CORE: std::sync::OnceLock<RpcState>/);
  assert.match(lib, /fn Java_org_velta_VeltaCore_startHeadless/);
  const setup = lib.slice(lib.indexOf(".setup(|app|"), lib.indexOf('#[cfg(not(target_os = "android"))]', lib.indexOf("let reused = android_core()")));
  assert.match(setup, /ensure_android_core\(accounts\)/);
  assert.match(setup, /app\.manage\(state\.clone\(\)\)/);
  assert.doesNotMatch(setup, /Runtime::new\(\)/, "setup no longer builds its own core runtime");
  const init = lib.slice(lib.indexOf("async fn init_android_core("), lib.indexOf("static LAST_MAYBE_NETWORK_MS"));
  assert.doesNotMatch(init, /AppHandle|app_handle/);
  assert.equal((lib.match(/Accounts::new\(/g) || []).length, 1, "one place creates Accounts");
  // A headless core starts IO itself; with the page in the process the page does.
  assert.match(lib, /if !ACTIVITY_LAUNCHED\.load[\s\S]{0,400}start_io\(\)/);
  assert.match(rs("scheduled.rs"), /android_core_tx\(/);
});

test("the service notification never claims to sync without a core", () => {
  const s = read("CoreService.kt");
  assert.match(s, /buildNotification\(starting\)/);
  assert.match(s, /R\.string\.bg_not_syncing/);
  assert.match(s, /VeltaCore\.running\(\)/);
  for (const loc of ["values", "values-fr", "values-ru"]) {
    const x = readFileSync(new URL(`../../../res/${loc}/bg_strings.xml`, kt), "utf8");
    for (const k of ["bg_channel_name", "bg_syncing", "bg_not_syncing"]) assert.match(x, new RegExp(`name="${k}"`), `${loc} ${k}`);
  }
});
