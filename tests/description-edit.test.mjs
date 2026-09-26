import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { MockCore } from "../app/js/mock-core.js";

// rpc-core wrappers ride the account-isolation _call path and pass the right
// method + arguments; clearing normalizes to the core's clear values.
test("rpc-core description/selfstatus wrappers", async () => {
  const calls = [];
  class Probe extends JsonRpcCore {
    async _call(method, ...args) { calls.push([method, ...args]); return ""; }
  }
  const core = new Probe();
  core.accountId = 7;

  await core.setChatDescription(10, "Trip plans");
  await core.setChatDescription(10, "");
  await core.setSelfStatus("  hi there  ");
  await core.setSelfStatus("   ");
  await core.renameChat(10, "  New name  ");
  await core.setChatImage(10, "/uploads/x.png");
  await core.setChatImage(10, null);

  assert.deepEqual(calls, [
    ["set_chat_description", 7, 10, "Trip plans"],
    ["set_chat_description", 7, 10, ""],
    ["set_config", 7, "selfstatus", "hi there"],
    ["set_config", 7, "selfstatus", null],
    ["set_chat_name", 7, 10, "New name"],
    ["set_chat_profile_image", 7, 10, "/uploads/x.png"],
    ["set_chat_profile_image", 7, 10, null],
  ]);
});

// MockCore mirrors the new surface or demo mode throws "not a function".
test("mock-core self status roundtrip", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref(); // constructor starts a sim interval — don't hold the process
  await mock.setSelfStatus("  demo bio  ");
  const self = await mock.getContact(1);
  assert.equal(self.status, "demo bio");
  await mock.setSelfStatus("");
  assert.equal((await mock.getContact(1)).status, "");
});

test("mock-core chat description roundtrip", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref();
  const chat = mock.chats.find(c => c.kind === "group") || mock.chats[0];
  assert.equal(await mock.getChatDescription(chat.id), "");
  await mock.setChatDescription(chat.id, "  demo description  ");
  assert.equal(await mock.getChatDescription(chat.id), "demo description");
  await mock.setChatDescription(chat.id, "");
  assert.equal(await mock.getChatDescription(chat.id), "");
});

// MockCore mirrors the chat name/picture surface (group & channel editors).
test("mock-core rename + chat image roundtrip", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref();
  const chat = mock.chats.find(c => c.kind === "group") || mock.chats[0];
  await mock.renameChat(chat.id, "  Renamed Crew  ");
  assert.equal(chat.name, "Renamed Crew");
  await mock.renameChat(chat.id, "   "); // empty rename is a no-op, never a blank name
  assert.equal(chat.name, "Renamed Crew");
  const listed = (await mock.getChatList()).find(c => c.id === chat.id);
  assert.equal(listed.name, "Renamed Crew");
  await mock.setChatImage(chat.id, "data:image/png;base64,AAA");
  assert.equal(chat.avatar, "data:image/png;base64,AAA");
  await mock.setChatImage(chat.id, null);
  assert.equal(chat.avatar, null);
});
