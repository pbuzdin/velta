import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
const sidecar = readFileSync(new URL("../velta-app/src-tauri/src/sidecar.rs", import.meta.url), "utf8");
const push = readFileSync(new URL("../velta-app/src-tauri/src/push.rs", import.meta.url), "utf8");
const log = readFileSync(new URL("../velta-app/src-tauri/src/log.rs", import.meta.url), "utf8");
const rust = `${lib}\n${sidecar}\n${push}`;

test("#197 boot: heartbeats exist for each startup stage", () => {
  for (const line of [
    'log("boot: sidecar spawned")',
    'log("boot: rpc session ready")',
    'log("boot: db key applied")',
    'log("boot: db key keyless")',
    'log("boot: transports booted")',
    'log("boot: in-process core ready")',
    'log("boot: push registered")',
  ]) {
    assert.ok(rust.includes(line) || rust.includes(`crate::${line}`), line);
  }
});

test("#197 boot: lines are rate-limit exempt", () => {
  assert.match(log, /starts_with\("boot:"\)/);
  assert.match(log, /fn rate_exempt/);
});

test("#197 desktop: db key heartbeat before sidecar; transports after proxy/ws boot", () => {
  const spawn = sidecar.slice(sidecar.indexOf("fn spawn_sidecar"), sidecar.indexOf("fn resolve_web_line"));
  const spawned = spawn.indexOf('log("boot: sidecar spawned")');
  const rpc = spawn.indexOf('log("boot: rpc session ready")');
  const proxy = spawn.indexOf("proxy::boot(");
  const ws = spawn.indexOf("ws_transport::boot(");
  const transports = spawn.indexOf('log("boot: transports booted")');
  assert.ok(spawned > 0 && rpc > spawned, "sidecar then rpc");
  assert.ok(proxy > rpc && ws > proxy && transports > ws, "transports after proxy/ws boot");

  const setup = lib.slice(lib.indexOf("db_key::startup(&accounts)"), lib.indexOf("spawn_sidecar(&app_handle, db_key, true)"));
  assert.match(setup, /boot: db key applied/);
  assert.match(setup, /boot: db key keyless/);
});

test("#197 android: headless init emits the stages it reaches", () => {
  const init = lib.slice(lib.indexOf("async fn init_android_core("), lib.indexOf("let state = CommandApi::from_arc"));
  assert.match(init, /boot: db key applied/);
  assert.match(init, /boot: db key keyless/);
  assert.match(init, /Accounts::new[\s\S]*boot: in-process core ready/);
  assert.match(init, /boot: push registered/);

  const ensure = lib.slice(lib.indexOf("fn ensure_android_core"), lib.indexOf("async fn android_core_tx"));
  const rpc = ensure.indexOf('log("boot: rpc session ready")');
  const proxy = ensure.indexOf("proxy::boot(");
  const ws = ensure.indexOf("ws_transport::boot_now(");
  const transports = ensure.indexOf('log("boot: transports booted")');
  assert.ok(rpc > 0 && proxy > rpc && ws > proxy && transports > ws, "android rpc then transports");
});
