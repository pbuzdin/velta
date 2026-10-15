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

test("splash markup puts the version line above the logo", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const iVer = app.indexOf("data-splash-ver");
  const iLogo = app.indexOf('class="splash-logo"');
  assert.ok(iVer > 0 && iLogo > iVer, "version slot before logo");
  assert.ok(app.includes("fillSplashVersion(el)"), "fills after mount");
});

test("version line and logo share one centered brand group (#127)", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(app, /<div class="splash-brand">\s*<p class="splash-ver" data-splash-ver>…<\/p>\s*<img class="splash-logo"/);
  assert.match(css, /\.splash-brand\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*center/);
  assert.match(css, /\.splash-main\s*\{[^}]*justify-content:\s*safe center/);
  const ver = /\.splash-ver\s*\{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(ver, /position:\s*(absolute|fixed)/);
});
