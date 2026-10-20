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
  assert.equal(builtinAppCard("group-call.xdc").name, "Velta Circle");
  const m = src("app/js/webxdc-manager.js").toString();
  // every veltaCall* method is gated on the bundle hash
  assert.match(m, /case "veltaCallState": \{\s*if \(\(await activeTrust\(\)\) !== "group-call"\) throw/);
  assert.match(m, /\(await activeTrust\(\)\) === "group-call" \? \{ veltaCall: true, veltaTheme: themeTokens\(\) \} : \{ veltaCall: false \}/);
  assert.match(m, /active\.trust = trustFor\(Number\(msgId\)\)/);
  assert.match(m, /if \(!\(await askGroupCallConsent\(chatName\)\)\) throw new Error\("cancelled"\)/);
  assert.match(m, /relayOnly: true/);
});

test("the app never touches WebRTC or the mic; it drives webxdc.veltaCall and shows 'needs Velta' without it", () => {
  const js = src("app/webxdc/group-call/main.js").toString();
  assert.ok(!/RTCPeerConnection|getUserMedia|mediaDevices/.test(js));
  assert.match(js, /window\.webxdc && window\.webxdc\.veltaCall/);
  assert.match(src("app/webxdc/group-call/index.html").toString(), /<b>Open in Velta to join<\/b>/);
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

test("Velta Circle rename keeps every earlier trusted bundle hash (already-sent calls)", async () => {
  const { TRUSTED_XDC } = await import("../app/js/trusted-xdc.js");
  for (const h of ["10e5bcf833148f408daf936d7c5b35d7209fd67a929840f62763a41c2735032c", "ad9a62e9750a62beef378461bc7ccdb8cb7c9cda6f8609472385e755086a54c5",
    "9394b070f4a59ed1da9bc6c0577084ad8a101d3c25615f634866a3e3b8f95409", "504443a99d2db9a8d3742f0e18c6bb9086ad4a2d9150cf2584c232bbd1c71eab"]) assert.equal(TRUSTED_XDC[h], "group-call", h);
  assert.match(src("app/webxdc/group-call/manifest.toml").toString(), /^name = "Velta Circle"$/m);
});

test("needs-Velta roster shows display names only, never the pseudonym id", () => {
  const js = src("app/webxdc/group-call/main.js").toString();
  assert.doesNotMatch(js, /\|\| m\.from/);
  assert.match(js, /" others"/);
  assert.match(src("app/webxdc/group-call/index.html").toString(), /\.notice, \.notice \* \{[^}]*overflow-wrap: anywhere/);
});
