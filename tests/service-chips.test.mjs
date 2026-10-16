import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { serviceChipsHtml } from "../app/js/format.js";

test("names become profile chips, everything escaped", () => {
  const html = serviceChipsHtml("Member Bob <b> added by Alice.", [{ id: 11, name: "Alice" }, { id: 12, name: "Bob <b>" }]);
  assert.equal(html,
    'Member <button type="button" class="svc-chip" data-contact-id="12" aria-label="Open profile of Bob &lt;b&gt;">Bob &lt;b&gt;</button>' +
    ' added by <button type="button" class="svc-chip" data-contact-id="11" aria-label="Open profile of Alice">Alice</button>.');
});

test("longest name wins and overlapping names are not double-chipped", () => {
  const html = serviceChipsHtml("Group left by Anna.", [{ id: 20, name: "Ann" }, { id: 21, name: "Anna" }]);
  assert.match(html, /data-contact-id="21"[^>]*>Anna<\/button>/);
  assert.doesNotMatch(html, /data-contact-id="20"/);
});

test("fallback: no people, unknown name, self or special ids -> plain escaped text", () => {
  assert.equal(serviceChipsHtml("You left the group <x>.", null), "You left the group &lt;x&gt;.");
  assert.equal(serviceChipsHtml("Member Carol added.", [{ id: 30, name: "Dave" }]), "Member Carol added.");
  assert.equal(serviceChipsHtml("Me added", [{ id: 1, name: "Me" }]), "Me added");
  assert.equal(serviceChipsHtml("x", [{ id: 40, name: "" }]), "x");
});

function core(contacts = {}) {
  const c = new JsonRpcCore({});
  c.accountId = 2;
  c.calls = [];
  c._call = async (method, ...params) => {
    c.calls.push([method, ...params]);
    if (method === "get_contacts_by_ids") return contacts;
    throw new Error("unexpected " + method);
  };
  return c;
}

test("service messages take people from systemMessageType + sender + infoContactId", async () => {
  const c = core({ 12: { displayName: "Bob" } });
  const msg = c._mapMessage({ id: 1, chatId: 7, isInfo: true, text: "Member Bob added by Alice.", timestamp: 1,
    systemMessageType: "MemberAddedToGroup", fromId: 11, sender: { displayName: "Alice" }, infoContactId: 12 });
  assert.equal(msg.kind, "service");
  assert.equal(msg.systemType, "MemberAddedToGroup");
  assert.deepEqual(msg.people, [{ id: 11, name: "Alice" }, { id: 12, name: "" }]);
  await c._hydrateServicePeople([msg]);
  assert.deepEqual(msg.people, [{ id: 11, name: "Alice" }, { id: 12, name: "Bob" }]);
  assert.deepEqual(c.calls, [["get_contacts_by_ids", 2, [12]]]);
});

test("left the group: actor == removed member is one person; other info types get none", () => {
  const c = core();
  const left = c._mapMessage({ id: 2, isInfo: true, text: "Group left by Bob.", timestamp: 1,
    systemMessageType: "MemberRemovedFromGroup", fromId: 12, sender: { displayName: "Bob" }, infoContactId: 12 });
  assert.deepEqual(left.people, [{ id: 12, name: "Bob" }]);
  const renamed = c._mapMessage({ id: 3, isInfo: true, text: "Group name changed", timestamp: 1,
    systemMessageType: "GroupNameChanged", fromId: 12, infoContactId: 12 });
  assert.equal(renamed.people, null);
  const self = c._mapMessage({ id: 4, isInfo: true, text: "You added member Bob.", timestamp: 1,
    systemMessageType: "MemberAddedToGroup", fromId: 1, infoContactId: null });
  assert.equal(self.people, null);
});

test("a failed contact lookup drops the unnamed person (plain text fallback)", async () => {
  const c = core();
  c._call = async () => { throw new Error("offline"); };
  const msg = { people: [{ id: 12, name: "" }] };
  await c._hydrateServicePeople([msg]);
  assert.deepEqual(msg.people, []);
});

test("ChatView chips the service row and opens the tapped contact's profile", async () => {
  const { installChatViewGlobals, installFakeDocument } = await import("./helpers/fake-dom.mjs");
  installChatViewGlobals();
  installFakeDocument();
  const { ChatView, setAvatarProfileOpener } = await import("../app/js/chat-view.js");
  const { diagnosticRow } = await import("../app/js/diagnostics.js");
  const m = { id: 9, kind: "service", text: "Member Bob added by Alice.", ts: 0,
    people: [{ id: 11, name: "Alice" }, { id: 12, name: "Bob" }] };
  const row = diagnosticRow(m);
  ChatView.prototype._chipServiceRow.call({}, row, m, () => true);
  const bubble = row.querySelector(".service-msg");
  assert.match(bubble.innerHTML, /<button type="button" class="svc-chip" data-contact-id="12"[^>]*>Bob<\/button> added by <button[^>]*data-contact-id="11"/);
  const opened = [];
  setAvatarProfileOpener(c => opened.push(c));
  const chip = { dataset: { contactId: "12" } };
  let stopped = false;
  await bubble.fire("click", { target: { closest: sel => (sel === ".svc-chip" ? chip : null) }, stopPropagation: () => { stopped = true; } });
  assert.deepEqual(opened, [{ contactId: 12, name: "Bob" }]);
  assert.equal(stopped, true);
  setAvatarProfileOpener(null);
});
