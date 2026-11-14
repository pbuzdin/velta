#!/usr/bin/env node
// gen-kmp-theme.mjs — Velta KMP's Compose theme tokens from app/css/main.css (#318).
// Reads the dark (:root), light, brutal and AMOLED blocks of the stable
// stylesheet and writes velta-kmp/.../ui/VeltaTokens.kt: one VeltaTokens
// value per theme (colors with alpha, var() resolved per theme, radii) plus
// VeltaType (message/list text sizes read from the matching CSS rules).
// tests/kmp-theme-tokens.test.mjs re-runs this file and fails when the
// committed Kotlin file is stale, so a token change in main.css cannot land
// without KMP following. Regenerate: node tools/gen-kmp-theme.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT_URL = new URL("../", import.meta.url);
const OUT = "velta-kmp/composeApp/src/commonMain/kotlin/org/velta/kmp/ui/VeltaTokens.kt";
const css = readFileSync(new URL("app/css/main.css", ROOT_URL), "utf8");

// ---------- parse ----------
function blockBody(header) {
  const i = css.indexOf(header);
  if (i < 0) throw new Error(`block not found: ${header}`);
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}
function parseVars(body) {
  const out = {};
  // Strip comments first: a ";" inside a comment would split a declaration.
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const dark = parseVars(blockBody(":root {"));
const THEMES = {
  Dark: { isDark: true, vars: dark },
  Light: { isDark: false, vars: { ...dark, ...parseVars(blockBody('html[data-theme="light"] {')) } },
  Brutal: { isDark: true, vars: { ...dark, ...parseVars(blockBody('html[data-theme="brutal"] {')) } },
  // AMOLED (#277) is dark with pure-black page and chat grounds.
  Amoled: { isDark: true, vars: { ...dark, ...parseVars(blockBody('html[data-theme="dark"][data-amoled] {')) } },
};

function resolve(vars, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`var() cycle at --${name}`);
  seen.add(name);
  const v = vars[name];
  if (v == null) throw new Error(`--${name} undefined`);
  const m = /^var\(--([\w-]+)\)$/.exec(v);
  return m ? resolve(vars, m[1], seen) : v;
}

