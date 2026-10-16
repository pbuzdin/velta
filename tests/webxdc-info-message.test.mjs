// Webxdc info messages (sendUpdate({info})): core creates a
// SystemMessage::WebxdcInfoMessage whose parent is the app instance; Velta
// renders it as a tappable info row that opens the parent at its href.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";

installChatViewGlobals();
installFakeDocument();
const { JsonRpcCore } = await import("../app/js/rpc-core.js");
const { isWebxdcInfoMsg, webxdcStartPath, sendStatusUpdate } = await import("../app/js/webxdc-manager.js");
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("info messages carry parentId and webxdcHref from core", () => {
  const m = new JsonRpcCore()._mapMessage({
    id: 9, chatId: 3, fromId: 2, isInfo: true, text: "Alice scored 10", timestamp: 1, sortTimestamp: 1,
    state: 13, viewType: "Text", systemMessageType: "WebxdcInfoMessage", parentId: 7, webxdcHref: "#/score", sender: {},
  });
  assert.equal(m.kind, "service");
  assert.equal(m.parentId, 7);
  assert.equal(m.webxdcHref, "#/score");
  assert.equal(isWebxdcInfoMsg(m), true);
});

test("only WebxdcInfoMessage with a parent is an app notice", () => {
  assert.equal(isWebxdcInfoMsg({ kind: "service", systemType: "WebxdcInfoMessage", parentId: null }), false);
  assert.equal(isWebxdcInfoMsg({ kind: "service", systemType: "MemberAddedToGroup", parentId: 4 }), false);
  assert.equal(isWebxdcInfoMsg({ kind: "msg", systemType: "WebxdcInfoMessage", parentId: 4 }), false);
  assert.equal(isWebxdcInfoMsg(null), false);
});

test("href keeps query/fragment, never leaves index.html or the instance", () => {
  assert.equal(webxdcStartPath(""), "index.html");
  assert.equal(webxdcStartPath(undefined), "index.html");
  assert.equal(webxdcStartPath("#/game/1"), "index.html#/game/1");
  assert.equal(webxdcStartPath("index.html?x=1#y"), "index.html?x=1#y");
  assert.equal(webxdcStartPath("other.html?a=b"), "index.html?a=b");
  assert.equal(webxdcStartPath("https://evil.example/?q#h"), "index.html");
  assert.equal(webxdcStartPath("javascript:alert(1)"), "index.html");
  assert.equal(webxdcStartPath("//evil.example/x"), "index.html");
});

test("sendUpdate passes info/summary/document/href through to core verbatim", async () => {
  const calls = [];
  const core = { sendWebxdcStatusUpdate: async (...a) => { calls.push(a); } };
  const update = { payload: { s: 1 }, info: "Alice scored 10", summary: "Top: Alice", document: "Game", href: "#/s", notify: { "*": "x" } };
  await sendStatusUpdate(core, 7, { update, description: "" });
  assert.equal(calls[0][0], 7);
  assert.deepEqual(JSON.parse(calls[0][1]), update);
  await assert.rejects(sendStatusUpdate(core, 7, { update: null }));
  await assert.rejects(sendStatusUpdate(core, 7, { update: [1] }));
});

test("shim forwards the whole update object (native + PWA share the shim)", () => {
  const shim = src("velta-app/src-tauri/src/webxdc-shim.js");
  assert.match(shim, /call\("sendUpdate", \{ update: update,/);
});

test("chat view wires info rows to open the parent app at its href", () => {
  const cv = src("app/js/chat-view.js");
  assert.match(cv, /if \(isWebxdcInfoMsg\(m\)\) this\._webxdcInfoRow\(row, m, alive\)/);
  assert.match(cv, /openWebxdc\(parentId, .*\{ href: m\.webxdcHref/);
  const mgr = src("app/js/webxdc-manager.js");
  assert.match(mgr, /const start = webxdcStartPath\(opts\.href\)/);
});

// --- shim update delivery (forwarded poll lost its state) -----------------
import vm from "node:vm";
function loadShim() {
  const handlers = [];
  const posted = [];
  const win = {
    addEventListener: (t, h) => { if (t === "message") handlers.push(h); },
    parent: { postMessage: (m) => posted.push(m) },
    localStorage: { getItem() { return null; } }, sessionStorage: { getItem() { return null; } },
  };
  const ctx = { window: win, location: { search: "" }, document: { documentElement: { style: {} } },
    URLSearchParams, Promise, Map, Uint8Array, Blob, atob, Array, Math, Number, Object, Error, String, JSON };
  vm.createContext(ctx);
  vm.runInContext(src("velta-app/src-tauri/src/webxdc-shim.js"), ctx);
  const send = (d) => handlers.forEach(h => h({ data: d }));
  return { webxdc: win.webxdc, posted, send };
}

test("shim: setUpdateListener delivers stored updates, keeps listening, no fake objects", async () => {
  const { webxdc, posted, send } = loadShim();
  const got = [];
  const p = webxdc.setUpdateListener((u) => got.push(u), 0);
  const req = posted.find(m => m.method === "getStatusUpdates");
  assert.equal(req.params.serial, 0);
  send({ type: "velta-webxdc-response", id: req.id, result: { updates: [{ serial: 2, payload: "b" }, { serial: 1, payload: "a" }], serial: 2 } });
  await p;
  assert.deepEqual(got.map(u => u.payload), ["a", "b"]);
  // live push after the first batch (own sendUpdate echo) still arrives
  send({ type: "velta-webxdc-status-updates", updates: [{ serial: 3, payload: "c" }], serial: 3, done: true });
  // duplicates are dropped
  send({ type: "velta-webxdc-status-updates", updates: [{ serial: 3, payload: "c" }], serial: 3, done: true });
  assert.deepEqual(got.map(u => u.payload), ["a", "b", "c"]);
  assert.ok(got.every(u => "payload" in u));
});

test("shim: startSerial skips already-known updates", async () => {
  const { webxdc, posted, send } = loadShim();
  const got = [];
  const p = webxdc.setUpdateListener((u) => got.push(u.serial), 5);
  const req = posted.find(m => m.method === "getStatusUpdates");
  assert.equal(req.params.serial, 5);
  send({ type: "velta-webxdc-response", id: req.id, result: { updates: [{ serial: 4 }, { serial: 6 }] } });
  await p;
  assert.deepEqual(got, [6]);
});

test("webxdc card hydration is not aborted by a detached row", () => {
  const cv = src("app/js/chat-view.js");
  assert.doesNotMatch(cv, /webxdcCard\.isConnected/);
});
