// Android attach picker: plain image/video MIME and Diagnostics when it returns nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("async _sendAttachment(kind)"), src.indexOf("// #97 share-in"));
const ru = JSON.parse(readFileSync(new URL("../app/locales/ru.json", import.meta.url), "utf8"));
const fr = JSON.parse(readFileSync(new URL("../app/locales/fr.json", import.meta.url), "utf8"));

test("photo and video pass pickerMode to the dialog plugin", () => {
  assert.match(fn, /kind === "image" \? "image" : kind === "video" \? "video" : undefined/);
  assert.match(fn, /plugin:dialog\|open", \{ options: \{[^}]*pickerMode \}/);
});

test("empty pick is logged, and a fast one shows a toast", () => {
  assert.match(fn, /picker open kind=\$\{kind\}/);
  assert.match(fn, /"warning", `picker returned nothing after \$\{ms\} ms \(kind=\$\{kind\}\)`/);
  assert.match(fn, /if \(ms < 1000\)/);
  for (const k of ["Couldn't open the photo picker", "Couldn't open the video picker", "Couldn't open the file picker"]) {
    assert.ok(fn.includes(`t("${k}")`), k);
    assert.ok(ru[k] && fr[k], `ru/fr: ${k}`);
  }
});
