#!/usr/bin/env node
// gen-design-tokens.mjs — the design reference's single source of truth (#182).
// Reads the three theme blocks of app/css/main.css and writes
// docs/design-tokens.html: swatch cards for every color token (with curated
// descriptions and inherited flags) plus the WCAG pair table with COMPUTED
// ratios — the hand-measured table drifted (green "4.8" is really 5.51).
// The website's /design/ page embeds this fragment between GENERATED markers;
// tests/design-tokens-doc.test.mjs re-runs this file and fails when the
// committed fragment is stale, so a token change cannot land without the
// reference following.
// Stamp: the commit of app/css/main.css itself (git log -1 -- app/css/main.css)
// — stable until the CSS changes, so the file is not self-referential.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT_URL = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT_URL), "utf8");

// ---------- parse the theme blocks ----------
function parseBlock(css, header) {
  const i = css.indexOf(header);
  if (i < 0) throw new Error(`block not found: ${header}`);
  const end = css.indexOf("\n}", i);
  const body = css.slice(i, end);
  const tokens = {};
  for (const m of body.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) tokens[m[1]] = m[2].trim();
  return tokens;
}
const css = read("app/css/main.css");
const themes = {
  dark: parseBlock(css, ":root {"),
  light: parseBlock(css, 'html[data-theme="light"] {'),
  brutal: parseBlock(css, 'html[data-theme="brutal"] {'),
};

// Resolve one level of var() within a theme (dark as fallback), for contrast math.
function resolve(theme, name) {
  const v = themes[theme][name] ?? themes.dark[name] ?? "";
  const m = /^var\(--([\w-]+)\)$/.exec(v);
  return m ? resolve(theme, m[1]) : v;
}

// ---------- curated metadata ----------
// Card order (curated: surfaces → accent → text → status → structure → call).
const ORDER = [
  "bg", "bg-sidebar", "bg-chat", "bg-hover", "bg-active", "selection-bg", "bg-bubble-in", "bg-bubble-out", "bg-reply",
  "accent", "accent-2", "accent-tint", "accent-hover", "accent-active", "on-accent", "accent-text", "accent-text-in",
  "focus-ring", "accent-default", "on-accent-chip", "on-badge",
  "text", "text-dim", "text-meta-in", "text-meta-out", "out-link", "ticks-read", "quote-name", "quote-name-out",
  "green", "danger", "border", "shadow", "bg-elev",
  "radius-bubble", "head-h", "list-bar-h", "font-mono",
  "call-bg", "call-fg", "call-fg-dim", "call-video-fg", "call-scrim", "call-btn", "call-btn-on", "call-btn-on-fg",
  "call-danger", "call-danger-fg", "call-accept", "call-accept-fg", "call-avatar-bg", "call-avatar-fg",
  "call-pip-bg", "call-btn-size",
];
const DESC = {
  "bg": "app canvas", "bg-sidebar": "list + drawer", "bg-chat": "chat pane canvas", "bg-hover": "hover overlay — surfaces only, never text",
  "bg-active": "pressed/active fill", "selection-bg": "selected-chat fill — its own token, independent of the outgoing bubble (#182)",
  "bg-bubble-in": "incoming bubble", "bg-bubble-out": "outgoing bubble", "bg-reply": "quote/reply strip",
  "accent": "actions and links", "accent-2": "p2p + local chat", "accent-tint": "translucent selection/pressed fills — per theme",
  "accent-hover": "accent fill hover", "accent-active": "accent fill pressed", "on-accent": "ink on accent fills",
  "accent-text": "accent UI text — AA on app surfaces; raw --accent never for normal text in light",
  "accent-text-in": "accent text on incoming bubbles", "focus-ring": "keyboard focus outline — one ring color per theme (#182)",
  "accent-default": "theme accent for the default swatch", "on-accent-chip": "ink on accent chips", "on-badge": "unread badge ink",
  "text": "body ink", "text-dim": "secondary ink", "text-meta-in": "timestamps, incoming", "text-meta-out": "timestamps, outgoing",
  "out-link": "links on the outgoing bubble", "ticks-read": "read receipt ticks", "quote-name": "quote sender, incoming",
  "quote-name-out": "quote sender, outgoing", "green": "presence/verified — status, never accent", "danger": "destructive",
  "border": "hairlines", "bg-elev": "raised placeholder tiles",
  "radius-bubble": "bubble corner — only per-theme radius token", "head-h": "sidebar + chat header (+ safe area)",
  "list-bar-h": "bottom bar (+ safe area)", "font-mono": "monospace stack — device info, logs",
  "call-bg": "call screen canvas", "call-fg": "call screen ink", "call-fg-dim": "call screen secondary",
  "call-video-fg": "ink over live video", "call-scrim": "controls scrim over video", "call-btn": "call control fill",
  "call-btn-on": "toggled-on call control fill", "call-btn-on-fg": "ink on toggled-on control", "call-danger": "decline / leave",
  "call-danger-fg": "ink on danger control", "call-accept": "accept", "call-accept-fg": "ink on accept control",
  "call-avatar-bg": "caller avatar fill", "call-avatar-fg": "caller avatar ink", "call-pip-bg": "self-view tile",
  "call-btn-size": "call control diameter",
};
// Special swatch markup overrides (border/shadow/non-color tokens).
const SWATCH = {
  "border": (v) => `<div class="swatch" style="background:#181820;border-color:rgba(244,244,244,.4)"><div class="swatch" style="height:20px;background:${v}"></div></div>`,
  "shadow": (v) => `<div class="swatch" style="background:var(--panel-2);box-shadow:${v}"></div>`,
};

