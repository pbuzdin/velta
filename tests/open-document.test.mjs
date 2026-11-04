// #279: documents open in the system app via a decrypted copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
const rust = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
const kt = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/FileOpen.kt", import.meta.url), "utf8");

// Pull documentOpenPlan out without importing the DOM-heavy module.
const body = src.slice(src.indexOf("const PWA_TAB_RE"), src.indexOf("// Open a message's file"));
const isMediaFilePath = (p) => /\.(jpe?g|png|gif|webp|mp4|webm)$/i.test(p);
const plan = new Function("isMediaFilePath", body.replace("export function", "function") + "return documentOpenPlan;")(isMediaFilePath);

test("routing by platform and type", () => {
  assert.equal(plan("a/b.html", "x.html", { tauri: true }), "html");
  assert.equal(plan("a/b.htm", null, {}), "html");
  assert.equal(plan("a/ce94.jpg", "p.jpg", { tauri: true, android: true }), "lightbox");
  assert.equal(plan("a/ce94.pdf", "r.pdf", { tauri: true, android: true }), "native");
  assert.equal(plan("a/ce94.docx", "r.docx", { tauri: true }), "native");
  assert.equal(plan("a/ce94.jpg", "p.jpg", { tauri: true }), "native");
  assert.equal(plan("x", "r.pdf", {}), "tab");
  assert.equal(plan("x", "notes.txt", {}), "tab");
  assert.equal(plan("x", "r.docx", {}), "download");
});

test("native open never hands out the blobdir path", () => {
  const fn = src.slice(src.indexOf("export async function openAttachmentFile"), src.indexOf("// Image extensions the lightbox"));
  assert.match(fn, /invoke\("open_document"/);
  assert.match(fn, /open_path", \{ path: copy \}/);
  assert.doesNotMatch(fn, /veltaAccountsDir/);
  assert.match(fn, /"No app can open this file"/);
  assert.match(fn, /Save as…/);
});

test("rust decrypts to open-docs with the original name and sweeps old copies", () => {
  assert.match(rust, /fn decrypted_open_copy/);
  assert.match(rust, /open_attachment\(&canon\)/);
  assert.match(rust, /OPEN_DOCS_DIR: &str = "open-docs"/);
  assert.match(rust, /sweep_open_docs\(&root\)/);
  assert.match(rust, /open_document, media_base_url/);
  assert.match(rust, /\("FileOpen", &APP_FILE_OPEN_CLASS\)/);
});

test("android uses FileProvider ACTION_VIEW and reports no-app", () => {
  assert.match(kt, /FileProvider\.getUriForFile/);
  assert.match(kt, /ACTION_VIEW/);
  assert.match(kt, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(kt, /ActivityNotFoundException\) \{\s*1/);
});

test("opener scope covers the copies in both capability files", () => {
  for (const f of ["default", "mobile"]) {
    const c = readFileSync(new URL(`../velta-app/src-tauri/capabilities/${f}.json`, import.meta.url), "utf8");
    assert.match(c, /\$APPLOCALDATA\/open-docs\/\*\*/);
  }
});

test("strings exist in ru and fr", () => {
  for (const l of ["ru", "fr"]) {
    const j = JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url), "utf8"));
    assert.ok(j["No app can open this file"]);
    assert.ok(j["Save as…"]);
  }
});
