import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Android: after a send, chat switching hung until the 30 s RPC timeout.
// A saved DNS tunnel set to "off" still ran as every profile's proxy; SMTP
// over it stalled, an IO restart held the scheduler, maybe_network waited on
// it while holding the account manager lock, and a queued start_io/stop_io
// writer then blocked every UI RPC (get_chat, get_messages).
const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (text, sig) => {
  const from = text.indexOf(sig);
  assert.notEqual(from, -1, `missing ${sig}`);
  return text.slice(from, text.indexOf("\n}", from));
};

test("maybe_network never awaits interrupts under the account lock", () => {
  const lock = /\.read\(\)\.await\.maybe_network\(\)\.await/;
  assert.doesNotMatch(fnBody(src("velta-app/src-tauri/src/tunnel_android.rs"), "pub async fn maybe_network"), lock);
  assert.doesNotMatch(fnBody(src("core/deltachat-jsonrpc/src/api.rs"), "async fn maybe_network(&self)"), lock);
});

test("background fetch never runs while the app is in the foreground", () => {
  const body = fnBody(src("velta-app/src-tauri/src/lib.rs"), "async fn background_fetch_once");
  const skip = body.indexOf("if android_ui_visible()");
  assert.ok(skip > 0 && skip < body.indexOf("background_fetch\""), "foreground check must come before the RPC");
  const secs = Number(/const BG_FETCH_TIMEOUT_SECS: f64 = ([\d.]+);/.exec(src("velta-app/src-tauri/src/lib.rs"))?.[1]);
  assert.ok(secs > 0 && secs <= 20, `background fetch bound ${secs}s`);
});

test("DNS tunnel mode off does not run the tunnel as the profiles' proxy", () => {
  const rs = src("velta-app/src-tauri/src/tunnel.rs");
  // Boot / health checks: an "off" tunnel has no run config, so the proxy
  // keeper clears a stale local proxy left on the profiles (startup repair).
  assert.match(fnBody(rs, "fn load_config("), /filter\(\|c\| !mode_off\(c\)\)/);
  assert.match(fnBody(rs, "fn start(app"), /if mode_off\(&cfg\) \{[\s\S]*?stop_running\(\);/);
  const setMode = fnBody(rs, "pub fn set_mode(");
  assert.match(setMode, /if mode == "off" \{[\s\S]*?stop_running\(\);/);
});
