// Person colors vs WCAG (AGENTS.md 6.4): every nameColor hue (all 360) and a
// sweep of contact colors (the mock palette plus a hue x lightness grid, the
// shape of the core's per-address colors):
//   - avatar fills carry soft-white initials at >= 3:1 (large text);
//   - sender-name text is >= 4.5:1 on the incoming bubble of dark, light and
//     brutal, and keeps the hue (within 12 degrees).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = { globalThis: {} }; ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(new URL("../app/js/chat-appearance.js", import.meta.url), "utf8"), ctx);
globalThis.VeltaChatAppearance = ctx.VeltaChatAppearance;
const NC = await import("../app/js/name-color.js");
const SURF = ctx.VeltaChatAppearance.SURF;
const ink = [244, 244, 244];

const hue = rgb => { const [r, g, b] = rgb.map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return null; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360 };
const hueDist = (a, b) => a == null || b == null ? 0 : Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
// names whose hash lands on every hue
const NAMES = []; { const seen = new Set(); for (let i = 0; seen.size < 360 && i < 200000; i++) { const n = "p" + i; let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0; if (!seen.has(h % 360)) { seen.add(h % 360); NAMES.push(n) } } }
const GRID = []; for (let h = 0; h < 360; h += 15) for (const l of [35, 45, 55, 65, 75]) GRID.push(`hsl(${h} 55% ${l}%)`);
const MOCK = ["#c6853f", "#3f8fc6", "#6a5acd", "#4fae4f", "#c65a8e", "#7d8a99", "#5aa2e6", "#777"];

test("nameColor covers all 360 hues and every fill carries white initials >= 3:1", () => {
  assert.equal(NAMES.length, 360);
  const bad = NAMES.map(n => [n, NC.nameColor(n)]).filter(([, c]) => NC.contrastRgb(ink, NC.parseColor(c)) < 3);
  assert.deepEqual(bad, []);
});

test("avatarFill: >= 3:1 for every contact color, unchanged when it already passes", () => {
  for (const c of [...MOCK, ...GRID, ...NAMES.map(NC.nameColor)]) {
    const f = NC.avatarFill(c);
    assert.ok(NC.contrastRgb(ink, NC.parseColor(f)) >= 3, `${c} -> ${f}`);
    if (NC.contrastRgb(ink, NC.parseColor(c)) >= 3) assert.equal(f, c);
    assert.ok(hueDist(hue(NC.parseColor(c)), hue(NC.parseColor(f))) <= 12, `hue kept ${c} -> ${f}`);
  }
});

test("sender names >= 4.5:1 on the incoming bubble in dark, light and brutal, hue kept", () => {
  const bad = [];
  for (const c of [...MOCK, ...GRID, ...NAMES.map(NC.nameColor)]) {
    const vars = Object.fromEntries(NC.senderColorVars(c).split(";").map(p => p.split(":").map(s => s.trim())));
    for (const [k, th] of [["--sender", "dark"], ["--sender-light", "light"], ["--sender-brutal", "brutal"]]) {
      const fg = NC.parseColor(vars[k]), bg = NC.parseColor(SURF[th].bubbleIn);
      const r = NC.contrastRgb(fg, bg);
      if (r < 4.5) bad.push(`${c} ${th}: ${vars[k]} ${r.toFixed(2)}`);
      if (hueDist(hue(NC.parseColor(c)), hue(fg)) > 12) bad.push(`${c} ${th}: hue drift ${vars[k]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("the group-call app's avatar color matches nameColor", () => {
  const src = readFileSync(new URL("../app/webxdc/group-call/main.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("  function hsl2rgb"), src.indexOf("  // The host's live design tokens"));
  const color = vm.runInNewContext(fn + "; color");
  for (const n of NAMES.slice(0, 120).concat(["Mara Voss", "Ada Byron", "Yuki"])) assert.equal(color(n), NC.nameColor(n), n);
});
