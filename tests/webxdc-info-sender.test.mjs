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
const render = (m) => {
  const b = { textContent: m.text, innerHTML: "", handlers: [], addEventListener(_, h) { this.handlers.push(h); } };
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
