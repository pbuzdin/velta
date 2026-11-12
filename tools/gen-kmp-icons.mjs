// #321 step 2: generate velta-kmp's Compose vector icons from app/js/icons.js
// (the same one-source-per-glyph discipline as gen-kmp-theme.mjs). Reads the
// REAL module (export-stripped, evaluated), parses the 24-grid SVG markup —
// path d-strings, circles, rects, polylines — and emits ImageVector builders
// with the house stroke: 2px, round caps + joins, black ink (Icon() tints it).
// Staleness: tests/kmp-icons.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const SRC = "app/js/icons.js";
const OUT = "velta-kmp/composeApp/src/commonMain/kotlin/org/velta/kmp/ui/VeltaIcons.kt";

// ---- Load the real P set (no hand copies) --------------------------------

const source = readFileSync(new URL(SRC, ROOT), "utf8");
// Strip `export ` so the module body runs inside a plain Function scope.
const body = source.replace(/^export /gm, "");
const P = new Function(`${body}\n;return P;`)();

// ---- SVG markup parsing ---------------------------------------------------

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const tokenNums = (s) => s.match(NUM)?.map(Number) ?? [];

function attrs(tag) {
  const a = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) a[m[1]] = m[2];
  return a;
}

// One SVG shape → { d: kotlinPathStatements, filled: bool }
function parseShape(el) {
  const tag = el.match(/^<([a-zA-Z]+)/)?.[1];
  const a = attrs(el);
  // Per-element override; house ATTRS default is fill=none stroke=currentColor.
  const filled = a.fill === "currentColor" || a.fill === undefined && a.stroke === "none";
  if (tag === "path") return { d: parseD(a.d), filled };
  if (tag === "circle") {
    const [cx, cy, r] = [Number(a.cx), Number(a.cy), Number(a.r)];
    return { d: circlePath(cx, cy, r), filled };
  }
  if (tag === "rect") {
    const [x, y, w, h] = [Number(a.x), Number(a.y), Number(a.width), Number(a.height)];
    const rx = a.rx ? Number(a.rx) : 0;
    return { d: rectPath(x, y, w, h, rx), filled };
  }
  if (tag === "polyline") {
    const n = tokenNums(a.points);
    const parts = [`moveTo(${f(n[0])}f, ${f(n[1])}f)`];
    for (let i = 2; i < n.length; i += 2) parts.push(`lineTo(${f(n[i])}f, ${f(n[i + 1])}f)`);
    return { d: parts.join("\n        "), filled };
  }
  throw new Error(`unsupported element <${tag}>`);
}

const f = (n) => (Number.isInteger(n) ? `${n}.0` : String(Number(n.toFixed(3))));

function circlePath(cx, cy, r) {
  return [
    `moveTo(${f(cx + r)}f, ${f(cy)}f)`,
    `arcTo(${f(r)}f, ${f(r)}f, 0.0f, true, true, ${f(cx - r)}f, ${f(cy)}f)`,
    `arcTo(${f(r)}f, ${f(r)}f, 0.0f, true, true, ${f(cx + r)}f, ${f(cy)}f)`,
    `close()`,
  ].join("\n        ");
}

function rectPath(x, y, w, h, rx) {
  const r = Math.min(rx, w / 2, h / 2);
  const parts = [`moveTo(${f(x + r)}f, ${f(y)}f)`];
  if (r > 0) {
    parts.push(
      `horizontalLineTo(${f(x + w - r)}f)`,
      `arcTo(${f(r)}f, ${f(r)}f, 0.0f, false, true, ${f(x + w)}f, ${f(y + r)}f)`,
      `verticalLineTo(${f(y + h - r)}f)`,
      `arcTo(${f(r)}f, ${f(r)}f, 0.0f, false, true, ${f(x + w - r)}f, ${f(y + h)}f)`,
      `horizontalLineTo(${f(x + r)}f)`,
      `arcTo(${f(r)}f, ${f(r)}f, 0.0f, false, true, ${f(x)}f, ${f(y + h - r)}f)`,
      `verticalLineTo(${f(y + r)}f)`,
      `arcTo(${f(r)}f, ${f(r)}f, 0.0f, false, true, ${f(x + r)}f, ${f(y)}f)`,
      `close()`,
    );
  } else {
    parts.push(
      `horizontalLineTo(${f(x + w)}f)`,
      `verticalLineTo(${f(y + h)}f)`,
      `horizontalLineTo(${f(x)}f)`,
      `close()`,
    );
  }
  return parts.join("\n        ");
}

