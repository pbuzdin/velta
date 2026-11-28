import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setLinkPreviewProxySource, shellProxy } from "../app/js/shell-proxy.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("shellProxy: unknown setting throws, known one returns the URL or null", async () => {
  setLinkPreviewProxySource(null);
  await assert.rejects(shellProxy(), /not known/);
  setLinkPreviewProxySource(async () => "socks5://127.0.0.1:1080");
  assert.equal(await shellProxy(), "socks5://127.0.0.1:1080");
  setLinkPreviewProxySource(async () => "");
  assert.equal(await shellProxy(), null);
  setLinkPreviewProxySource(null);
});

test("relay status and update checks hand the configured proxy to the shell", () => {
  const ui = read("../app/js/ui.js");
  assert.match(ui, /invoke\("get_latest_version", \{ proxy: await shellProxy\(\) \}\)/);
  assert.match(ui, /invoke\("download_update", \{ version: updateInfo\.version, proxy: await shellProxy\(\) \}\)/);
  assert.match(ui, /updater\.check\(proxy \? \{ proxy \} : undefined\)/);
  const app = read("../app/js/app.js");
  assert.match(app, /invoke\("probe_relay", \{ domain, proxy \}\)/);
  assert.match(app, /const proxy = await shellProxy\(\);\s*\n\s*return !!\(await invoke\("probe_relay"/);
});

test("shell commands take the proxy and skip (never go direct) when it can't be applied", () => {
  const lib = read("../velta-app/src-tauri/src/lib.rs");
  assert.match(lib, /async fn get_latest_version\(proxy: Option<String>\)/);
  assert.match(lib, /async fn probe_relay\(domain: String, proxy: Option<String>\)/);
  assert.match(lib, /fn check_agent\(proxy: Option<&str>/);
  assert.match(lib, /mod check_proxy_tests/);
  // no bare agents left in the checks
  const slice = lib.slice(lib.indexOf("async fn get_latest_version"), lib.indexOf("fn link_preview_proxy"));
  assert.doesNotMatch(slice.replace(/fn check_agent[\s\S]*?\n}\n/, ""), /AgentBuilder::new\(\)\s*\.timeout\(std::time::Duration::from_secs\(\d\)\)\s*\.build/);
  const c3 = read("../velta-app/src-tauri/src/c3_probe.rs");
  assert.match(c3, /tcp_connect\(host, 443, proxy\)/);
  assert.doesNotMatch(c3, /TcpStream::connect_timeout/);
});
