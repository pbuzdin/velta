// WCAG AA (4.5:1) for the dim in-bubble labels: "Forwarded a message"
// (.msg-fwd), "edited" + timestamp (.msg-meta), quote sender (.q-name), and
// the read ticks (3:1, icon). Every theme, both bubble sides, the default
// accent and custom accents (dark, mid, light/yellow, near-white).
// Translucent layers (--bg-reply) are composited over the real bubble first.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CSS = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const SRC = readFileSync(new URL("../app/js/chat-appearance.js", import.meta.url), "utf8");
const ctx = { globalThis: {} }; ctx.globalThis = ctx; vm.runInNewContext(SRC, ctx);
const A = ctx.VeltaChatAppearance;

const block = sel => { const i = CSS.indexOf(sel + " {"); assert.ok(i >= 0, sel); return CSS.slice(i, CSS.indexOf("\n}", i)); };
const parse = b => Object.fromEntries([...b.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)].map(m => [m[1], m[2].trim()]));
const ROOT = parse(block(":root"));
const THEMES = {
  dark: ROOT,
  light: { ...ROOT, ...parse(block('html[data-theme="light"]')) },
  brutal: { ...ROOT, ...parse(block('html[data-theme="brutal"]')) },
};
function resolve(t, v, depth = 0) {
  assert.ok(depth < 10, "var loop " + v);
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  return m ? resolve(t, t[m[1]], depth + 1) : v;
}
function rgba(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255, 1]; }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) { const p = m[1].split(",").map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error("color? " + v);
}
const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1); };
const mix80 = (a, b) => [0, 1, 2].map(i => a[i] * .8 + b[i] * .2).concat(1);
const lum = c => c.slice(0, 3).map(x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// The CSS rule each label resolves to, per theme/side (see main.css .msg-fwd,
// .msg-meta, .msg-quote .q-name and the brutal overrides).
function pairs(theme, t) {
  const c = n => rgba(resolve(t, t[n]));
  const inB = c("--bg-bubble-in"), outB = c("--bg-bubble-out");
  const reply = c("--bg-reply");
  const outReply = theme === "brutal" ? rgba("rgba(18, 16, 22, .1)") : reply;
  const out = theme === "brutal" ? c("--nb-main-ink") : c("--text-meta-out");
  return [
    ["in .msg-fwd / .msg-meta / .edited", c("--text-meta-in"), inB, 4.5],
    ["out .msg-fwd", out, outB, 4.5],
    ["out .msg-meta / .edited", c("--text-meta-out"), outB, 4.5],
    ["in .q-name", c("--quote-name"), over(reply, inB), 4.5],
    ["out .q-name", c("--quote-name-out"), over(outReply, outB), 4.5],
    // Deleted-message tombstone (.bubble.msg-deleted): secondary text token
    // = --text-dim 80% / --text 20% (out: --text-meta-out; brutal: ink).
    ["in .msg-deleted", mix80(c("--text-dim"), c("--text")), inB, 4.5],
    ["out .msg-deleted", theme === "brutal" ? c("--nb-main-ink") : mix80(c("--text-meta-out"), c("--text")), outB, 4.5],
    ["out .ticks.read (icon)", theme === "brutal" ? c("--nb-main-ink") : c("--ticks-read"), outB, 3],
  ];
}
function check(label, theme, t) {
  const bad = [];
  for (const [what, fg, bg, min] of pairs(theme, t)) {
    const r = ratio(fg, bg);
    if (r < min) bad.push(`${label} ${theme} ${what}: ${r.toFixed(2)} < ${min}`);
  }
  return bad;
}

test("dim in-bubble labels reach AA with the theme accents", () => {
  const bad = Object.entries(THEMES).flatMap(([th, t]) => check("default", th, t));
  assert.deepEqual(bad, []);
});

test("dim in-bubble labels reach AA with custom accents (dark, mid, light, yellow, near-white)", () => {
  const bad = [];
  for (const acc of ["#1d3a8a", "#3fa34d", "#e0516e", "#f2e14c", "#a6e3ff", "#e8e8f0"]) {
    for (const th of ["dark", "light", "brutal"]) {
      const d = A.deriveAccent(acc, th);
      const keys = th === "brutal" ? A.BRUTAL_KEYS : Object.keys(A.VAR_NAMES);
      const t = { ...THEMES[th] };
      for (const k of keys) t[A.VAR_NAMES[k]] = d[k];
      bad.push(...check(acc, th, t));
      // accent fills carry readable ink
      const r = ratio(rgba(d.onAccent), rgba(d.accent));
      if (r < 4.5) bad.push(`${acc} ${th} on-accent: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, []);
});