// ---------- WCAG ----------
function lum(hex) {
  const n = parseInt(hex.slice(1), 16), c = [n >> 16 & 255, n >> 8 & 255, n & 255]
    .map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const grade = (r) => r >= 7 ? ["AAA", "ok"] : r >= 4.5 ? ["AA", "ok"] : r >= 3 ? ["AA large/UI", "warn"] : ["fail", "off"];
// Pairs: [label, theme, fg token, bg token]
const PAIRS = [
  ["Dark: --text on --bg", "dark", "text", "bg"],
  ["Dark: --accent on --bg", "dark", "accent", "bg"],
  ["Dark: --text on outgoing bubble", "dark", "text", "bg-bubble-out"],
  ["Dark: --text-dim on --bg", "dark", "text-dim", "bg"],
  ["Dark: --text-meta-in on incoming bubble", "dark", "text-meta-in", "bg-bubble-in"],
  ["Dark: --text-meta-out on outgoing bubble", "dark", "text-meta-out", "bg-bubble-out"],
  ["Light: --text on --bg", "light", "text", "bg"],
  ["Light: --text on outgoing bubble", "light", "text", "bg-bubble-out"],
  ["Light: --text-dim on --bg", "light", "text-dim", "bg"],
  ["Light: --accent-text on --bg", "light", "accent-text", "bg"],
  ["Light: --accent on --bg", "light", "accent", "bg"],
  ["Light: --green on --bg", "light", "green", "bg"],
  ["Light: --danger on --bg", "light", "danger", "bg"],
  ["Light: --accent-2 on --bg", "light", "accent-2", "bg"],
];

// ---------- emit ----------
function card(themeKey, suffix, name) {
  const t = themes[themeKey];
  const inherited = !(name in t) && name in themes.dark;
  const raw = (t[name] ?? themes.dark[name]) || "";
  const id = `--${name}${suffix}`;
  const desc = DESC[name] ? ` — ${DESC[name]}` : "";
  const swatch = SWATCH[name] ? SWATCH[name](raw) : `<div class="swatch" style="background:${raw}"></div>`;
  const note = inherited ? `<div class="inh">inherited from dark</div>` : "";
  return `<div class="card" id="${id}">${swatch}<div class="tok"><span class="name">--${name}</span> <span class="val">${raw}${desc}</span></div>${note}</div>`;
}
function panel(themeKey, suffix, title) {
  const names = [...ORDER, ...Object.keys(themes[themeKey]).filter(n => !ORDER.includes(n))];
  const cards = names.map(n => (themes[themeKey][n] || themes.dark[n] ? card(themeKey, suffix, n) : "")).join("\n      ");
  return `    <div class="panel">\n      <h3>${title}</h3>\n      ${cards}\n    </div>`;
}

const tableRows = PAIRS.map(([label, theme, fg, bg]) => {
  const r = ratio(resolve(theme, fg), resolve(theme, bg));
  const [g, cls] = grade(r);
  return `    <tr><td>${label}</td><td class="mono">${r.toFixed(2)}</td><td class="${cls}">${g}</td></tr>`;
}).join("\n");

let sha = "unknown";
try { sha = execSync("git log -1 --format=%h -- app/css/main.css", { cwd: fileURLToPath(new URL("..", import.meta.url)) }).toString().trim(); } catch {}
const version = JSON.parse(read("velta-app/src-tauri/tauri.conf.json")).version;

const out = `<!-- GENERATED by tools/gen-design-tokens.mjs — do not hand-edit.
     Source: app/css/main.css @ ${sha} · v${version}. Regenerate: node tools/gen-design-tokens.mjs;
     tests/design-tokens-doc.test.mjs fails when this file is stale. -->
<!-- GENERATED:START -->
    <div class="panel">
      <h3>Dark (primary)</h3>
      ${panel("dark", "", "Dark (primary)").split("\n").slice(2).join("\n")}
    </div>

    <div class="panel">
      <h3 id="colors-light">Light</h3>
      ${panel("light", "-light", "Light").split("\n").slice(2).join("\n")}
    </div>

    <div class="panel">
      <h3 id="colors-brutal">Brutal (neobrutalist, dark only)</h3>
      ${panel("brutal", "-brutal", "Brutal (neobrutalist, dark only)").split("\n").slice(2).join("\n")}
    </div>
<!-- GENERATED:END -->

    <p class="legend">Pair table — computed from the tokens above (WCAG 2.x), not hand-measured:</p>
    <table>
    <tr><th>Pair</th><th>Ratio</th><th>Grade</th></tr>
${tableRows}
    </table>
<!-- GENERATED-TABLE:END -->
`;

// Exported for tests/design-tokens-doc.test.mjs (which compares against the
// committed file without writing). The CLI run writes; set VELTA_GEN_NO_WRITE
// to import without the side effect.
export function generateDesignTokens() { return out; }
if (!process.env.VELTA_GEN_NO_WRITE) {
  writeFileSync(new URL("docs/design-tokens.html", ROOT_URL), out);
  console.log(`wrote docs/design-tokens.html · main.css @ ${sha} · v${version}`);
}
