import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #444: resolveAttachmentPath used to swallow any read/write/encrypt failure
// and fall back to the original picked path; the image branch then failed in
// read_media_bytes with a misleading "path outside the app data directory"
// scope error that hid the real cause (the macOS photo send report). Only the
// resolve_upload_path-returned-empty case keeps the salvage; real failures
// surface, and share-in delivery toasts them instead of dropping them.
const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const view = read("app/js/chat-view.js");
const app = read("app/js/app.js");
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const fnBody = strip(view.slice(view.indexOf("async function resolveAttachmentPath"), view.indexOf("// Free-form image cropper")));

test("resolveAttachmentPath salvages only the empty-dest case", () => {
  assert.match(fnBody, /if \(!absDest\) return originalPath;/);
  assert.match(fnBody, /throw e;/);
  // the unconditional fallback must not come back
  assert.ok(!fnBody.includes("falling back to original"));
});

test("share-in delivery toasts attachment errors", () => {
  const deliver = strip(app.slice(app.indexOf("async function deliverShare"), app.indexOf("async function drainOpened")));
  assert.match(deliver, /try \{[\s\S]*?await chatView\.receiveShare\(\{ text, files \}\);[\s\S]*?\} catch/);
  assert.match(deliver, /Could not send file: /);
});
