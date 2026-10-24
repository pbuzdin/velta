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
    "async function deleteLocalGroupChat(",
    "async function leaveLocalGroupFlow(",
    "async function confirmRemovePeer(",
    "async function closeVanishedGroupChat(",
    "function p2pGroupActionsHtml(",
    "async function newLocalGroupFlow()",
    "async function refreshLocalGroupHeader(",
    "async function editProfileFlow()", // sentinel: edit this list when moving top-level functions
  ]) {
    assert.ok(stripped.includes(fn), `missing outside comments: ${fn}`);
  }
});

// 1.4.80 shipped a dead attach menu: the action-bar rework removed
// showContextMenu from chat-view.js's ui.js import while the attach menu
// (an untested path) still called it — ReferenceError at runtime, suite
// green. Any ui.js export referenced by a consumer must be imported there.
test("every ui.js export referenced by a consumer is imported", () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const ui = strip(readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8"));
  const exported = [...ui.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map(m => m[1]);
  assert.ok(exported.includes("showContextMenu"), "export inventory is live");
  for (const file of ["../app/js/chat-view.js", "../app/js/app.js"]) {
    const src = strip(readFileSync(new URL(file, import.meta.url), "utf8"));
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/ui\.js"/g)) {
      m[1].split(",").forEach(n => { const name = n.trim().split(/\s+as\s+/)[0]; if (name) imported.add(name); });
    }
    const missing = exported.filter(name =>
      new RegExp(`(?<![\\w$."])${name}\\b`).test(src) && !imported.has(name));
    assert.deepEqual(missing, [], `${file}: referenced but not imported from ui.js`);
  }
});
