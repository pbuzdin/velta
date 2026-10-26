import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatTime, formatDateTime, formatDay } from "../app/js/format.js";

// Fix 4: cached Intl formatters must match the old toLocale* output exactly.
const H24 = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

test("cached formatters match toLocale* output", () => {
  const now = Date.now();
  for (const ts of [now, now - 3600e3 * 13, now - 86400e3 * 40, Date.UTC(2020, 1, 3, 23, 59, 7), Date.UTC(2021, 11, 31, 0, 5)]) {
    const d = new Date(ts);
    assert.equal(formatTime(ts), d.toLocaleTimeString([], H24));
    assert.equal(formatDateTime(ts), `${d.toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" })} ${d.toLocaleTimeString([], { ...H24, second: "2-digit" })}`);
  }
  const old = Date.UTC(2020, 1, 3, 12);
  assert.equal(formatDay(old), new Date(old).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }));
  assert.equal(formatDay(now), "Today");
  assert.equal(formatDateTime(NaN), "—");
});

test("the sticky day chip has no backdrop-filter blur", () => {
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const rule = css.match(/\n\.day-chip \{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /backdrop-filter\s*:/);
  assert.match(rule, /background: #[0-9a-f]{6};/i, "opaque fill keeps contrast independent of content behind");
});
