// "Show device info" (About Velta): collection + plain-text format.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectDeviceInfo, formatDeviceInfo, platformLabel } from "../app/js/device-info.js";

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const env = (over = {}) => ({
  window: {
    devicePixelRatio: 3, innerWidth: 360, innerHeight: 740,
    visualViewport: { width: 360, height: 700.5, scale: 1 },
    matchMedia: q => ({ matches: ["(prefers-color-scheme: dark)", "(pointer: coarse)", "(display-mode: standalone)"].includes(q) }),
  },
  navigator: {
    userAgent: UA, language: "ru-RU", languages: ["ru-RU", "en"], maxTouchPoints: 5,
    userAgentData: { platform: "Android", mobile: true, brands: [{ brand: "Chromium", version: "129" }] },
  },
  screen: { width: 360, height: 800, colorDepth: 24, orientation: { type: "portrait-primary" } },
  appVersion: "1.4.74", coreVersion: "2.63.0", tauri: true, android: true, timeZone: "Europe/Moscow",
  uiScale: "1.15", safeArea: { top: 24, right: 0, bottom: 16, left: 0 },
  ...over,
});
const text = e => formatDeviceInfo(collectDeviceInfo(e));
const line = (t, k) => t.split("\n").find(l => l.startsWith(k + ": "));

test("screen, physical pixels, DPR and DPI", () => {
  const t = text(env());
  assert.equal(line(t, "Screen"), "Screen: 360 x 800 CSS px");
  assert.equal(line(t, "Screen (physical)"), "Screen (physical): 1080 x 2400 px");
  assert.equal(line(t, "Device pixel ratio"), "Device pixel ratio: 3");
  assert.match(line(t, "Approx. DPI"), /^Approx\. DPI: 288 /);
  assert.equal(line(t, "Viewport"), "Viewport: 360 x 740");
  assert.equal(line(t, "Visual viewport"), "Visual viewport: 360 x 700.5 @ scale 1");
  assert.equal(line(t, "Orientation"), "Orientation: portrait-primary");
  assert.equal(line(t, "Interface scale"), "Interface scale: 1.15 (CSS zoom)");
  assert.equal(line(t, "Safe-area insets"), "Safe-area insets: top 24, right 0, bottom 16, left 0 px");
});

test("platform, versions, preferences, locale, UA data", () => {
  const t = text(env());
  assert.equal(line(t, "Platform"), "Platform: Android app (Tauri)");
  assert.equal(line(t, "Velta version"), "Velta version: 1.4.74");
  assert.equal(line(t, "Core version"), "Core version: 2.63.0");
  assert.equal(line(t, "Display mode"), "Display mode: standalone");
  assert.equal(line(t, "Color scheme"), "Color scheme: dark");
  assert.equal(line(t, "Reduced motion"), "Reduced motion: no-preference");
  assert.equal(line(t, "Pointer"), "Pointer: coarse");
  assert.equal(line(t, "Touch points"), "Touch points: 5");
  assert.equal(line(t, "Languages"), "Languages: ru-RU, en");
  assert.equal(line(t, "Time zone"), "Time zone: Europe/Moscow");
  assert.equal(line(t, "UA platform"), "UA platform: Android");
  assert.equal(line(t, "UA mobile"), "UA mobile: true");
  assert.equal(line(t, "UA brands"), "UA brands: Chromium 129");
  assert.equal(line(t, "User agent"), "User agent: " + UA);
});

test("one Key: value per line, unknown values dropped, no newlines inside values", () => {
  const t = text(env({ window: { innerWidth: 320, innerHeight: 640 }, navigator: { userAgent: "a\nb" }, screen: {}, safeArea: null, coreVersion: "" }));
  for (const l of t.split("\n")) assert.match(l, /^[A-Za-z][^:\n]*: \S/);
  assert.equal(line(t, "Screen"), undefined);
  assert.equal(line(t, "Core version"), undefined);
  assert.equal(line(t, "Visual viewport"), undefined);
  assert.equal(line(t, "User agent"), "User agent: a b");
  assert.equal(line(t, "Device pixel ratio"), "Device pixel ratio: 1");
  assert.equal(line(t, "Orientation"), "Orientation: portrait");
});

test("platform labels", () => {
  assert.equal(platformLabel({ tauri: true, android: false, ua: "Windows NT 10.0" }), "Desktop app (Tauri, Windows)");
  assert.equal(platformLabel({ tauri: false, standalone: true, ua: UA }), "Installed PWA");
  assert.equal(platformLabel({ tauri: false, standalone: false, ua: UA }), "Browser (PWA)");
});

test("never leaks account identifiers even when the env carries them", () => {
  const t = text(env({ addr: "me@example.org", displayName: "Pavel", fingerprint: "ABCD" }));
  assert.doesNotMatch(t, /me@example\.org|Pavel|ABCD/);
});

test("About wires a native <details> with Copy/Share and a wrapping <pre>", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /<details class="device-info" data-device-info>\s*<summary>Show device info<\/summary>/);
  assert.match(ui, /data-device-copy/);
  assert.match(ui, /shareBtn\.hidden = !canShareLink\(/);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /\.device-info-text \{[^}]*white-space: pre-wrap; overflow-wrap: anywhere;/);
});
