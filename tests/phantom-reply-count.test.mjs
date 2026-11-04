import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// SQLite LIKE is case-insensitive: 'q=%' also matched a webxdc's 'Q='
// (WebxdcSummaryTimestamp) line, so the app counted as a reply to the
// previous message. GLOB is case-sensitive.
test("reply filters match the quote param case-sensitively", () => {
  for (const p of ["tools/apply-core-patches.py", "core/src/chat.rs"]) {
    const s = src(p);
    assert.doesNotMatch(s, /LIKE '%' \|\| char\(10\) \|\| '[qa]=%'/, p);
    assert.match(s, /replies\.param\) GLOB '\*' \|\| char\(10\) \|\| 'q=\*'/, p);
    assert.match(s, /replies\.param\) NOT GLOB '\*' \|\| char\(10\) \|\| 'a=\*'/, p);
  }
});

test("sticker and app sends carry the active reply", () => {
  const s = src("app/js/chat-view.js");
  assert.equal((s.match(/viewtype: "webxdc", file: [^\n]*\.\.\.this\._quoteFields\(\)/g) || []).length, 4);
  assert.match(s, /viewtype: "sticker", file: path, \.\.\.this\._quoteFields\(\)/);
});
