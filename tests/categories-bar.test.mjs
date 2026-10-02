import test from "node:test";
import assert from "node:assert/strict";
import { chatCategoryOf, swipeCategoryStep } from "../app/js/rpc-core.js";

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

// Swipe axis lock (#57): a horizontal drag past the threshold steps one
// chip; vertical drags, diagonals and short drags never do.
test("swipeCategoryStep steps only on clearly horizontal drags", () => {
  assert.equal(swipeCategoryStep(-80, 0), 1);   // left → next chip
  assert.equal(swipeCategoryStep(80, 0), -1);   // right → previous chip
  assert.equal(swipeCategoryStep(-80, 30), 1);  // slightly diagonal still counts
  assert.equal(swipeCategoryStep(-80, 70), 0);  // vertical-dominant: scroll
  assert.equal(swipeCategoryStep(-20, 0), 0);   // below threshold: tap
  assert.equal(swipeCategoryStep(0, -300), 0);  // pure vertical
  assert.equal(swipeCategoryStep(-47.9, 0), 0); // threshold is exclusive
  assert.equal(swipeCategoryStep(-48, 0), 1);
});
