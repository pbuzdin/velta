// Phase 0 of docs/research/webxdc-group-calls.md: webxdc apps never get the
// mic, camera, screen or location on any shell. Browser-level proof (fake
// devices, auto-granting UI) lives in scripts/e2e-webxdc-media-deny.mjs and
// scripts/e2e-webxdc-pwa.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const DENIED = ["camera=()", "microphone=()", "display-capture=()", "geolocation=()"];

test("Tauri webxdc responses carry a deny-all Permissions-Policy", () => {
  const rs = src("velta-app/src-tauri/src/webxdc_serve.rs");
  const pp = rs.match(/WEBXDC_PERMISSIONS_POLICY: &str = "([^;]*?)";/s)[1];
  for (const d of DENIED) assert.ok(pp.includes(d), d);
  assert.match(rs, /\.header\("Permissions-Policy", WEBXDC_PERMISSIONS_POLICY\)/);
});

test("PWA loader document carries the same Permissions-Policy", () => {
  const ctx = { URL, Response, Promise, JSON }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(src("app/webxdc-host/sw-route.js"), ctx);
  const pp = ctx.veltaWebxdcSw.WEBXDC_PERMISSIONS_POLICY;
  for (const d of DENIED) assert.ok(pp.includes(d), d);
  assert.match(src("app/webxdc-host/sw-route.js"), /"Permissions-Policy": WEBXDC_PERMISSIONS_POLICY/);
});

test("iframe allow list denies capture and location", () => {
  const m = src("app/js/webxdc-manager.js");
  const allow = m.match(/WEBXDC_FRAME_ALLOW =\s*"([^"]+)"/)[1];
  for (const f of ["microphone 'none'", "camera 'none'", "display-capture 'none'", "geolocation 'none'"]) assert.ok(allow.includes(f), f);
  assert.match(m, /setAttribute\("allow", WEBXDC_FRAME_ALLOW\)/);
});

test("shim makes getUserMedia/getDisplayMedia reject with NotAllowedError", async () => {
  class DOMException extends Error { constructor(m, n) { super(m); this.name = n; } }
  const navigator = { mediaDevices: { getUserMedia: async () => "STREAM", getDisplayMedia: async () => "STREAM" } };
  const win = { navigator, addEventListener() {}, parent: { postMessage() {} }, location: { search: "" }, document: { addEventListener() {}, readyState: "complete" } };
  const ctx = vm.createContext({ window: win, navigator, DOMException, Promise, Object, Map, JSON, Error, console, setTimeout, clearTimeout, self: win, parent: win.parent, location: win.location, document: win.document, addEventListener() {} });
  try { vm.runInContext(src("velta-app/src-tauri/src/webxdc-shim.js"), ctx); } catch { /* later shim parts need more DOM; the guard runs first */ }
  for (const k of ["getUserMedia", "getDisplayMedia"]) {
    await assert.rejects(navigator.mediaDevices[k]({ audio: true }), (e) => e.name === "NotAllowedError", k);
    assert.throws(() => { navigator.mediaDevices[k] = async () => "STREAM"; }, TypeError); // non-writable
    await assert.rejects(navigator.mediaDevices[k]({ audio: true }), (e) => e.name === "NotAllowedError", `${k} not overridable`);
  }
});

test("Android: capture requests are denied unless they come from the Velta UI origin", () => {
  const kt = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/VeltaWebChromeClient.kt");
  assert.match(kt, /if \(!WebPermissionPolicy\.mayCapture\(request\.origin\?\.toString\(\)\)\) \{\s*request\.deny\(\)\s*return/);
  assert.match(kt, /APP_HOSTS = setOf\("tauri\.localhost"\)/);
  assert.ok(!/APP_HOSTS[^\n]*webxdc/.test(kt), "webxdc host never allowed");
  assert.match(kt, /origin == "null"\) return false/);
  // Mirror of mayCapture for the origins Android reports.
  const may = (o) => { if (!o || o === "null") return false; try { const u = new URL(o); return ["http:", "https:", "tauri:"].includes(u.protocol) && u.hostname === "tauri.localhost"; } catch { return false; } };
  assert.equal(may("http://tauri.localhost"), true);
  for (const o of ["http://webxdc.localhost", "https://webxdc.localhost", "webxdc://localhost", "null", "", "https://evil.example", "http://tauri.localhost.evil.example"]) assert.equal(may(o), false, o);
});
