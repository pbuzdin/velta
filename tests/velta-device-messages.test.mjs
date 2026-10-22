// Velta wording for core's device-chat texts: stock overrides applied at
// boot, Velta welcome added once (core label "core-welcome", first configure
// only), Delta Chat welcome photo blocked before the first configure.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { STOCK, STOCK_OVERRIDES, DEVICE_CHAT_HINT, VELTA_WELCOME, SUPPRESSED_DEVICE_LABELS } from "../app/js/velta-strings.js";

test("override map covers hint + welcome with the exact Velta texts", () => {
  assert.equal(STOCK_OVERRIDES[70], DEVICE_CHAT_HINT);
  assert.equal(DEVICE_CHAT_HINT, "This chat holds messages from Velta itself, like tips and updates. Only you see it, and it stays on this device.");
  assert.equal(STOCK_OVERRIDES[71], VELTA_WELCOME);
  assert.ok(VELTA_WELCOME.startsWith("👋 Welcome to Velta!"));
  assert.ok(VELTA_WELCOME.endsWith("The Velta team"));
  assert.equal((VELTA_WELCOME.match(/^• /gm) || []).length, 7);
});

test("ids match core stock_str.rs and no override says Delta Chat as the app", () => {
  const src = readFileSync(new URL("../core/src/stock_str.rs", import.meta.url), "utf8");
  for (const [name, id] of Object.entries(STOCK)) assert.match(src, new RegExp(`\\b${name} = ${id},`));
  for (const [id, text] of Object.entries(STOCK_OVERRIDES)) {
    assert.doesNotMatch(text, /a7\.velta\.cc|delta\.chat/i, `id ${id}`);
    // Only the welcome may name Delta Chat, as the network you can reach.
    if (Number(id) !== 71) assert.doesNotMatch(text, /Delta Chat/, `id ${id}`);
  }
});

// Fake core with label dedup like chat::add_device_msg.
function fakeCore({ configured = false, labels = [] } = {}) {
  const st = { stock: null, labels: new Set(labels), configured, device: [], calls: [] };
  const core = new JsonRpcCore();
  core.accountId = 1;
  const configure = () => {
    if (!st.stock) throw new Error("configure before stock strings");
    for (const [label, text] of [["core-welcome-image", "<delta photo>"], ["core-welcome", st.stock[71]]]) {
      if (!st.labels.has(label)) { st.labels.add(label); st.device.push(text); }
    }
    st.configured = true;
  };
  core._call = async (m, ...a) => {
    st.calls.push(m);
    if (m === "set_stock_strings") { st.stock = a[0]; return null; }
    if (m === "is_configured") return st.configured;
    if (m === "add_device_message") { if (!st.labels.has(a[1])) { st.labels.add(a[1]); if (a[2]) st.device.push(a[2].text); } return null; }
    if (m === "add_transport_from_qr" || m === "add_transport" || m === "init_transports") return configure();
    return null;
  };
  core._callWithTimeout = (_t, m, ...a) => core._call(m, ...a);
  return { core, st };
}

test("new account: Velta welcome once, no Delta Chat photo", async () => {
  const { core, st } = fakeCore();
  await core._applyVeltaStrings();
  await core.addTransportFromQr("dcaccount:x");
  await core.addTransportFromQr("dcaccount:y"); // second relay → configure again
  assert.deepEqual(st.device, [VELTA_WELCOME]);
  assert.ok(SUPPRESSED_DEVICE_LABELS.every((l) => st.labels.has(l)));
});

test("existing configured account: nothing added, labels untouched", async () => {
  const { core, st } = fakeCore({ configured: true, labels: ["core-welcome-image", "core-welcome"] });
  await core._applyVeltaStrings();
  await core.initTransports();
  assert.deepEqual(st.device, []);
  assert.ok(!st.calls.includes("add_device_message"));
});

test("init and reconnect apply the stock overrides before anything else", () => {
  const src = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  const init = src.slice(src.indexOf("async init()"), src.indexOf("async reconnect()"));
  assert.ok(init.indexOf("_applyVeltaStrings") < init.indexOf("add_account"));
  const rc = src.slice(src.indexOf("async reconnect()"), src.indexOf("get syncOnlyActive"));
  assert.match(rc, /_applyVeltaStrings/);
});
