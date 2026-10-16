import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The early "Velta Diagnostics" chat is clickable while app.js is suspended
// on its top-level `await coreStartupPromise` (worker-wasm init takes 10+ s
// on phones). Tapping it ran openDiagnosticsChat -> renderChatList ->
// syncChatCategoryBar / watchChatItemGhosts, which read module consts
// declared further down (chatCatsEl, chatItemGhostIO) still in their TDZ:
// "ReferenceError: Cannot access 'chatCatsEl' before initialization".
// renderChatList must defer until the module finished evaluating.
const src = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("__veltaAppEvaluating flag is declared before the top-level core await", () => {
  const decl = code.indexOf("globalThis.__veltaAppEvaluating = true");
  const firstAwait = code.search(/^\s*core = withLocalChat\(await coreStartupPromise\)/m);
  assert.ok(decl > 0 && firstAwait > 0 && decl < firstAwait);
});

test("renderChatList bails out while the module is still evaluating", () => {
  const body = code.slice(code.indexOf("function renderChatList() {"));
  assert.match(body.slice(0, 200), /if \(globalThis\.__veltaAppEvaluating\) \{ chatListRenderDeferred = true; return; \}/);
});

test("module end flips the flag and flushes a deferred render before boot()", () => {
  const tail = code.trimEnd().slice(-300);
  assert.match(tail, /globalThis\.__veltaAppEvaluating = false;[\s\S]*chatListRenderDeferred[\s\S]*renderChatList\(\);[\s\S]*boot\(\);$/);
});
