// #127: welcome splash version line shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSplashVersion } from "../app/js/format.js";

test("Tauri shells name Tauri; the browser names the service worker", () => {
  assert.equal(
    formatSplashVersion({ app: "1.4.68", core: "2.63.0", tauri: "2.11.5", sw: "v12" }),
    "Velta 1.4.68 (Chatmail core 2.63.0, Tauri 2.11.5)",
  );
  assert.equal(
    formatSplashVersion({ app: "1.4.68", core: "2.63.0", tauri: null, sw: "pwa-abcdef012345" }),
    "Velta 1.4.68 (Chatmail core 2.63.0, service worker pwa-abcdef012345)",
  );
  assert.equal(
    formatSplashVersion({ app: "1.4.68", core: "2.63.0", tauri: null, sw: null }),
    "Velta 1.4.68 (Chatmail core 2.63.0, service worker —)",
  );
});

test("version line sits between the scrolling main and the App log bar (#127)", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(app, /<\/div>\s*<p class="splash-ver" data-splash-ver>…<\/p>\s*<details class="splash-log">/);
  assert.ok(app.includes("fillSplashVersion(el)"), "fills after mount");
  assert.ok(!app.includes("splash-brand") && !css.includes(".splash-brand"), "no logo grouping");
  assert.match(css, /\.splash-main\s*\{[^}]*justify-content:\s*safe center/);
  const ver = /\.splash-ver\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(ver, /flex:\s*none/);
  assert.match(ver, /text-align:\s*left/);
  assert.doesNotMatch(ver, /position:\s*(absolute|fixed)|margin[^;]*-\d/);
});
