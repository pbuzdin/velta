import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";

// Image rows cached by the virtual scroller are reused without rebinding,
// and their load/error handlers gate on alive(): an event that lands while
// the chat is not current is swallowed and the row keeps the pre-reveal
// state forever (invisible image in the reserved box). _renderItem now
// calls _healCachedImage on every cached reuse — these tests drive that
// method directly with the handlers parked the way _renderMsgItem parks
// them (on the img element). The fake DOM does not parse HTML, so the row
// tree is built by hand.

installChatViewGlobals();
installFakeDocument();
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { ChatView } = await import("../app/js/chat-view.js");

const heal = el => ChatView.prototype._healCachedImage.call({}, el);
const mkRow = (cls = "msg-row") => {
  const el = document.createElement("div");
  el.className = cls;
  const box = document.createElement("div"); box.className = "msg-image";
  const wrap = document.createElement("div"); wrap.className = "img-wrap is-land";
  wrap.dataset.ready = "";
  const img = document.createElement("img");
  img.setAttribute("data-src", "image");
  img.setAttribute("src", "http://127.0.0.1:1/x.jpg?w=720");
  wrap.append(img); box.append(wrap); el.append(box);
  return el;
};

test("heal re-reveals a loaded-but-unrevealed cached row, once", () => {
  const el = mkRow();
  const img = el.querySelector("img");
  img.complete = true; img.naturalWidth = 800; img.naturalHeight = 450;
  let revealed = 0;
  img._imgReveal = () => { revealed++; img.closest(".img-wrap").dataset.ready = "1"; };
  heal(el);
  assert.equal(revealed, 1);
  heal(el); // already ready: no second run
  assert.equal(revealed, 1);
});

test("heal re-runs the error path when no fallback was applied yet", () => {
  const el = mkRow();
  const img = el.querySelector("img");
  img.complete = true; img.naturalWidth = 0; // failed decode, error swallowed
  let failed = 0;
  img._imgFail = () => { failed++; img.dataset.fallback = "1"; };
  heal(el);
  assert.equal(failed, 1);
  heal(el); // fallback already set: the live onerror chain owns the rest
  assert.equal(failed, 1);
});

test("heal ignores pending loads, handlerless rows and day-chip wraps", () => {
  let calls = 0;
  // still loading: the live load listener owns it
  const loading = mkRow();
  loading.querySelector("img").complete = false;
  loading.querySelector("img")._imgReveal = () => calls++;
  heal(loading);
  // day-first wrap: the img sits one level down, handlers still found
  const wrap = mkRow("msg-row day-first");
  const wimg = wrap.querySelector("img");
  wimg.complete = true; wimg.naturalWidth = 100; wimg.naturalHeight = 100;
  wimg._imgReveal = () => calls++;
  heal(wrap);
  // plain text row without handlers or image: no-op
  const plain = document.createElement("div");
  plain.className = "msg-row";
  heal(plain);
  assert.equal(calls, 1);
});
