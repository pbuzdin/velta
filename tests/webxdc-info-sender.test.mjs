// #265: webxdc info lines show who posted them as a profile chip.
import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";

installChatViewGlobals();
installFakeDocument();
const { JsonRpcCore } = await import("../app/js/rpc-core.js");
const { ChatView, setAvatarProfileOpener } = await import("../app/js/chat-view.js");

const map = (fromId, text, name = "Ada") => new JsonRpcCore()._mapMessage({
  id: 9, chatId: 3, fromId, isInfo: true, text, timestamp: 1, sortTimestamp: 1, state: 13,
  viewType: "Text", systemMessageType: "WebxdcInfoMessage", parentId: 7, sender: { displayName: name },
});
// A bubble as the row builds it: the text, optionally followed by the
// diagnostics "Copy text" button (ece848ed), which the chip rewrite must
// lift out before reading the text and put back afterwards.
const render = (m, { copy = false, textContent = m.text } = {}) => {
  const btn = copy ? { className: "diag-copy-btn", textContent: "Copy text", attached: true } : null;
  const b = {
    textContent: textContent + (btn ? btn.textContent : ""), innerHTML: "", handlers: [], appended: [],
    addEventListener(_, h) { this.handlers.push(h); },
    querySelector(sel) { return sel === ".diag-copy-btn" && btn?.attached ? btn : null; },
    appendChild(el) { el.attached = true; this.appended.push(el); return el; },
  };
  if (btn) btn.remove = () => { btn.attached = false; b.textContent = textContent; };
  ChatView.prototype._webxdcSenderChip.call({}, b, m, () => true);
  return b;
};

test("mapping keeps the sender for webxdc info only", () => {
  assert.deepEqual(map(12, "x").webxdcSender, { id: 12, name: "Ada" });
  assert.equal(map(1, "x").webxdcSender.id, 1);
  assert.equal(map(2, "x").webxdcSender, null); // ContactId::INFO
  const other = new JsonRpcCore()._mapMessage({ id: 1, chatId: 3, fromId: 12, isInfo: true, text: "x", timestamp: 1, systemMessageType: "MemberAddedToGroup", sender: {} });
  assert.equal(other.webxdcSender, null);
});

test("prefixes a profile chip button that opens the profile", () => {
  const b = render(map(12, "scored 10"));
  assert.match(b.innerHTML, /^<button type="button" class="svc-chip" data-contact-id="12"[^>]*>Ada<\/button> scored 10$/);
  let opened = null;
  setAvatarProfileOpener((c) => { opened = c; });
  b.handlers[0]({ target: { closest: (s) => (s === "button.svc-chip" ? {} : null) }, stopPropagation() {} });
  assert.deepEqual(opened, { contactId: 12, name: "Ada" });
});

test("a leading name becomes the chip, not a duplicate", () => {
  assert.match(render(map(12, "Ada scored 10")).innerHTML, />Ada<\/button> scored 10$/);
  assert.match(render(map(12, "Adam scored")).innerHTML, />Ada<\/button> Adam scored$/);
});

test("own lines show a plain You chip", () => {
  const html = render(map(1, "Me scored", "Me")).innerHTML;
  assert.match(html, /^<span class="svc-chip is-self">You<\/span> scored$/);
});

test("escapes names and text", () => {
  const html = render(map(12, "<b>", "<i>")).innerHTML;
  assert.ok(!html.includes("<b>") && !html.includes("<i>"));
});

test("the diagnostics copy button survives the chip rewrite", () => {
  const b = render(map(12, "scored 10"), { copy: true });
  assert.match(b.innerHTML, /^<button type="button" class="svc-chip" data-contact-id="12"[^>]*>Ada<\/button> scored 10$/);
  assert.ok(!b.innerHTML.includes("Copy text"), "the button text is not baked into the line");
  assert.equal(b.appended.length, 1);
  assert.equal(b.appended[0].className, "diag-copy-btn");
  assert.equal(b.querySelector(".diag-copy-btn"), b.appended[0]);
});

test("no chip when the text is not in the bubble, and the copy button stays", () => {
  const b = render(map(12, "scored 10"), { copy: true, textContent: "something else" });
  assert.equal(b.innerHTML, "");
  assert.equal(b.appended.length, 1, "the lifted button is put back");
});
