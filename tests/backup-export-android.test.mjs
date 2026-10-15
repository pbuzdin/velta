import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");

test("Android backup export asks where to save instead of the private exports dir", () => {
  assert.match(app, /plugin:dialog\|save/);
  assert.match(app, /publish_backup/);
  assert.doesNotMatch(app, /\/exports"/);
});

// v1.4.66 shipped no Windows/macOS build: publish_backup's helpers are
// Android-only, and the desktop publish_backup is an error stub. Desktop
// export must keep the folder picker + core export and never reach it.
test("desktop backup export uses the folder picker + core export, never publish_backup", () => {
  const start = app.indexOf('exportBtn.addEventListener("click"');
  assert.ok(start !== -1, "export click handler present");
  const end = app.indexOf("/* -- delete profile", start);
  const handler = app.slice(start, end === -1 ? undefined : end);
  // The save-dialog URI is only ever filled on Android (and not the PWA).
  assert.match(handler, /if \(onAndroid && !pwaExport\) \{[\s\S]*?androidUri = typeof picked === "string"/);
  assert.deepEqual(handler.match(/androidUri = [^;]*/g),
    ['androidUri = ""', 'androidUri = typeof picked === "string" ? picked : ""'],
    "androidUri starts empty and is assigned only in the Android branch");
  // publish_backup sits inside the androidUri branch only.
  const branch = handler.indexOf("} else if (androidUri) {");
  const desktop = handler.indexOf("} else {", branch);
  const publish = handler.indexOf('invoke("publish_backup"');
  assert.ok(branch !== -1 && desktop !== -1 && publish > branch && publish < desktop,
    "publish_backup only in the Android branch");
  assert.equal((app.match(/publish_backup/g) || []).length, 1, "no other publish_backup caller");
  // Desktop: core writes straight into the folder picked via plugin:dialog|open.
  assert.match(handler.slice(desktop), /^\} else \{\s*await core\.exportBackup\(dest, pass \|\| null\);/);
  assert.match(app, /shell\("plugin:dialog\|open", \{ options: \{ directory: true/);
});

test("Android capability grants the save dialog the backup export calls", () => {
  const mobile = JSON.parse(readFileSync(new URL("../velta-app/src-tauri/capabilities/mobile.json", import.meta.url), "utf8"));
  const perms = mobile.permissions.map(p => (typeof p === "string" ? p : p.identifier));
  assert.ok(perms.includes("dialog:allow-save") || perms.includes("dialog:default"), "dialog save permitted on Android");
});
