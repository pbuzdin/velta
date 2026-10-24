import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Relays modal details: only data the client already reads (no core patch).
const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");

test("relay details: admin/comment from get_server_metadata, quota from connectivity, escaped", () => {
  const fn = app.slice(app.indexOf("const relayDetailsHtml"), app.indexOf("// One C3 probe per relay domain"));
  assert.match(fn, /meta\?\.comment/);
  assert.match(fn, /meta\?\.admin/);
  assert.match(fn, /escapeHtml\(comment\)/);
  assert.match(fn, /escapeHtml\(admin\)/);
  assert.match(fn, /escapeHtml\(label\)/);
  assert.doesNotMatch(fn, /<a\b/, "relay-supplied strings are never links");
  assert.match(app, /relayDetailsHtml\(metaByAddr\?\.\[t\.addr\] \|\| null, st\?\.quota\)/);
});

test("relay details: quota bar uses design tokens and prints the percent", () => {
  assert.match(css, /\.relay-quota-bar \{[^}]*var\(--bg-hover\)/);
  assert.match(css, /\.relay-quota-bar > span \{[^}]*var\(--text-dim\)/);
  assert.match(css, /\.relay-quota-bar > span\.high \{[^}]*var\(--danger\)/);
  assert.match(app, /\(\$\{pct\}%\)/);
});
