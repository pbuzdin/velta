import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #456: the + left the bottom bar — a floating chip on the chats view only —
// and Velta Loop took its slot as a bar view (engine-gated). The in-list
// lc-card is retired; the hub renders in the side-view shell.
const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("bar markup: Loop in, + out", () => {
  const html = read("app/index.html");
  assert.match(html, /id="bar-loop" class="bar-btn" data-view="loop"[^>]*hidden/);
  assert.match(html, /id="bar-menu"/);
  assert.doesNotMatch(html, /id="btn-new-chat"[^>]*bar-btn/); // no longer a bar button
  assert.match(html, /id="btn-new-chat" class="bar-accent list-new"[^>]*hidden/);
});

test("loop icon exists for the bar", () => {
  const icons = read("app/js/icons.js");
  assert.match(icons, /loop: '<path/);
});

test("setListView renders the loop view; chip syncs on every view", () => {
  const app = strip(read("app/js/app.js"));
  assert.match(app, /if \(listView === "loop"\) \{ renderLoopView\(\); syncPlusChip\(\); return; \}/);
  assert.match(app, /function syncPlusChip\(\)/);
  assert.match(app, /plus\.hidden = listView !== "chats" \|\| collapsed;/);
  // the + keeps its new-chat behavior
  assert.match(app, /btn-new-chat"\).addEventListener\("click", \(\) => setListView\(listView === "new" \? "chats" : "new"\)\)/);
});

test("applyBarVisibility gates loop on the p2p engine", () => {
  const app = strip(read("app/js/app.js"));
  assert.match(app, /key !== "loop" \|\| \(p2pAvailable\(\) && isTauri\(\)\)/);
  assert.match(app, /\["chats", "contacts", "calls", "qr", "loop"\]/);
});

test("the lc-card container is retired, not fed", () => {
  const app = strip(read("app/js/app.js"));
  assert.match(app, /async function renderLocalChatCard\(\)/);
  assert.match(app, /if \(el\) el\.hidden = true;/);
  assert.match(app, /async function renderLoopView\(\)/);
  // the loop view uses the same hub model and offers the same actions
  for (const fn of ["hubModel()", "showInviteModal(invoke, renderQr)", "addContact(invoke)",
    "newLocalGroupFlow()", "renameDevice(name.trim())", "removePeer(peerId)", "pairNearbyFlow(invoke, btn.dataset.pair)"]) {
    assert.ok(app.includes(fn), `loop view must keep: ${fn}`);
  }
});

test("settings: Bottom bar buttons has the loop key, engine-gated", () => {
  const ui = strip(read("app/js/ui.js"));
  assert.match(ui, /\["loop", "Velta Loop"\]/);
  assert.match(ui, /key === "loop" && !p2pAvailable && !p2pOn \? ' hidden'/);
});

test("list-collapse announces collapse so the chip can hide", () => {
  const lc = strip(read("app/js/list-collapse.js"));
  assert.match(lc, /velta-list-collapse/);
});
