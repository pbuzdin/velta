import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Velta #23 (#189): per-relay enable/disable — pause a relay without
// deleting it. Source-contract test in the relay-capabilities style: the
// RPC surface, the mock twin, the quilt ops, and the three exclusion
// points (send, inbox loops, background fetch) must all stay in place.

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("rpc-core exposes #23 RPCs; mock twin keeps demo mode honest", () => {
  const rpc = read("app/js/rpc-core.js");
  assert.match(rpc, /async setTransportEnabled\(addr, enabled\) \{/);
  assert.match(rpc, /this\._call\("set_transport_enabled", this\.accountId, addr, enabled\)/);
  assert.match(rpc, /async listTransportStates\(\) \{/);
  assert.match(rpc, /this\._call\("list_transport_states", this\.accountId\)/);
  const mock = read("app/js/mock-core.js");
  assert.match(mock, /async setTransportEnabled\(addr, enabled\) \{/);
  assert.match(mock, /async listTransportStates\(\) \{/);
  assert.match(mock, /enabled: !this\.pausedRelays\.includes\(d\)/);
});

test("Relays modal: toggle, dimmed card, off chip, all-paused hint", () => {
  const app = read("app/js/app.js");
  assert.match(app, /data-toggle>\$\{escapeHtml\(relayOn \? t\("Disable"\) : t\("Enable"\)\)\}/);
  assert.match(app, /relay-off-chip/);
  assert.match(app, /row\.classList\.add\("relay-off"\)/);
  assert.match(app, /All relays are paused — the profile is offline until one is enabled\./);
  assert.match(app, /await core\.setTransportEnabled\(tr\.addr, !relayOn\)/);
  const css = read("app/css/main.css");
  assert.match(css, /\.relay-card\.relay-off \.relay-addr \{ opacity: \.55; \}/);
});

test("core patch: paused transports ride the quilt as #23 and are excluded in all three paths", () => {
  const tool = read("tools/apply-core-patches.py");
  assert.match(tool, /id="#23 disabled-transport helpers \(transport\.rs\)"/);
  assert.match(tool, /id="#23 pinned transport ignores a paused relay \(smtp\.rs\)"/);
  assert.match(tool, /id="#23 send path excludes paused transports \(smtp\.rs\)"/);
  assert.match(tool, /id="#23 inbox loops skip paused transports \(scheduler\.rs\)"/);
  assert.match(tool, /VELTA_DISABLED_TRANSPORTS_KEY: &str = /);
  const transport = read("core/src/transport.rs");
  assert.match(transport, /pub async fn velta_set_transport_enabled\(/);
  const smtp = read("core/src/smtp.rs");
  assert.match(smtp, /paused transports never send/);
  assert.match(smtp, /a paused transport is never pinned/);
  const scheduler = read("core/src/scheduler.rs");
  assert.match(scheduler, /paused transports are not fetched/);
  assert.match(scheduler, /paused transports stay down/);
  const api = read("core/deltachat-jsonrpc/src/api.rs");
  assert.match(api, /async fn set_transport_enabled\(/);
  assert.match(api, /async fn list_transport_states\(/);
  const types = read("core/deltachat-jsonrpc/src/api/types/login_param.rs");
  assert.match(types, /pub struct VeltaTransportState \{/);
});
