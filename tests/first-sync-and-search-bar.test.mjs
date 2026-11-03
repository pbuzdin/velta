import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #233 first-sync strip: an empty chat list right after login/restore must
// not read as broken — a slim "Fetching messages…" strip rides the same
// connectivity value the relay line uses and hides once the list has real
// chats or the core reaches connected (4000).
// #238 search strip: the in-chat search's FTS query can take seconds (or
// hang on a stall) — a thin sweep bar shows the modal is alive. The P2P
// path filters loaded rows synchronously and never shows it.

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const app = read("app/js/app.js");

function makeHarness({ listView = "chats", connectivity = 2000, chats = [], account = { configured: true }, backend = { kind: "rpc" } } = {}) {
  const span = { text: "" };
  const el = {
    hidden: true,
    querySelector(sel) { assert.equal(sel, "[data-sync-text]"); return { set textContent(v) { span.text = v; }, get textContent() { return span.text; } }; },
  };
  const state = { chats, account };
  const core = { backend };
  const t = (s) => s;
  const fn = app.match(/function renderSyncBar\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "renderSyncBar extracted");
  const renderSyncBar = new Function("$", "state", "listView", "core", "relayConnectivity", "DIAGNOSTICS_CHAT_ID", "t",
    `${fn}; return renderSyncBar;`)(
    (id) => (id === "sync-bar" ? el : null), state, listView, core, connectivity, 9, t);
  return { el, span, state, render: () => renderSyncBar() };
}

test("#233 the strip shows only during an unfinished first fetch on an empty list", () => {
  let h = makeHarness();
  h.render();
  assert.equal(h.el.hidden, false, "fetching state: configured, empty, connecting");
  assert.equal(h.span.text, "Fetching messages…");

  h = makeHarness({ connectivity: 3500 });
  h.render();
  assert.equal(h.span.text, "Updating…", "core actively working upgrades the text");

  h = makeHarness({ connectivity: 4000 });
  h.render();
  assert.equal(h.el.hidden, true, "connected hides the strip");

  h = makeHarness({ chats: [{ id: 9 }, { id: 3 }] });
  h.render();
  assert.equal(h.el.hidden, true, "real chats hide the strip");

  h = makeHarness({ chats: [{ id: 9 }] });
  h.render();
  assert.equal(h.el.hidden, false, "a lone diagnostics chat still counts as empty");

  h = makeHarness({ connectivity: null });
  h.render();
  assert.equal(h.el.hidden, true, "old core without get_connectivity: never stuck on");

  h = makeHarness({ account: { configured: false } });
  h.render();
  assert.equal(h.el.hidden, true, "local mode has no fetch to wait for");

  h = makeHarness({ backend: { kind: "mock" } });
  h.render();
  assert.equal(h.el.hidden, true, "demo mode never shows it");

  h = makeHarness({ listView: "search" });
  h.render();
  assert.equal(h.el.hidden, true, "only the chats view carries the strip");
});

test("#233 wiring: static strip, calls from list render / relay status / view switch / account change", () => {
  const index = read("app/index.html");
  assert.match(index, /<div id="sync-bar" role="status" hidden>/);
  assert.match(index, /data-i18n="Fetching messages…"/);
  const css = read("app/css/main.css");
  // display:flex would defeat the hidden attribute — the explicit rule is load-bearing.
  assert.match(css, /#sync-bar\[hidden\] \{ display: none; \}/);
  assert.match(css, /#sync-bar \{[^}]*color: var\(--text-dim\)/);
  assert.match(app, /watchChatItemGhosts\(list\);\s*\n\s*renderSyncBar\(\);/, "every chat-list render re-evaluates the strip");
  assert.match(app, /renderRelayLine\(\);\s*\n\s*renderSyncBar\(\);/, "connectivity changes re-evaluate the strip");
  assert.match(app, /listView = listView === view \? "chats" : view;\s*\n\s*renderSyncBar\(\);/);
  assert.match(app, /state\.query = "";\s*\n\s*renderSyncBar\(\);/, "account switch starts the new profile's window");
});

test("#238 the search bar rides the RPC path only, with seq-guarded teardown", () => {
  assert.match(app, /const bar = document\.createElement\("progress"\);\s*\n\s*bar\.className = "search-load-bar";/);
  assert.match(app, /wrap\.append\(input, bar, results\);/);
  assert.match(app, /if \(!p2p\) bar\.setAttribute\("data-on", ""\);/, "P2P filter is synchronous — no bar");
  assert.match(app, /if \(q\.length < 2\) \{ bar\.removeAttribute\("data-on"\); return; \}/);
  assert.match(app, /if \(mySeq !== seq\) return; \/\/ a newer run owns the bar\s*\n\s*bar\.removeAttribute\("data-on"\);/, "error path keeps the newer run's bar");
  assert.match(app, /if \(mySeq !== seq \|\| !accountIsCurrent\(epoch\)\) return;\s*\n\s*bar\.removeAttribute\("data-on"\);/);
  const css = read("app/css/main.css");
  assert.match(css, /\.search-load-bar\[data-on\] \{ opacity: 1; \}/);
  assert.match(css, /progress\.search-load-bar::-webkit-progress-bar/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.search-load-bar::before \{ animation: none; \} \}/);
  assert.match(css, /animation: chat-load-sweep 1\.1s ease-in-out infinite;/, "same sweep language as the chat history bar");
});

test("locale packs carry the new strings", () => {
  for (const loc of ["fr", "ru"]) {
    const pack = JSON.parse(read(`app/locales/${loc}.json`));
    for (const k of ["Fetching messages…", "Updating…", "Searching…"]) {
      assert.ok(pack[k], `${loc} translates "${k}"`);
    }
  }
});
