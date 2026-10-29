import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Android 1.4.87: an outgoing bubble with a thread button collapsed to one
// letter per line when its row also carried the "Unread messages" line or the
// read marker. .msg-thread-line had flex: 1 1 0 AND min-width: 0, so its
// hypothetical size was 0; the full-width separator (100% outer) still fit on
// the same flex line, the thread line got 0px and the bubble shrank to its
// overflow-wrap:anywhere min-content. A non-zero min-width forces the wrap.
const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const rule = sel => {
  const m = css.match(new RegExp(sel.replace(/[.]/g, "\\.") + " \\{([^}]*)\\}"));
  assert.ok(m, `${sel} rule exists`);
  return m[1];
};

test("thread line never shares a flex line with the full-width separators", () => {
  const line = rule(".msg-thread-line");
  assert.match(line, /flex: 1 1 0;/, "basis 0 keeps it beside the avatar");
  const min = line.match(/min-width:\s*([^;]+);/)?.[1]?.trim();
  assert.ok(min && !/^0(px|%)?$/.test(min), `min-width must be non-zero, got ${min}`);
  const pct = Number(min.match(/^(\d+(?:\.\d+)?)%$/)?.[1]);
  assert.ok(pct > 0 && pct <= 60, "percent floor leaves room for the 50px avatar column");
  // The separators that ride inside a row take the full width (with margins),
  // so any non-zero thread line must wrap them onto their own line.
  for (const sel of [".unread-sep", ".read-marker"]) {
    const r = rule(sel);
    assert.match(r, /width: calc\(100% - 48px\)/);
    assert.match(r, /margin: [^;]*24px/);
  }
});
