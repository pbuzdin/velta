import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// "Show only known contacts" (#169): the contact surfaces — New chat /
// Add members picker, Forward-to modal, Contacts view — default to people
// and bots the user has a 1:1 chat with. "Known" = the contactId set from
// state.chats singles (dmChatContact), so no per-contact RPCs. One persisted
// checkbox per surface, all bound to the same key, default ON.
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const app = read("app/js/app.js");

test("setting: one persisted key, default ON, known = 1:1-chatted contact ids", () => {
  assert.match(app, /const KNOWN_CONTACTS_KEY = "velta-known-contacts-only";/);
  assert.match(app, /localStorage\.getItem\(KNOWN_CONTACTS_KEY\) !== "0"/, "absent = ON");
  assert.match(app, /state\.chats\.filter\(c => c\.kind === "single" && c\.contactId\)\.map\(c => c\.contactId\)/);
  // Storage semantics match the drawer toggles: "0" = off, absent = on.
  assert.match(app, /if \(box\.checked\) localStorage\.removeItem\(KNOWN_CONTACTS_KEY\);/);
});

test("contact pickers (New chat + Add members): toggle filters, filtered-empty has a hint", () => {
  const pick = app.slice(app.indexOf("async function pickContactModal("), app.indexOf("// New-chat actions"));
  assert.match(pick, /knownContactsToggleRow\(\(\) => \{ knownOnly = knownContactsOnly\(\); applyKnownFilter\(\); \}\)/);
  assert.match(pick, /const hit = !knownOnly \|\| known\.has\(c\.id\);/);
  assert.match(pick, /item\.hidden = !hit/);
  assert.match(pick, /untick “Show only known contacts” to see everyone/);
  // Resolving a pick uses ALL contacts — hiding an item must not exclude it
  // from a multi-select made before the filter flipped.
  assert.match(pick, /resolve\(contacts\.filter\(c => selected\.has\(c\.id\)\)\)/);
});

test("forward modal: the toggle joins the search in one combined filter", () => {
  const fwd = app.slice(app.indexOf("async function forwardFlow("), app.indexOf("/* ---------------- drawer"));
  assert.match(fwd, /wrap\.append\(knownContactsToggleRow\(applyFilter\), search, list, empty\)/);
  assert.match(fwd, /\(!knownContactsOnly\(\) \|\| chat\.kind === "single"\)/);
  assert.match(fwd, /applyFilter\(\);\n  search\.addEventListener\("input", applyFilter\);/);
});

test("contacts view: toggle above the scroller host, data filtered, filtered-empty hint", () => {
  const view = app.slice(app.indexOf("async function renderContactsView("), app.indexOf("// Archived chats folder"));
  assert.match(view, /rows\.before\(knownContactsToggleRow\(\(\) => renderContactsView\(\)\)\)/);
  assert.match(view, /contacts = contacts\.filter\(c => known\.has\(c\.id\)\);/);
  assert.match(view, /No known contacts yet — untick “Show only known contacts” above to see everyone\./);
});
