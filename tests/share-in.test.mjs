import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSharePayload, shareTextIfUnconsumed, shareViewtype } from "../app/js/share-in.js";

// #97: Velta shows up in the Android share sheet and Windows Send to, and
// the page can tell a shared file or text from an invite link.

test("parseSharePayload keeps text and files, and leaves links to the deeplink router", () => {
  assert.deepEqual(parseSharePayload("data:text/plain,hello%20there"), { text: "hello there" });
  assert.deepEqual(parseSharePayload("data:text/plain;charset=utf-8,hi"), { text: "hi" });
  assert.equal(parseSharePayload("data:text/plain,"), null);
  assert.deepEqual(parseSharePayload("content://media/external/images/1"), { file: "content://media/external/images/1" });
  assert.deepEqual(parseSharePayload("file:///C:/Users/a%20b/x.png"), { file: "C:/Users/a b/x.png" });
  assert.deepEqual(parseSharePayload("file:///storage/emulated/0/DCIM/a.jpg"), { file: "/storage/emulated/0/DCIM/a.jpg" });
  assert.deepEqual(parseSharePayload("C:\\Users\\a b\\x.png"), { file: "C:\\Users\\a b\\x.png" });
  assert.deepEqual(parseSharePayload("\\\\server\\share\\a.png"), { file: "\\\\server\\share\\a.png" });
  assert.equal(parseSharePayload("velta://chat?chat=1"), null);
  assert.equal(parseSharePayload("https://example.com/a"), null);
  assert.equal(parseSharePayload("dcaccount:https://example.org/new"), null);
  assert.equal(parseSharePayload(""), null);
});

test("an https URL is shared text only when the deeplink router did not consume it", () => {
  assert.deepEqual(shareTextIfUnconsumed("https://example.com/a", false), { text: "https://example.com/a" });
  assert.equal(shareTextIfUnconsumed("https://i.delta.chat/#ABC", true), null);
  assert.equal(shareTextIfUnconsumed("velta://chat?chat=1", false), null);
});

test("share viewtype follows the file extension", () => {
  assert.equal(shareViewtype("a/b.JPG"), "image");
  assert.equal(shareViewtype("clip.mp4"), "video");
  assert.equal(shareViewtype("song.opus"), "audio");
  assert.equal(shareViewtype("notes.pdf"), "file");
});

test("the Android activity registers as a share target", () => {
  const manifest = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  const activity = manifest.slice(manifest.indexOf('android:name=".MainActivity"'), manifest.indexOf("</activity>"));
  assert.match(activity, /android.intent.action.SEND"/);
  assert.match(activity, /android.intent.action.SEND_MULTIPLE"/);
  assert.match(activity, /android.intent.category.DEFAULT/);
  for (const mime of ["text/plain", "image/*", "video/*", "audio/*", "application/*", "*/*"]) {
    assert.match(activity, new RegExp(`android:mimeType="${mime.replaceAll("*", "\\*")}"`));
  }
});

test("opened urls are drained into the share picker, not dropped", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /take_opened_urls/);
  assert.match(app, /parseSharePayload/);
  assert.match(app, /Share to…/);
});
