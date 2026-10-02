import test from "node:test";
import assert from "node:assert/strict";
import { chatCategoryOf } from "../app/js/rpc-core.js";

// #57 chat list categories: every chat lands in exactly one chip; special
// chats are "system"; the P/B split rides the contact's bot flag with a
// people-default for unknown contacts.
test("chatCategoryOf maps chat kinds to category chips", () => {
  assert.equal(chatCategoryOf({ kind: "single", contactId: 4 }), "people");
  assert.equal(chatCategoryOf({ kind: "single", contactId: 7 }, () => true), "bots");
  assert.equal(chatCategoryOf({ kind: "single", contactId: undefined }), "people");
  assert.equal(chatCategoryOf({ kind: "group" }), "groups");
  assert.equal(chatCategoryOf({ kind: "channel" }), "channels");
  assert.equal(chatCategoryOf({ kind: "saved" }), "system");
  assert.equal(chatCategoryOf({ kind: "device" }), "system");
  assert.equal(chatCategoryOf({ kind: "deaddrop" }), "system");
  assert.equal(chatCategoryOf({ kind: "whatever" }), "system");
});

// The isBot callback only ever sees single-chat contact ids.
test("chatCategoryOf asks isBot only for single chats", () => {
  const seen = [];
  chatCategoryOf({ kind: "group" }, (id) => (seen.push(id), true));
  chatCategoryOf({ kind: "single", contactId: 9 }, (id) => (seen.push(id), true));
  assert.deepEqual(seen, [9]);
});
