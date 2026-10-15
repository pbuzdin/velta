import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { escapeHtml, escapeAttr } from "../app/js/format.js";

test("escapeHtml is null-safe and escapes both quote kinds", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeAttr(`"x"`), "&quot;x&quot;");
});

test("no module in app/js keeps a private HTML-escape copy", () => {
  const dir = new URL("../app/js/", import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith(".js"))) {
    if (f === "format.js") continue;
    const js = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(js, /"&": "&amp;"/, f);
  }
});
