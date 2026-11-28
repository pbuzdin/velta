// #523: relay status colors are theme tokens (--status-*), never raw hex, and
// pass WCAG AA on every theme: 4.5:1 where used as text (.relay-pct,
// .relay-detail-send), 3:1 as non-text (line segments, chip borders, dots).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const block = sel => { const i = CSS.indexOf(sel + " {"); assert.ok(i >= 0, sel); return CSS.slice(i, CSS.indexOf("\n}", i)); };
const parse = b => Object.fromEntries([...b.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)].map(m => [m[1], m[2].trim()]));
const ROOT = parse(block(":root"));
const THEMES = {
  dark: ROOT,
  light: { ...ROOT, ...parse(block('html[data-theme="light"]')) },
  brutal: { ...ROOT, ...parse(block('html[data-theme="brutal"]')) },
};
const lum = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255].map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };

// Every relay-status rule: [selector, declaration text]
const RULES = [...CSS.matchAll(/([^{}]*(?:relay-seg|relay-detail-chip|relay-detail-send|relay-pct|lc-dot)[^{}]*)\{([^}]*)\}/g)]
  .map(m => [m[1].trim(), m[2]]).filter(([, b]) => /color|background/.test(b));

test("relay status rules use no raw colors", () => {
  const bad = RULES.filter(([sel, b]) => /\[data-(state|smtp|level)=|\.on\b/.test(sel) && /#[0-9a-f]{3,8}\b/i.test(b)).map(([s, b]) => `${s} { ${b.trim()} }`);
  assert.deepEqual(bad, []);
});

test("relay status tokens pass AA on every theme", () => {
  const tokens = ["ok", "warn", "down", "off", "local"].map(n => "--status-" + n);
  for (const [theme, t] of Object.entries(THEMES)) {
    for (const tok of tokens) {
      assert.match(t[tok] || "", /^#[0-9a-f]{6}$/i, `${theme} ${tok}`);
      for (const bgTok of ["--bg-sidebar", "--bg"]) {
        const r = ratio(t[tok], t[bgTok]);
        assert.ok(r >= 4.5, `${theme} ${tok} ${t[tok]} on ${bgTok} ${t[bgTok]} = ${r.toFixed(2)} (< 4.5)`);
      }
    }
  }
});

test("text uses resolve to tokens", () => {
  const text = RULES.filter(([s]) => /relay-pct|relay-detail-send\[/.test(s));
  assert.ok(text.length >= 7);
  for (const [s, b] of text) assert.match(b, /color:\s*var\(--status-/, s);
});
