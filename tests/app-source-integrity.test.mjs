import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A stray unterminated block comment silently turns every function below it
// into comment text — node --check still passes, and the UI dies at runtime
// with "X is not defined" (v1.4.34/1.4.35 shipped askNotificationPermission
// and addAccountFromInvite this way after a duplicated section header).
// Strip comments the way the engine sees them and assert that functions
// touched by refactors really exist outside comments.
const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("app.js definitions are not swallowed by a block comment", () => {
  for (const fn of [
    "async function askNotificationPermission()",
    "async function addAccountFromInvite(",
    "async function showChatInfo(",
    "function openProfileManagement(",
    "async function editProfileFlow()", // sentinel: edit this list when moving top-level functions
  ]) {
    assert.ok(stripped.includes(fn), `missing outside comments: ${fn}`);
  }
});
