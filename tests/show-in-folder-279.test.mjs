import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const src = read("app/js/chat-view.js");

test("canShowInFolder: desktop Tauri only", () => {
  const body = src.match(/export function canShowInFolder\([\s\S]*?\) \{\n([\s\S]*?)\n\}/)[1];
  const fn = new Function("tauri", "android", body);
  assert.equal(fn(true, false), true);
  assert.equal(fn(true, true), false);
  assert.equal(fn(false, false), false);
});

test("reveals the decrypted open-docs copy, never the blob", () => {
  const fn = src.match(/export async function showAttachmentInFolder[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /invoke\("open_document", \{ src: path, name: fileName/);
  assert.match(fn, /invoke\("plugin:opener\|reveal_item_in_dir", \{ paths: \[copy\] \}\)/);
  assert.doesNotMatch(fn, /reveal_item_in_dir", \{ paths: \[path\]/);
});

test("menu item gated on desktop + downloaded file; capability allows reveal", () => {
  assert.match(src, /label: "Show in folder"[\s\S]{0,120}icon: ICO\.folder/);
  assert.match(src, /m\.filePath && \(!m\.downloadState \|\| m\.downloadState === "Done"\) && canShowInFolder\(\)/);
  assert.match(read("velta-app/src-tauri/capabilities/default.json"), /"opener:default"/);
  assert.match(read("app/js/icons.js"), /folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"\/>'/);
});

test("strings in ru + fr", () => {
  for (const l of ["ru", "fr"]) {
    const d = JSON.parse(read(`app/locales/${l}.json`));
    for (const k of ["Show in folder", "Folder", "Couldn't show in folder: "]) assert.ok(d[k], `${l}: ${k}`);
  }
});
