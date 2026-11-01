import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Android: after a send, chat switching hung until the 30 s RPC timeout.
// A dead saved proxy stalled SMTP; an IO restart held the scheduler and
// maybe_network waited on it while holding the account manager lock, and a
// queued start_io/stop_io
// writer then blocked every UI RPC (get_chat, get_messages).
const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (text, sig) => {
  const from = text.indexOf(sig);
  assert.notEqual(from, -1, `missing ${sig}`);
  return text.slice(from, text.indexOf("\n}", from));
};

test("maybe_network never awaits interrupts under the account lock", () => {
  const lock = /\.read\(\)\.await\.maybe_network\(\)\.await/;
  assert.doesNotMatch(fnBody(src("velta-app/src-tauri/src/proxy_android.rs"), "pub async fn maybe_network"), lock);
  assert.doesNotMatch(fnBody(src("core/deltachat-jsonrpc/src/api.rs"), "async fn maybe_network(&self)"), lock);
});

test("background fetch never runs while the app is in the foreground", () => {
  const body = fnBody(src("velta-app/src-tauri/src/lib.rs"), "async fn background_fetch_once");
  const skip = body.indexOf("if android_ui_visible()");
  assert.ok(skip > 0 && skip < body.indexOf("background_fetch\""), "foreground check must come before the RPC");
  const secs = Number(/const BG_FETCH_TIMEOUT_SECS: f64 = ([\d.]+);/.exec(src("velta-app/src-tauri/src/lib.rs"))?.[1]);
  assert.ok(secs > 0 && secs <= 20, `background fetch bound ${secs}s`);
});

test("no selected proxy clears only keeper-owned profile URLs", () => {
  const rs = src("velta-app/src-tauri/src/proxy.rs");
  // Startup repair covers stale Velta URLs, while a manually configured
  // proxy always wins and is never overwritten by the keeper.
  assert.match(rs, /None if ours =>/);
  assert.match(rs, /Some\(_\) if !cur\.trim\(\)\.is_empty\(\) && !ours =>/);
  assert.match(rs, /cur\.starts_with\(LEGACY_TUNNEL\)/);
});

// Background fetch runs under a 15 s timeout; patch #12 restarts IO after
// 10 s and the stop alone can take 30 s. A restart dropped between stop and
// start left IO stopped until a manual core restart (#165).
test("patch #12 IO restart survives the background_fetch timeout", () => {
  for (const p of ["core/src/context.rs", "tools/apply-core-patches.py"]) {
    const s = src(p);
    assert.doesNotMatch(s, /\n\s*self\.restart_io_if_running\(\)\.await;\n\s*self\.wait_for_work_done/, p);
    assert.match(s, /tokio::spawn\(async move \{ ctx\.restart_io_if_running\(\)\.await \}\)/, p);
  }
});

test("resume logs account lock latency and connectivity", () => {
  const body = fnBody(src("velta-app/src-tauri/src/lib.rs"), "fn Java_org_velta_MainActivity_setActivityForeground");
  assert.match(body, /proxy::log_resume_state\(\)/);
});

// #176: send_msg / markseen_msgs signal the scheduler; an IO restart holds
// its write lock for up to 30 s per task, so these must never await it.
test("scheduler interrupts do not wait behind an IO restart", () => {
  const s = src("core/src/scheduler.rs");
  for (const n of ["interrupt_inbox", "interrupt_smtp", "interrupt_ephemeral_task", "interrupt_location", "interrupt_recently_seen"]) {
    const from = s.indexOf(`pub(crate) async fn ${n}(&self`);
    assert.notEqual(from, -1, n);
    const body = s.slice(from, s.indexOf("\n    }\n", from));
    assert.match(body, /self\.inner\.try_read\(\)/, n);
    assert.doesNotMatch(body, /self\.inner\.read\(\)\.await/, n);
  }
});
