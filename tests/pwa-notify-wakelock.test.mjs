import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

// Wake lock: screen stays on during calls and QR scanning, released on
// teardown; the module must import cleanly in node (no document/navigator).
test("wakelock module is node-safe and hooked into calls and qr-scan", () => {
  const wl = read("../app/js/wakelock.js");
  assert.ok(wl.includes('typeof document !== "undefined"'), "document guard for node import");
  assert.ok(wl.includes("globalThis.navigator?.wakeLock"), "navigator guard for node import");
  const calls = strip(read("../app/js/calls.js"));
  assert.equal(calls.split("wakeLockAcquire()").length - 1, 2, "outgoing + incoming call acquire");
  assert.ok(calls.includes("releaseMedia() {\n    wakeLockRelease();"), "release rides the shared teardown");
  const qr = strip(read("../app/js/qr-scan.js"));
  assert.ok(qr.includes("wakeLockAcquire()"), "scan acquire");
  assert.ok(qr.includes("wakeLockRelease();"), "scan release inside stopScan");
});

// PWA notifications: web branch posts through the service worker and shares
// the drawer/privacy gates with the Tauri path.
test("ui.js web notify branch: SW showNotification, gates shared, permission untouched on Tauri", () => {
  const ui = strip(read("../app/js/ui.js"));
  assert.ok(ui.includes("notifyIncomingWeb"), "web branch exists");
  assert.ok(ui.includes("notifyGateBody(body)"), "shared gate helper");
  assert.ok(ui.includes("reg.showNotification(title, payload)"), "posts via the service worker");
  assert.ok(ui.includes("new Notification(title, payload)"), "fallback without SW");
  assert.ok(ui.includes('tag: `velta-${info.accountId ?? 0}-${info.chatId ?? 0}`'), "per-chat tag replaces instead of spamming");
});

test("app.js asks for web notification permission after a gesture and hears SW taps", () => {
  const app = strip(read("../app/js/app.js"));
  assert.ok(app.includes('addEventListener("pointerdown", ask, { once: true, capture: true })'), "prompt piggybacks on user activation");
  assert.ok(app.includes('type === "velta-notification-click"'), "SW tap handover wired");
  assert.ok(app.includes("openChatFromLink({ accountId:"), "tap opens the chat");
  assert.ok(app.includes('postMessage({ type: "velta-pending-notification" })'), "cold-start client asks for the stashed click");
});
