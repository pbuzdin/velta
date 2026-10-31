// Contact profile: one "Relays" list (all relay addresses from the contact's
// key, as core's encryption info lists them), primary address first and
// badged; a single address (no key) stays an "Address" row.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relayAddresses } from "../app/js/avatar.js";
import { contactAddrRowsHtml } from "../app/js/contact-addrs.js";

const INFO = "Messages are end-to-end encrypted.\nFingerprints:\n\nMe:\nAAAA BBBB CCCC DDDD EEEE\nFFFF 0000 1111 2222 3333\n\nBob:\n4444 5555 6666 7777 8888\n9999 AAAA BBBB CCCC DDDD\n\nRelays:\nbob@two.example\nBob@one.example\n";

test("relayAddresses: primary first, the key's relays after, deduped case-insensitively", () => {
  assert.deepEqual(relayAddresses(INFO, "bob@one.example"), ["bob@one.example", "bob@two.example"]);
});

test("relayAddresses: no key / no Relays section -> the primary address only", () => {
  assert.deepEqual(relayAddresses("No encryption.", "bob@one.example"), ["bob@one.example"]);
  assert.deepEqual(relayAddresses(null, ""), []);
});

test("multi-relay contact renders a Relays list with a Primary badge on the first row", () => {
  const html = contactAddrRowsHtml(["bob@one.example", "bob@two.example"]);
  assert.match(html, /<span class="k">Relays<\/span><span class="v">\(2\)<\/span>/);
  const rows = html.match(/data-copy-addr="[^"]+"/g);
  assert.deepEqual(rows, ['data-copy-addr="bob@one.example"', 'data-copy-addr="bob@two.example"']);
  assert.equal((html.match(/addr-primary-badge/g) || []).length, 1);
  assert.ok(html.indexOf("addr-primary-badge") < html.indexOf("bob@two.example"));
  assert.match(html, /role="button" tabindex="0"/);
});

test("single address renders one copyable Address row, no badge, no separate Relay row", () => {
  const html = contactAddrRowsHtml(["bob@one.example"]);
  assert.match(html, /<span class="k">Address<\/span><span class="v">bob@one.example<\/span>/);
  assert.doesNotMatch(html, /Primary|Relays/);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /t\("Relay"\)\)\}<\/span><span class="v">\$\{escapeHtml\(String\(contactAddr\)/);
});

test("new strings are translated in ru and fr", () => {
  for (const lang of ["ru", "fr"]) {
    const d = JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), "utf8"));
    for (const k of ["Primary", "Address copied", "Relays", "Address", "Copy"]) assert.ok(d[k], `${lang}: ${k}`);
  }
});

test("badge uses theme tokens only (AA follows each theme's text/background pair)", () => {
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const rule = css.slice(css.indexOf(".addr-primary-badge {"), css.indexOf("}", css.indexOf(".addr-primary-badge {")));
  assert.match(rule, /color: var\(--text\)/);
  assert.match(rule, /background: var\(--bg-sidebar\)/);
  assert.doesNotMatch(rule, /#[0-9a-f]{3,6}/i);
});
