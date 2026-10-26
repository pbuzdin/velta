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

test("'Use background connection' off stops CoreService; on starts it", () => {
  const lib = rs("lib.rs");
  const fn = lib.slice(lib.indexOf("fn set_notify_prefs"), lib.indexOf("fn android_core_service"));
  assert.match(fn, /was_bg != prefs\.use_bg_connection/);
  assert.match(fn, /android_core_service\(prefs\.use_bg_connection\)/);
  assert.match(lib, /\("CoreService", &APP_CORE_SERVICE_CLASS\)/);
  const s = read("CoreService.kt");
  assert.match(s, /@JvmStatic\s+fun stop\(context: Context\)[\s\S]*stopService/);
  assert.match(s, /@JvmStatic\s+fun start\(context: Context\)/);
  const cmd = s.slice(s.indexOf("override fun onStartCommand"), s.indexOf("private fun startForegroundCompat"));
  assert.ok(cmd.indexOf("backgroundConnectionEnabled") < cmd.indexOf("ensureStarted"), "checked before starting the core");
  assert.match(cmd, /stopSelf\(\)[\s\S]*START_NOT_STICKY/);
  assert.match(read("MainActivity.kt"), /if \(BgPrefs\.backgroundConnectionEnabled\(this\)\) \{\s*try \{\s*CoreService\.start\(this\)/);
});

test("background job finishes when the fetch is done and honours onStopJob", () => {
  const s = read("BackgroundFetchJob.kt");
  assert.doesNotMatch(s, /postDelayed|FETCH_GRACE_MS/, "no fixed 28 s hold");
  assert.match(s, /fetchBlocking\(FETCH_MAX_SECS\)[\s\S]*jobFinished\(params, false\)/);
  const stop = s.slice(s.indexOf("override fun onStopJob"), s.indexOf("companion object"));
  assert.match(stop, /stopFetch\(\)/);
  assert.match(stop, /return true/);
  const lib = rs("lib.rs");
  assert.match(lib, /fn Java_org_velta_BackgroundFetchJob_fetchBlocking/);
  assert.match(lib, /fn Java_org_velta_BackgroundFetchJob_stopFetch[\s\S]{0,600}stop_background_fetch\(\)/);
});

test("DNS tunnel / WS transport start before IO, with a health check", () => {
  const lib = rs("lib.rs");
  const init = lib.slice(lib.indexOf("fn ensure_android_core"), lib.indexOf("async fn android_core_tx"));
  const boot = init.indexOf("tunnel::boot(");
  const ws = init.indexOf("ws_transport::boot_now(");
  const reapply = init.indexOf("tunnel::reapply_proxy().await");
  const publish = init.indexOf("*tx_holder.lock().unwrap() = Some(tx)");
  const io = init.indexOf("start_io().await");
  assert.ok(boot > 0 && ws > boot && reapply > ws && publish > reapply && io > publish, "proxies, then tx, then IO");
  const tunnel = rs("tunnel.rs");
  assert.match(tunnel, /fn check_alive\(app: &crate::Host\)[\s\S]*connect_timeout[\s\S]*start\(app, cfg\)/);
  assert.match(tunnel, /check_network\(&app\);\s*check_alive\(&app\);/);
  const wst = rs("ws_transport.rs");
  assert.match(wst, /fn start_keeper[\s\S]*health\(&app\)\.await/);
  assert.match(wst, /async fn health[\s\S]*TcpStream::connect\(addr\)[\s\S]*start_active/);
});

const { dontKillMyAppUrl, makerLabel, shouldAskBattery, rememberBatteryAnswer, BATTERY_DISMISSED_KEY } =
  await import("../app/js/battery-prompt.js");

test("battery prompt: asked once, the answer is remembered", () => {
  const m = new Map();
  const storage = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
  assert.equal(shouldAskBattery({ exempt: true, storage }), false, "already exempt");
  assert.equal(shouldAskBattery({ exempt: false, storage }), true, "first time");
  rememberBatteryAnswer(storage);
  assert.equal(m.get(BATTERY_DISMISSED_KEY), "1");
  assert.equal(shouldAskBattery({ exempt: false, storage }), false, "never again after an answer");
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("async function askBatteryExemption"), app.indexOf("function batteryPromptModal"));
  assert.match(fn, /shouldAskBattery\(/);
  assert.ok(fn.indexOf("rememberBatteryAnswer") < fn.indexOf("if (!ok) return"), "dismissal remembered too");
});

test("battery prompt: dontkillmyapp.com page for the phone's maker", () => {
  assert.equal(dontKillMyAppUrl("Xiaomi"), "https://dontkillmyapp.com/xiaomi");
  assert.equal(dontKillMyAppUrl("POCO"), "https://dontkillmyapp.com/xiaomi");
  assert.equal(dontKillMyAppUrl("samsung"), "https://dontkillmyapp.com/samsung");
  assert.equal(dontKillMyAppUrl("HUAWEI"), "https://dontkillmyapp.com/huawei");
  assert.equal(dontKillMyAppUrl("HMD Global"), "https://dontkillmyapp.com/nokia");
  assert.equal(dontKillMyAppUrl("Acme"), "https://dontkillmyapp.com/");
  assert.equal(dontKillMyAppUrl(""), "https://dontkillmyapp.com/");
  assert.equal(makerLabel("xiaomi"), "Xiaomi");
  assert.equal(makerLabel(""), "");
  assert.match(read("Battery.kt"), /fun maker\(\): String = android\.os\.Build\.MANUFACTURER/);
  assert.match(rs("lib.rs"), /generate_handler!\[[^\]]*\bdevice_maker\b/);
});

test("battery prompt strings are translated (fr, ru)", async () => {
  const fr = JSON.parse(readFileSync(new URL("../app/locales/fr.json", import.meta.url), "utf8"));
  const ru = JSON.parse(readFileSync(new URL("../app/locales/ru.json", import.meta.url), "utf8"));
  for (const k of ["Keep messages arriving", "Allow", "Not now", "Extra steps for {maker} phones", "Extra steps for your phone",
    "Phone still stops Velta? Extra steps for your phone",
    "Android stops Velta from syncing after you leave the app, so new messages wait until you open it. Allow unrestricted battery use so mail keeps arriving in the background."]) {
    assert.ok(fr[k], `fr: ${k}`);
    assert.ok(ru[k], `ru: ${k}`);
  }
  assert.match(fr["Extra steps for {maker} phones"], /\{maker\}/);
  assert.match(ru["Extra steps for {maker} phones"], /\{maker\}/);
});

// WCAG 2.x contrast of the link color on the modal / drawer surface.
function lum(hex) {
  const n = hex.replace("#", "");
  const c = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("battery prompt link meets WCAG AA in dark, light and brutal", () => {
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = sel => { const i = css.indexOf(sel + " {"); return css.slice(i, css.indexOf("\n}", i)); };
  const vars = src => Object.fromEntries([...src.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const root = vars(block(":root"));
  const themes = { dark: root, light: { ...root, ...vars(block('html[data-theme="light"]')) }, brutal: { ...root, ...vars(block('html[data-theme="brutal"]')) } };
  const resolve = (v, map) => { for (let i = 0; i < 10 && /^var\(/.test(v); i++) v = map[v.match(/var\((--[\w-]+)/)[1]]; return v; };
  assert.match(css, /\.bat-dkma \{[^}]*color: var\(--accent-text\)[^}]*text-decoration: underline/);
  for (const [name, map] of Object.entries(themes)) {
    const fg = resolve("var(--accent-text)", map);
    const bg = resolve("var(--bg-sidebar)", map);
    assert.match(fg, /^#[0-9a-f]{6}$/i, `${name} fg ${fg}`);
    assert.match(bg, /^#[0-9a-f]{6}$/i, `${name} bg ${bg}`);
    assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}`);
  }
});
