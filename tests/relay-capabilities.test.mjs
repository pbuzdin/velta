import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Relay capability flags in "Relays of this profile" (VENDORISSUES #15):
// C = calls (TURN credentials over IMAP METADATA — the same behavioral
// signal cmcall uses), I = iroh relay, P = push, W = web/C3 endpoints
// (probed). Silver = not offered / not known, green = advertised.

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("rpc-core exposes get_server_metadata; mock twin keeps demo mode honest", () => {
  const rpc = read("app/js/rpc-core.js");
  assert.match(rpc, /async getServerMetadata\(\) \{/);
  assert.match(rpc, /this\._call\("get_server_metadata", this\.accountId\)/);
  const mock = read("app/js/mock-core.js");
  assert.match(mock, /async getServerMetadata\(\) \{/);
});

test("core patch: per-transport metadata RPC rides the quilt as #15", () => {
  const tool = read("tools/apply-core-patches.py");
  assert.match(tool, /id="#15 TransportServerMetadata \+ Context::get_server_metadata \(transport\.rs\)"/);
  assert.match(tool, /id="#15 get_server_metadata \(api\.rs\)"/);
  assert.match(tool, /pub async fn get_server_metadata\(&self\) -> Result<BTreeMap<String, TransportServerMetadata>>/);
  // has_turn must require a REAL Turn server — the core fabricates fallback
  // STUN servers when metadata is missing, and those are not call support.
  assert.match(tool, /matches!\(s, UnresolvedIceServer::Turn \{ \.\. \}\)/);
});

test("modal: address + flags share the first row, actions sit on the second", () => {
  const app = read("app/js/app.js");
  const css = read("app/css/main.css");
  // Two-line card layout.
  assert.match(app, /class="relay-line"[\s\S]*?class="relay-flags"/);
  assert.match(app, /class="relay-actions"/);
  // C, I, P read the core's metadata; P keeps the #110 diagnostic fallback.
  assert.match(app, /flag\("C", "Calls: the relay hands out TURN credentials", !!meta\?\.hasTurn\)/);
  assert.match(app, /flag\("I", "iroh relay: helps Beam and peer-to-peer transfers", !!meta\?\.irohRelay\)/);
  assert.match(app, /!!meta\?\.supportsPush \|\| relaySupportsPush\(addr\)/);
  // W is probe-based, cached per domain per session.
  assert.match(app, /data-flag-w/);
  assert.match(app, /relayC3Flags\.set\(wDomain, probe\)/);
  // Old cores without the RPC degrade to silver, not a crash.
  assert.match(app, /await core\.getServerMetadata\?\.\(\)/);
  // Silver/green states in CSS with the established chip colors.
  assert.match(css, /\.relay-flag \{[^}]*#9aa0a6/);
  assert.match(css, /\.relay-flag\.on \{ color: #2ecc71; \}/);
  assert.match(css, /\.relay-card \{ display: flex; flex-direction: column/);
});

test("flags only claim what the relay advertised — no optimistic defaults", () => {
  const app = read("app/js/app.js");
  // Every metadata flag starts from the meta object (null-safe), never
  // defaults to on.
  assert.match(app, /const relayFlagsHtml = \(addr, meta\) =>/);
  assert.doesNotMatch(app, /hasTurn \|\| true|irohRelay \|\| true|supportsPush \|\| true/);
});

test("failover hint: the pinned relay says where sends went, the carrier says failover", () => {
  const app = read("app/js/app.js");
  // smtpVia comes from the modal's own connectivity parse, not stale state.
  assert.match(app, /statusByDomain = new Map\(parsed\.segs\.map\(s => \[s\.domain, s\]\)\)/);
  assert.match(app, /smtpVia = parsed\.smtpVia/);
  // The pin's row: "· sending — send failed, switched to X for now" only
  // when the bound transport differs from the pin; the carrier row gets
  // "(failover)". No failover → plain "· sending".
  assert.match(app, /· sending\$\{failedOver \? ` — send failed, switched to \$\{escapeHtml\(smtpVia\)\} for now` : ""\}/);
  assert.match(app, /· sending \(failover\)/);
  assert.match(app, /const failedOver = !!viaDomain && viaDomain !== pinnedDomain;/);
});
