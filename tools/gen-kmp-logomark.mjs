// Generates velta-kmp's per-choice logomark from the launcher vectors (the
// same one-source-per-glyph discipline as gen-kmp-icons.mjs). Reads the
// androidMain foreground + monochrome vectors and emits:
//   1. VeltaLogomark.kt  — commonMain ImageVector per AppIconChoice (header,
//      welcome screen), cropped to the glyph's bounding box.
//   2. ic_notify_*.xml   — androidMain status-bar glyphs (white, tight
//      square viewport) for the notification small icon.
// Staleness: tests/kmp-logomark.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const FG = {
  default: "velta-kmp/composeApp/src/androidMain/res/drawable/ic_launcher_foreground.xml",
  badge: "velta-kmp/composeApp/src/androidMain/res/drawable/ic_launcher_badge_foreground.xml",
  classic: "velta-kmp/composeApp/src/androidMain/res/drawable/ic_launcher_classic_foreground.xml",
};
const MONO = {
  default: "velta-kmp/composeApp/src/androidMain/res/drawable/ic_launcher_monochrome.xml",
  badge: "velta-kmp/composeApp/src/androidMain/res/drawable/ic_launcher_badge_monochrome.xml",
  classic: "velta-kmp/composeApp/src/androidMain/res/drawable/ic_launcher_classic_monochrome.xml",
};
const KOTLIN_OUT = "velta-kmp/composeApp/src/commonMain/kotlin/org/velta/kmp/ui/VeltaLogomark.kt";
const NOTIFY_OUT = (v) => `velta-kmp/composeApp/src/androidMain/res/drawable/ic_notify_${v}.xml`;

// ---- XML walking -----------------------------------------------------------

const f = (n) => {
  const s = Number(n.toFixed(3)).toString();
  return s + (s.includes(".") || s.includes("e") ? "f" : ".0f");
};
const hex = (c) => `Color(0x${c.replace("#", "").toUpperCase()})`;
const attrs = (tag) => {
  const a = {};
  for (const m of tag.matchAll(/(?:android:)?([a-zA-Z]+)="([^"]*)"/g)) a[m[1]] = m[2];
  return a;
};

