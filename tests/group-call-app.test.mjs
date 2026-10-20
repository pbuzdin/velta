// Group calls Phase 3: the trusted built-in app (app/webxdc/group-call/),
// its hash on the trusted list, the shim's webxdc.veltaCall, and the host
// gating in webxdc-manager.js. Browser-level: scripts/e2e-group-call-app.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { buildGroupCall, sha256Hex, readTrusted } from "../tools/build-builtin-xdc.mjs";
import { TRUSTED_XDC } from "../app/js/trusted-xdc.js";
import { trustedAppName } from "../app/js/xdc-trust.js";
import { isValidXdc } from "../app/js/builtin-xdc.js";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";
installChatViewGlobals();
installFakeDocument();
const { builtinAppCard, GROUP_CALL_FILE_RE } = await import("../app/js/webxdc-manager.js");

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url));

test("committed group-call.xdc is fresh (rebuild with tools/build-builtin-xdc.mjs)", () => {
  const built = buildGroupCall();
  assert.ok(Buffer.compare(built, src("app/builtin/group-call.xdc")) === 0, "app/builtin/group-call.xdc is stale");
  assert.ok(isValidXdc(new Uint8Array(built)));
});

test("the current bundle's SHA-256 is on the trusted list; list is generated", () => {
  const h = sha256Hex(src("app/builtin/group-call.xdc"));
  assert.equal(TRUSTED_XDC[h], "group-call");
  assert.deepEqual(readTrusted(), { ...TRUSTED_XDC });
  assert.ok(Object.isFrozen(TRUSTED_XDC));
});

test("trust is the hash, nothing else: a renamed lookalike or a 1-byte change is not trusted", async () => {
  if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
  const real = new Uint8Array(src("app/builtin/group-call.xdc"));
  assert.equal(await trustedAppName(real), "group-call");
  const tampered = real.slice(); tampered[tampered.length - 30] ^= 1;
  assert.equal(await trustedAppName(tampered), null);
  assert.equal(await trustedAppName(new Uint8Array(src("app/builtin/send-direct.xdc"))), null);
  assert.equal(await trustedAppName(null), null);
  assert.equal(await trustedAppName(new Uint8Array()), null);
});

test("card name/icon by file name is cosmetic only", () => {
  assert.ok(GROUP_CALL_FILE_RE.test("group-call-1712.xdc"));
  assert.equal(builtinAppCard("group-call.xdc").name, "Velta Group Call");
  const m = src("app/js/webxdc-manager.js").toString();
  // every veltaCall* method is gated on the bundle hash
  assert.match(m, /case "veltaCallState": \{\s*if \(\(await activeTrust\(\)\) !== "group-call"\) throw/);
  assert.match(m, /veltaCall: \(await activeTrust\(\)\) === "group-call"/);
  assert.match(m, /active\.trust = trustFor\(Number\(msgId\)\)/);
  assert.match(m, /if \(!\(await askGroupCallConsent\(chatName\)\)\) throw new Error\("cancelled"\)/);
  assert.match(m, /relayOnly: true/);
});

test("the app never touches WebRTC or the mic; it drives webxdc.veltaCall and shows 'needs Velta' without it", () => {
  const js = src("app/webxdc/group-call/main.js").toString();
  assert.ok(!/RTCPeerConnection|getUserMedia|mediaDevices/.test(js));
  assert.match(js, /window\.webxdc && window\.webxdc\.veltaCall/);
  assert.match(src("app/webxdc/group-call/index.html").toString(), /This group call needs Velta/);
});

test("shim: veltaCall methods map to host calls; state pushes reach onState", () => {
  const shim = src("velta-app/src-tauri/src/webxdc-shim.js").toString();
  for (const m of ["veltaCallJoin", "veltaCallLeave", "veltaCallMute", "veltaCallState"]) assert.ok(shim.includes(`call("${m}"`), m);
  assert.match(shim, /d\.type === "velta-call-state"/);
});

test("Tauri bundles the app (prepare_builtin_xdc group-call)", () => {
  const rs = src("velta-app/src-tauri/src/builtin_xdc.rs").toString();
  assert.match(rs, /"group-call" => Some\(GROUP_CALL\)/);
  assert.match(rs, /include_bytes!\("\.\.\/\.\.\/\.\.\/app\/builtin\/group-call\.xdc"\)/);
});

test("chat entry point: group chats get 'Group call' in the attach menu", () => {
  const cv = src("app/js/chat-view.js").toString();
  assert.match(cv, /this\.chat\?\.kind === "group" && !this\.chat\?\.isP2p\) \{\s*attachItems\.push\(\{ label: "Group call"/);
  assert.match(cv, /prepareBuiltinXdc\("group-call"/);
});
