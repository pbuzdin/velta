// Stalls must not render failed loads as empty lists (relays, Bots chip,
// chat list): last good data stays, a Retry banner appears.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLastGood, loadErrorText, loadErrorBanner } from "../app/js/load-retry.js";
import fr from "../app/locales/fr.json" with { type: "json" };
import ru from "../app/locales/ru.json" with { type: "json" };

const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");

test("last good value survives a failed load, per scope", () => {
  const lg = createLastGood();
  assert.deepEqual(lg.fail(1, new Error("rpc timeout: list_transports")).value, null);
  lg.ok(1, [{ addr: "a@x" }, { addr: "b@y" }]);
  const s = lg.fail(1, new Error("rpc timeout: list_transports"));
  assert.equal(s.value.length, 2);
  assert.match(String(s.error.message), /timeout/);
  assert.equal(lg.get(2).value, null);
  assert.equal(lg.ok(1, []).error, null);
});

test("error text names a busy core on timeout", () => {
  assert.equal(loadErrorText(new Error("rpc timeout: get_contacts")), "Couldn't load — the core is busy.");
  assert.equal(loadErrorText(new Error("boom")), "Couldn't load.");
});

function fakeDoc() {
  const mk = tag => ({ tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: "",
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); },
    addEventListener(k, f) { this.listeners[k] = f; } });
  return { createElement: mk };
}

test("banner is an alert with a working Retry button", () => {
  let retried = 0;
  const el = loadErrorBanner(fakeDoc(), { err: new Error("rpc timeout: x"), t: s => s, stale: true, onRetry: () => retried++ });
  assert.equal(el.attrs.role, "alert");
  assert.match(el.children[0].textContent, /core is busy.*last loaded/);
  el.children[1].listeners.click({ stopPropagation() {} });
  assert.equal(retried, 1);
});

test("strings translated in ru and fr", () => {
  for (const k of ["Couldn't load — the core is busy.", "Couldn't load.", "Showing the last loaded list.", "Retry"]) {
    assert.ok(ru[k] && ru[k] !== k, "ru " + k);
    assert.ok(fr[k] && fr[k] !== k, "fr " + k);
  }
});

test("app: failed get_contacts no longer becomes an empty bot map", () => {
  assert.doesNotMatch(app, /catch \{ state\.contactBots = new Map\(\); \}/);
  assert.match(app, /state\.contactBotsError = \{ acct, err \}/);
  assert.match(app, /state\.contactBotsError\?\.acct !== core\?\.accountId\) ensureContactBots\(\)/);
});

test("app: relays modal keeps the last good list and never shows 'No relays' for a failure", () => {
  assert.match(app, /relaysLastGood\.fail\(scope, err\)/);
  assert.doesNotMatch(app, /Failed to load relays:/);
});

test("app: chat list failure keeps state.chats and flags a retry banner", () => {
  assert.match(app, /state\.chatListError = err \|\| new Error/);
  assert.match(app, /loadErrorBanner\(document, \{\s*err: loadErr/);
});

// WCAG AA: banner ink --text and Retry --accent-text on --bg-sidebar.
function block(sel) {
  const i = css.indexOf(sel + " {"); assert.ok(i >= 0, sel);
  return css.slice(i, css.indexOf("\n}", i));
}
const val = (b, v) => b.match(new RegExp(`--${v}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("banner contrast AA in dark, light, brutal", () => {
  const root = block(":root");
  for (const sel of [":root", 'html[data-theme="light"]', 'html[data-theme="brutal"]']) {
    const b = block(sel);
    const bg = val(b, "bg-sidebar") || val(root, "bg-sidebar");
    for (const ink of ["text", "accent-text"]) {
      const fg = val(b, ink) || val(root, ink);
      if (!fg) continue; // var() indirection — covered by the theme's own tests
      assert.ok(ratio(fg, bg) >= 4.5, `${sel} ${ink} ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
    }
  }
});

test("withTimeout caps a stalled extra and passes fast results through", async () => {
  const { withTimeout } = await import("../app/js/load-retry.js");
  assert.equal(await withTimeout(Promise.resolve(5), 50), 5);
  await assert.rejects(withTimeout(new Promise(() => {}), 10, "get_server_metadata"), /rpc timeout: get_server_metadata/);
});

test("app: relay extras are time-capped and paused states keep their last good value", () => {
  assert.match(app, /withTimeout\(core\.getServerMetadata\?\.\(\)/);
  assert.match(app, /withTimeout\(core\.getConnectivityHtml\(\)/);
  assert.match(app, /relayStatesLastGood\.fail\(scope, err\)/);
});