// ---- SVG d-string → Kotlin PathBuilder ------------------------------------

// SVG d-string → Kotlin PathBuilder. Position-aware scanner: SVG arc flags
// may be PACKED into the next number ("0 012-2" = flag 0, flag 1, number 2),
// so numbers and flags must be read contextually, never pre-tokenized.
function parseD(d) {
  const out = [];
  const reNum = /(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;
  let pos = 0, cur = [0, 0], start = [0, 0], lastC = null, lastQ = null, prev = "";
  const skip = () => {
    while (pos < d.length && (d[pos] === " " || d[pos] === "," || d[pos] === "\n" || d[pos] === "\t")) pos++;
  };
  const isLetter = (ch) => ch >= "A" && ch <= "Z" || ch >= "a" && ch <= "z";
  const num = () => {
    skip();
    reNum.lastIndex = pos;
    const m = reNum.exec(d);
    if (!m) throw new Error(`expected number at ${pos}: "${d.slice(pos, pos + 8)}"`);
    pos = reNum.lastIndex;
    return Number(m[1]);
  };
  const flag = () => {
    skip();
    const ch = d[pos];
    if (ch !== "0" && ch !== "1") throw new Error(`bad arc flag at ${pos}: "${d.slice(pos, pos + 8)}"`);
    pos++;
    return ch === "1";
  };
  const pair = () => [num(), num()];
  const cmd = (name, args) => out.push(`${name}(${args.map((v) => (typeof v === "boolean" ? String(v) : `${f(v)}f`)).join(", ")})`);

  while (true) {
    skip();
    if (pos >= d.length) break;
    let c;
    if (isLetter(d[pos])) { c = d[pos]; pos++; }
    else if (prev === "M") c = "L";
    else if (prev === "m") c = "l";
    else if (!prev) throw new Error("path must start with a command");
    else c = prev;
    prev = c;
    switch (c) {
      case "M": { cur = pair(); start = [...cur]; cmd("moveTo", cur); break; }
      case "m": { const [dx, dy] = pair(); cur = [cur[0] + dx, cur[1] + dy]; start = [...cur]; cmd("moveToRelative", [dx, dy]); break; }
      case "L": { cur = pair(); cmd("lineTo", cur); break; }
      case "l": { const [dx, dy] = pair(); cur = [cur[0] + dx, cur[1] + dy]; cmd("lineToRelative", [dx, dy]); break; }
      case "H": { cur = [num(), cur[1]]; cmd("horizontalLineTo", [cur[0]]); break; }
      case "h": { const dx = num(); cur = [cur[0] + dx, cur[1]]; cmd("horizontalLineToRelative", [dx]); break; }
      case "V": { cur = [cur[0], num()]; cmd("verticalLineTo", [cur[1]]); break; }
      case "v": { const dy = num(); cur = [cur[0], cur[1] + dy]; cmd("verticalLineToRelative", [dy]); break; }
      case "C": { const a = pair(), b = pair(), c2 = pair(); lastC = [...b]; cur = [...c2]; cmd("curveTo", [...a, ...b, ...c2]); break; }
      case "c": {
        const a = pair(), b = pair(), c2 = pair();
        lastC = [cur[0] + b[0], cur[1] + b[1]];
        const abs = [cur[0] + c2[0], cur[1] + c2[1]];
        cmd("curveToRelative", [...a, ...b, ...c2]); cur = abs; break;
      }
      case "S": {
        const c2 = pair(), p = pair();
        const c1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : [...cur];
        lastC = [...c2]; cur = [...p];
        cmd("reflectiveCurveTo", [...c2, ...p]); break;
      }
      case "s": {
        const c2 = pair(), p = pair();
        const c1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : [...cur];
        lastC = [cur[0] + c2[0], cur[1] + c2[1]];
        const abs = [cur[0] + p[0], cur[1] + p[1]];
        cmd("reflectiveCurveToRelative", [...c2, ...p]); cur = abs; break;
      }
      case "Q": { const a = pair(), p = pair(); lastQ = [...a]; cur = [...p]; cmd("quadTo", [...a, ...p]); break; }
      case "q": { const a = pair(), p = pair(); lastQ = [cur[0] + a[0], cur[1] + a[1]]; const abs = [cur[0] + p[0], cur[1] + p[1]]; cmd("quadToRelative", [...a, ...p]); cur = abs; break; }
      case "T": { const p = pair(); const a = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : [...cur]; lastQ = [...a]; cur = [...p]; cmd("reflectiveQuadTo", [...p]); break; }
      case "t": { const p = pair(); const a = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : [...cur]; lastQ = [...a]; const abs = [cur[0] + p[0], cur[1] + p[1]]; cmd("reflectiveQuadToRelative", [...p]); cur = abs; break; }
      case "A": {
        const rx = num(), ry = num(), rot = num();
        const big = flag(), sweep = flag();
        const target = pair();
        cmd("arcTo", [rx, ry, rot, big, sweep, ...target]); cur = [...target]; break;
      }
      case "a": {
        const rx = num(), ry = num(), rot = num();
        const big = flag(), sweep = flag();
        const rel = pair();
        const target = [cur[0] + rel[0], cur[1] + rel[1]];
        cmd("arcToRelative", [rx, ry, rot, big, sweep, ...rel]); cur = target; break;
      }
      case "Z": case "z": { cmd("close", []); cur = [...start]; break; }
      default: throw new Error(`unhandled command ${c}`);
    }
  }
  return out.join("\n        ");
}

// ---- Kotlin emission -------------------------------------------------------

const camel = (n) => n; // icons.js keys are already camelCase
const stmts = (d, filled) => {
  const paint = filled
    ? "fill = SolidColor(Color(0xFF000000)),"
    : [
        "stroke = SolidColor(Color(0xFF000000)),",
        "strokeLineWidth = 2f,",
        "strokeLineCap = StrokeCap.Round,",
        "strokeLineJoin = StrokeJoin.Round,",
      ].join("\n            ");
  return `            addPath(
                pathData = PathData {
        ${d}
                },
                ${paint}
            )`;
};

const entries = Object.entries(P).map(([name, inner]) => {
  const shapes = [...inner.matchAll(/<[a-zA-Z][^>]*\/>/g)].map((m) => m[0]);
  if (shapes.length === 0) throw new Error(`icon ${name}: no shapes`);
  const body = shapes.map((s) => {
    try {
      const shape = parseShape(s);
      return stmts(shape.d, shape.filled);
    } catch (e) {
      throw new Error(`icon ${name} [${s.slice(0, 60)}]: ${e.message}`);
    }
  }).join("\n");
  return `    /** app/js/icons.js P.${name} — house style: 24 grid, stroke 2, round caps. */
    val ${camel(name)}: ImageVector by lazy {
        ImageVector.Builder(
            name = "VeltaIcons.${name[0].toUpperCase()}${name.slice(1)}",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
${body}
        }.build()
    }
`;
});

const out = `// GENERATED from ${SRC} by tools/gen-kmp-icons.mjs — do not edit.
// Regenerate: node tools/gen-kmp-icons.mjs. House style: 24x24 grid, outline,
// stroke-width 2, round caps + joins; ink is black and Icon() tints it.
package org.velta.kmp.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathData
import androidx.compose.ui.unit.dp

object VeltaIcons {

${entries.join("\n")}
}
`;

const header = `// GENERATED from ${SRC} by tools/gen-kmp-icons.mjs — do not edit.\n`;
if (!process.env.VELTA_GEN_NO_WRITE) {
  writeFileSync(new URL(OUT, ROOT), out);
  console.log(`wrote ${OUT} · ${Object.keys(P).length} icons`);
}
export function generateKmpIcons() { return out; }
export const KMP_ICONS_PATH = OUT;
