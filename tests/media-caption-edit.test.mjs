import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canEditMsg } from "../app/js/msg-edit.js";

const own = (o) => ({ from: 1, viewtype: "text", text: "hi", ...o });

test("own media messages with a caption are editable", () => {
  for (const vt of ["text", "image", "gif", "video", "audio", "voice", "file", "vcard"])
    assert.equal(canEditMsg(own({ viewtype: vt }), {}), true, vt);
});

test("core guards mirrored: not self, info, html, empty caption, call, webxdc, sticker, p2p", () => {
  assert.equal(canEditMsg(own({ from: 5 }), {}), false);
  assert.equal(canEditMsg(own({ isInfo: true }), {}), false);
  assert.equal(canEditMsg(own({ hasHtml: true }), {}), false);
  assert.equal(canEditMsg(own({ viewtype: "image", text: "" }), {}), false);
  assert.equal(canEditMsg(own({ viewtype: "image", text: "  " }), {}), false);
  for (const vt of ["call", "webxdc", "sticker"]) assert.equal(canEditMsg(own({ viewtype: vt }), {}), false, vt);
  assert.equal(canEditMsg(own(), { isP2p: true }), false);
});

test("chat-view uses canEditMsg for menu and edit entry; no text-only gate", () => {
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(src, /if \(canEditMsg\(m, this\.chat\)\) items\.push\(\{ label: "Edit"/);
  assert.match(src, /this\.pendingMedia \|\| !canEditMsg\(item\.msg, this\.chat\)/);
  assert.doesNotMatch(src, /m\.viewtype === "text" && m\.text\) items\.push\(\{ label: "Edit"/);
  // edits re-render in place (caption under media) because text/edited are compared
  assert.match(src, /m\.viewtype, m\.downloadState, m\.text, m\.state, m\.edited/);
});

test("core still allows non-text viewtypes in send_edit_request", () => {
  const rs = readFileSync(new URL("../core/src/chat.rs", import.meta.url), "utf8");
  const fn = rs.slice(rs.indexOf("pub async fn send_edit_request"), rs.indexOf("pub(crate) async fn save_text_edit_to_db"));
  assert.match(fn, /Cannot add text/);
  assert.doesNotMatch(fn, /Viewtype::(Image|Video|File|Gif|Voice|Audio)/);
});