// One absolute-command path walk: yields [cmd, numbers[]] pairs.
// Asserts uppercase-only (all committed vectors are absolute).
function* commands(d) {
  const re = /([MLHVCAZ])([^MLHVCAZmlhvcaz]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const nums = m[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
    if (m[1] === "A") {
      if (nums.length % 7) throw new Error(`bad arc: ${d}`);
      for (let i = 0; i < nums.length; i += 7) yield ["A", nums.slice(i, i + 7)];
    } else {
      const need = { M: 2, L: 2, H: 1, V: 1, C: 6, Z: 0 }[m[1]];
      if (nums.length % need) throw new Error(`bad ${m[1]} arity: ${d}`);
      for (let i = 0; i < nums.length; i += need) yield [m[1], nums.slice(i, i + need)];
    }
  }
}

// Sequential tag scan carrying a group-transform stack (translate + scale,
// the only group attrs the committed vectors use — asserted below).
function parseVector(xml) {
  const stack = [{ tx: 0, ty: 0, sx: 1, sy: 1 }];
  const apply = (p) => {
    let { x, y } = p;
    for (let i = stack.length - 1; i >= 0; i--) {
      const g = stack[i];
      x = g.sx * x + g.tx;
      y = g.sy * y + g.ty;
    }
    return { x, y };
  };
  const paths = [];
  let pending = null;
  let grad = null;
  for (const tag of xml.match(/<[^>]+>/g) ?? []) {
    const closing = tag.startsWith("</");
    const selfClose = tag.endsWith("/>");
    const name = tag.match(/^<\/?([a-zA-Z:]+)/)?.[1];
    if (closing && name !== "group" && name !== "path") continue;
    if (name === "group") {
      if (closing) { stack.pop(); continue; }
      const a = attrs(tag);
      if (a.rotate || a.pivotX || a.pivotY) throw new Error("unhandled group attr: " + tag);
      stack.push({ tx: Number(a.translateX ?? 0), ty: Number(a.translateY ?? 0), sx: Number(a.scaleX ?? 1), sy: Number(a.scaleY ?? 1) });
    } else if (name === "path") {
      if (closing) {
        if (pending) { pending.gradient = grad; paths.push(pending); pending = grad = null; }
        continue;
      }
      const a = attrs(tag);
      if (a.strokeLineCap || a.strokeLineJoin || a.strokeAlpha || a.fillAlpha) throw new Error("unhandled path attr: " + tag);
      pending = {
        d: a.pathData,
        fill: a.fillColor ?? null,
        stroke: a.strokeColor ?? null,
        strokeWidth: a.strokeWidth ? Number(a.strokeWidth) : null,
        // Groups this path nests under (crop is added later, on top).
        groupDepth: stack.length - 1,
        groups: stack.slice(1).map((g) => ({ ...g })),
        gradient: null,
      };
      if (selfClose) { paths.push(pending); pending = null; }
    } else if (name === "gradient") {
      const a = attrs(tag);
      if (a.type !== "linear") throw new Error("unhandled gradient type: " + tag);
      grad = { startX: Number(a.startX), startY: Number(a.startY), endX: Number(a.endX), endY: Number(a.endY), items: [] };
    } else if (name === "item") {
      grad.items.push({ offset: Number(attrs(tag).offset), color: attrs(tag).color });
    }
  }
  return paths;
}

// Bounding box of transformed geometry; control points count (slight
// overshoot = padding, never clipping).
function bounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (p) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  };
  for (const path of paths) {
    const local = path.groups;
    for (const [cmd, n] of commands(path.d)) {
      const pts = [];
      if (cmd === "M" || cmd === "L") pts.push({ x: n[0], y: n[1] });
      else if (cmd === "H") pts.push({ x: n[0], y: 0 });
      else if (cmd === "V") pts.push({ x: 0, y: n[0] });
      else if (cmd === "C") for (let i = 0; i < 6; i += 2) pts.push({ x: n[i], y: n[i + 1] });
      else if (cmd === "A") pts.push({ x: n[5], y: n[6] });
      for (const p of pts) {
        let { x, y } = p;
        for (let i = local.length - 1; i >= 0; i--) {
          const g = local[i];
          x = g.sx * x + g.tx;
          y = g.sy * y + g.ty;
        }
        eat({ x, y });
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

// Square-ize with 4% pad so non-square glyphs never distort.
function squareView(b) {
  const pad = Math.max((b.maxX - b.minX), (b.maxY - b.minY)) * 0.02 + 6;
  const w = b.maxX - b.minX + 2 * pad, h = b.maxY - b.minY + 2 * pad;
  const side = Math.max(w, h);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return { left: cx - side / 2, top: cy - side / 2, size: side };
}

const KOTLIN_NAME = { default: "Default", badge: "Badge", classic: "Classic" };

function kotlinPath(path) {
  const lines = ["            addPath("];
  lines.push(`                pathData = addPathNodes(${JSON.stringify(path.d)}),`);
  if (path.gradient) {
    const g = path.gradient;
    const stops = g.items.map((i) => `${f(i.offset)} to ${hex(i.color)}`).join(", ");
    lines.push(`                fill = Brush.linearGradient(`);
    lines.push(`                    ${stops},`);
    lines.push(`                    start = Offset(${f(g.startX)}, ${f(g.startY)}), end = Offset(${f(g.endX)}, ${f(g.endY)}),`);
    lines.push(`                ),`);
  } else if (path.fill) {
    lines.push(`                fill = SolidColor(${hex(path.fill)}),`);
  }
  if (path.stroke) {
    lines.push(`                stroke = SolidColor(${hex(path.stroke)}),`);
    if (path.strokeWidth) lines.push(`                strokeLineWidth = ${f(path.strokeWidth)},`);
  }
  lines.push("            )");
  return lines.join("\n");
}

function kotlinVariant(variant, paths, view) {
  const out = [];
  out.push(`private fun build${KOTLIN_NAME[variant]}Logomark(): ImageVector {`);
  out.push(`    val b = ImageVector.Builder(`);
  out.push(`        name = "VeltaLogomark${KOTLIN_NAME[variant]}",`);
  out.push(`        defaultWidth = 48.dp, defaultHeight = 48.dp,`);
  out.push(`        viewportWidth = ${f(view.size)}, viewportHeight = ${f(view.size)},`);
  out.push(`    )`);
  out.push(`    b.addGroup(translationX = ${f(-view.left)}, translationY = ${f(-view.top)}) {`);
  for (const p of paths) {
    const ind = "        " + "    ".repeat(p.groups.length);
    if (p.groups.length === 0) {
      out.push(kotlinPath(p));
    } else {
      const chain = [];
      let close = "";
      for (const g of p.groups) {
        const gi = "        " + "    ".repeat(chain.length);
        chain.push(`${gi}addGroup(translationX = ${f(g.tx)}, translationY = ${f(g.ty)}, scaleX = ${f(g.sx)}, scaleY = ${f(g.sy)}) {`);
        close = `${gi}}` + (close ? "\n" + close : "");
      }
      chain.push(kotlinPath(p).replace(/^ {12}/gm, ind));
      chain.push(close);
      out.push(chain.join("\n"));
    }
  }
  out.push(`    }`);
  out.push(`    return b.build()`);
  out.push(`}`);
  return out.join("\n");
}

function notifyXml(paths, view) {
  const body = paths.map((p) => {
    const attrsStr = [
      `android:pathData="${p.d}"`,
      `android:fillColor="#FFFFFFFF"`,
    ].join(" ");
    if (p.groups.length === 0) return `    <path ${attrsStr}/>`;
    const opens = p.groups.map((g) => {
      const scale = g.sx !== 1 ? ` android:scaleX="${g.sx}" android:scaleY="${g.sy}"` : "";
      return `    <group android:translateX="${g.tx}" android:translateY="${g.ty}"${scale}>`;
    });
    const closes = p.groups.map((_, i) => `    ${"    ".repeat(i)}</group>`).reverse().join("\n");
    return [...opens, `        <path ${attrsStr}/>`, closes].join("\n");
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by tools/gen-kmp-logomark.mjs from the monochrome launcher vector — do not edit; run the generator. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="${view.size.toFixed(3)}" android:viewportHeight="${view.size.toFixed(3)}">
    <group android:translateX="${(-view.left).toFixed(3)}" android:translateY="${(-view.top).toFixed(3)}">
${body}
    </group>
</vector>
`;
}

// ---- Emit ------------------------------------------------------------------

const parsed = {};
for (const v of Object.keys(FG)) {
  parsed[v] = {
    fg: parseVector(readFileSync(new URL(FG[v], ROOT), "utf8")),
    mono: parseVector(readFileSync(new URL(MONO[v], ROOT), "utf8")),
  };
  if (parsed[v].mono.some((p) => p.stroke || p.gradient)) throw new Error("monochrome must be flat white");
}

const views = {};
for (const v of Object.keys(FG)) views[v] = squareView(bounds(parsed[v].mono));

const kotlin = `// Generated by tools/gen-kmp-logomark.mjs from the launcher foreground /
// monochrome vectors (androidMain/res/drawable) — do not edit by hand;
// run \`node tools/gen-kmp-logomark.mjs\` to regenerate.
package org.velta.kmp.ui

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp

private val DefaultLogomark by lazy { buildDefaultLogomark() }
private val BadgeLogomark by lazy { buildBadgeLogomark() }
private val ClassicLogomark by lazy { buildClassicLogomark() }

/** The chosen icon's glyph for in-app surfaces (header, welcome). */
val AppIconChoice.logomark: ImageVector
    get() = when (this) {
        AppIconChoice.Default -> DefaultLogomark
        AppIconChoice.Badge -> BadgeLogomark
        AppIconChoice.Classic -> ClassicLogomark
    }

/** The Velta mark rendered for the picked app icon (header, welcome screen). */
@Composable
fun VeltaLogomark(choice: AppIconChoice, modifier: Modifier = Modifier, contentDescription: String? = null) {
    Image(
        imageVector = choice.logomark,
        contentDescription = contentDescription,
        modifier = modifier,
        contentScale = ContentScale.Fit,
    )
}

${Object.keys(FG).map((v) => kotlinVariant(v, parsed[v].fg, views[v])).join("\n\n")}
`;

const xmls = Object.fromEntries(Object.keys(MONO).map((v) => [NOTIFY_OUT(v), notifyXml(parsed[v].mono, views[v])]));

function generateKmpLogomark() {
  return { kotlin, xmls };
}

const NO_WRITE = process.env.VELTA_GEN_NO_WRITE === "1";
if (!NO_WRITE) {
  writeFileSync(new URL(KOTLIN_OUT, ROOT), kotlin);
  for (const [path, content] of Object.entries(xmls)) writeFileSync(new URL(path, ROOT), content);
  console.log(`wrote ${KOTLIN_OUT} + ${Object.keys(xmls).length} ic_notify_*.xml`);
}

export { generateKmpLogomark, KOTLIN_OUT };