const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0").toUpperCase();
function kColor(v, where) {
  let r, g, b, a = 1;
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(v))) [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
  else if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v))) {
    [r, g, b] = [0, 2, 4].map((o) => parseInt(m[1].slice(o, o + 2), 16));
    if (m[2]) a = parseInt(m[2], 16) / 255;
  } else if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/.exec(v))) {
    [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (m[4] != null) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : Number(m[4]);
  } else throw new Error(`${where}: not a plain color: ${v}`);
  return `Color(0x${hex2(a * 255)}${hex2(r)}${hex2(g)}${hex2(b)})`;
}
function kDp(v, where) {
  // calc(64px + env(safe-area-inset-bottom)): the safe area is Compose's
  // WindowInsets job, so only the px part is a token.
  const m = /^(?:calc\(\s*)?([\d.]+)px\b/.exec(v);
  if (!m) throw new Error(`${where}: not a px length: ${v}`);
  return `${Number(m[1])}.dp`.replace(/^(\d+)\.dp$/, "$1.dp");
}

// ---------- token map: Kotlin name -> CSS var ----------
// Colors with plain values (hex / rgb / rgba, after var() resolution).
// color-mix() tokens (accent-hover/-active, call-*) are not mapped: Compose
// derives pressed/hover states itself.
const COLORS = [
  ["bg", "bg", "app canvas"],
  ["bgSidebar", "bg-sidebar", "chat list, drawer, headers"],
  ["bgChat", "bg-chat", "chat pane canvas"],
  ["bgHover", "bg-hover", "hover overlay — surfaces only"],
  ["bgActive", "bg-active", "pressed/active fill"],
  ["selectionBg", "selection-bg", "selected-chat fill"],
  ["bgBubbleIn", "bg-bubble-in", "incoming bubble"],
  ["bgBubbleOut", "bg-bubble-out", "outgoing bubble"],
  ["bgReply", "bg-reply", "quote/reply strip"],
  ["bgElev", "bg-elev", "raised placeholder tiles"],
  ["accent", "accent", "actions and links"],
  ["accent2", "accent-2", "p2p + local chat"],
  ["accentText", "accent-text", "accent UI text on app surfaces"],
  ["accentTextIn", "accent-text-in", "accent text on incoming bubbles"],
  ["onAccent", "on-accent", "ink on accent fills"],
  ["onAccentChip", "on-accent-chip", "ink on active category chips"],
  ["onBadge", "on-badge", "unread badge ink"],
  ["onBadgeMuted", "on-badge-muted", "muted unread badge ink"],
  ["focusRing", "focus-ring", "keyboard focus outline"],
  ["text", "text", "body ink"],
  ["textDim", "text-dim", "secondary ink"],
  ["textMetaIn", "text-meta-in", "timestamps, incoming"],
  ["textMetaOut", "text-meta-out", "timestamps, outgoing"],
  ["outLink", "out-link", "links on the outgoing bubble"],
  ["ticksRead", "ticks-read", "read receipt ticks"],
  ["quoteName", "quote-name", "quote sender, incoming"],
  ["quoteNameOut", "quote-name-out", "quote sender, outgoing"],
  ["green", "green", "presence/verified — status, never accent"],
  ["danger", "danger", "destructive"],
  ["border", "border", "hairlines"],
];
// Ink on the outgoing bubble: --text everywhere except brutal, whose yellow
// bubble takes --nb-main-ink (main.css `.msg-row.out .bubble .msg-text`).
const textOut = (vars) => resolve(vars, vars["nb-main-ink"] ? "nb-main-ink" : "text");
const DIMENS = [
  ["radiusBubble", "radius-bubble", "bubble corner"],
  ["radiusTail", "radius-tail", "bubble tail corner"],
  ["radiusQuote", "radius-quote", "quote block corner"],
  ["radiusMedia", "radius-media", "media corner inside a bubble"],
  ["headH", "head-h", "chat list + chat header height (without safe area)"],
  ["listBarH", "list-bar-h", "bottom bar height (without safe area)"],
  ["ico1", "ico-1", "icon: inline/meta"],
  ["ico2", "ico-2", "icon: small ui"],
  ["ico3", "ico-3", "icon: rows/buttons"],
  ["ico4", "ico-4", "icon: bars"],
  ["ico5", "ico-5", "icon: composer"],
];

// ---------- type sizes from the rules that use them ----------
function ruleDecl(selector, prop) {
  const i = css.indexOf(`\n${selector} {`);
  if (i < 0) throw new Error(`rule not found: ${selector}`);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`).exec(body);
  if (!m) throw new Error(`${selector} has no ${prop}`);
  return m[1].trim();
}
const msgPx = Number(/^([\d.]+)px$/.exec(dark["msg-font-size"])[1]);
function sizeSp(v, where) {
  // px, var(--msg-font-size) or calc(var(--msg-font-size) * k)
  let m;
  if ((m = /^([\d.]+)px$/.exec(v))) return Number(m[1]);
  if (v === "var(--msg-font-size)") return msgPx;
  if ((m = /^calc\(var\(--msg-font-size\)\s*\*\s*([\d.]+)\)$/.exec(v))) return Math.round(msgPx * Number(m[1]) * 2) / 2;
  throw new Error(`${where}: unsupported font-size ${v}`);
}
const sp = (n) => `${n}.sp`.replace(/^(\d+)\.sp$/, "$1.sp");
const TYPE = [
  ["msg", ".msg-text", "message body"],
  ["msgMeta", ".msg-meta", "time + ticks in a bubble"],
  ["listName", ".ci-name", "chat list row title (semibold)"],
  ["listLast", ".ci-last", "chat list row preview"],
  ["listTime", ".ci-time", "chat list row time"],
];
const typeLines = TYPE.map(([k, sel, d]) => `    /** ${d} — main.css \`${sel}\` */\n    val ${k}Size = ${sp(sizeSp(ruleDecl(sel, "font-size"), sel))}`);
const lh = Number(ruleDecl(".msg-text", "line-height"));
const nameWeight = Number(ruleDecl(".ci-name", "font-weight"));

// ---------- emit ----------
const fields = [
  ...COLORS.map(([k, , d]) => `    /** ${d} */\n    val ${k}: Color,`),
  `    /** ink on the outgoing bubble (brutal: --nb-main-ink) */\n    val textOut: Color,`,
  ...DIMENS.map(([k, , d]) => `    /** ${d} */\n    val ${k}: Dp,`),
];
const values = (name, { isDark, vars }) => {
  const lines = [`        isDark = ${isDark},`];
  for (const [k, v] of COLORS) lines.push(`        ${k} = ${kColor(resolve(vars, v), `${name} --${v}`)}, // ${vars[v]}`);
  lines.push(`        textOut = ${kColor(textOut(vars), `${name} textOut`)},`);
  for (const [k, v] of DIMENS) lines.push(`        ${k} = ${kDp(resolve(vars, v), `${name} --${v}`)},`);
  return `    val ${name} = VeltaTokens(\n${lines.join("\n")}\n    )`;
};
const cssHash = createHash("sha256").update(css).digest("hex").slice(0, 8);

const out = `// GENERATED by tools/gen-kmp-theme.mjs from app/css/main.css#${cssHash} — do not hand-edit.
// Regenerate: node tools/gen-kmp-theme.mjs (tests/kmp-theme-tokens.test.mjs fails when stale).
package org.velta.kmp.ui

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One Velta theme's design tokens, mirroring the CSS custom properties. */
@Immutable
data class VeltaTokens(
    val isDark: Boolean,
${fields.join("\n")}
)

/** The four stable themes: dark (:root), light, brutal, AMOLED (dark + pure black). */
object VeltaTokenSets {
${Object.entries(THEMES).map(([n, t]) => values(n, t)).join("\n\n")}
}

/** Text sizes, theme-independent (main.css defaults, --msg-font-size ${msgPx}px). */
object VeltaType {
${typeLines.join("\n")}
    /** message line-height multiplier — main.css \`.msg-text\` */
    const val msgLineHeight = ${lh}f
    /** chat list title weight — main.css \`.ci-name\` */
    const val listNameWeight = ${nameWeight}
}
`;

export function generateKmpTheme() { return out; }
export const KMP_THEME_PATH = OUT;
if (!process.env.VELTA_GEN_NO_WRITE) {
  writeFileSync(new URL(OUT, ROOT_URL), out);
  console.log(`wrote ${OUT} · main.css#${cssHash}`);
}
