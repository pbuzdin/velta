#!/usr/bin/env node
// gen-design-components.mjs — the /design/components preview's source of
// truth (#182 phase 2). Reads app/css/main.css, extracts the REAL component
// rules (buttons, icon button, tabs, menu items, chips, text field, modal,
// message links) plus the three theme token blocks, and emits
// docs/design-components.html: a <style> block scoped under `.vc` with
// themes on `.vc[data-vt=…]`, and static demo sections per component/state.
//
// States render side by side without a pointer: every extracted :hover /
// :active / :focus(-visible) rule also emits a parallel class-forced rule
// (.is-hover / .is-pressed / .is-focus) the demo markup applies. Disabled
// uses the real [disabled] attribute. Media-query-wrapped hover rules are
// unwrapped so forced states render on touch too.
//
// The website's /design/components page embeds this file between GENERATED
// markers; tests/design-components-doc.test.mjs fails when it is stale.
// Stamp cites app/css/main.css's own last commit (stable between CSS edits).
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_URL = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT_URL), "utf8");
const css = read("app/css/main.css");

// ---------- parse all rules (selector -> declarations), flat ----------
const rules = [];
{
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const sel = css.slice(i, brace).trim();
    if (sel.startsWith("/*")) { i = css.indexOf("*/", i) + 2; continue; }
    if (sel.startsWith("@media")) {
      // unwrap single-level media blocks we care about (hover guards)
      const innerStart = brace + 1;
      const firstEnd = css.indexOf("}", innerStart);
      const end = css.indexOf("}", firstEnd + 1); // the media block's own close
      const inner = css.slice(innerStart, firstEnd + 1); // include the rule's own closing brace
      const m2 = inner.match(/([^{}]+)\{([^{}]*)\}/);
      if (m2) rules.push({ sel: m2[1].trim(), body: m2[2].trim(), media: sel });
      i = end + 1;
      continue;
    }
    if (sel.startsWith("@")) { // keyframes etc — skip whole block
      let depth = 1, j = brace + 1;
      while (depth && j < css.length) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
      if (sel.startsWith("@keyframes modalIn")) rules.push({ sel, body: css.slice(brace + 1, j - 1), keyframes: true });
      i = j;
      continue;
    }
    const end = css.indexOf("}", brace);
    rules.push({ sel: sel.replace(/\s+/g, " "), body: css.slice(brace + 1, end).trim() });
    i = end + 1;
  }
}

// ---------- curation ----------
const INCLUDE = /(^|[,\s])(\.btn-primary|\.btn-text|\.icon-btn|\.chat-cats|\.ctx-item|\.text-field|\.relay-flag|\.day-chip|\.modal|button|input, textarea|\.msg-text a|\.msg-actions)(?=$|[,\s:.[{])/;
const EXCLUDE = /lang-card|ivc|pm-pane|msg-emoji-tray|qr-view|side-view|sched|tunnel|gcb|transfer|md-note|ep-avatar|edit-profile|pair-request|ob-steps|invite|msg-del-confirm|composer|share|lc-|xfer|onboard|cale|verify|qr|sticker|relay-(legend|card|line|detail|actions|row)|archived-link|thread|bubble|chat-item|chat-list|msg-bar|drawer|toasts|call-|member|eph|info-row|hashtag|msg-code|menu-open|acct-pop|boot-error|attach-sub|app-browser|btn-group|load-error|media-preview|mirror-add|modal-field|modal-body|modal-foot|modal-compact|msg-fail-actions|msg-groupcall|msg-row|pm-actions|profile-actions|ps-lock-actions|sidebar-head|backup-|reaction-chip|msg-tile/;
const picked = rules.filter(r => !r.keyframes && INCLUDE.test(r.sel) && !EXCLUDE.test(r.sel));
const modalKF = rules.find(r => r.keyframes);

// ---------- selector transforms ----------
const prefixPart = (part) =>
  part
    .replace(/^html\[data-theme="brutal"\]/, `.vc[data-vt="brutal"]`)
    .replace(/^html\[data-theme="light"\]/, `.vc[data-vt="light"]`)
    .replace(/^(?=\.|button\b|input\b|textarea\b|a\b)/, ".vc ");
const prefixSel = (sel) => sel.split(",").map(p => prefixPart(p.trim())).join(", ");
const forceSel = (sel) => {
  const out = [];
  if (/:hover(?!\()/.test(sel)) out.push([sel.replace(/:hover/g, ".is-hover"), "is-hover"]);
  if (/:active/.test(sel)) out.push([sel.replace(/:active/g, ".is-pressed"), "is-pressed"]);
  if (/:focus(-visible)?\b/.test(sel)) out.push([sel.replace(/:focus(-visible)?\b/g, ".is-focus"), "is-focus"]);
  return out;
};

let styleOut = "";
// theme tokens scoped to the demo wrapper
for (const [header, attr] of [[":root {", ""], ['html[data-theme="light"] {', 'light'], ['html[data-theme="brutal"] {', "brutal"]]) {
  const i = css.indexOf(header);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("\n}", i));
  styleOut += attr ? `.vc[data-vt="${attr}"] {${body}}\n` : `.vc {${body}}\n`;
}
if (modalKF) styleOut += `.vc @keyframes modalIn {${modalKF.body}}\n`.replace(".vc @keyframes", "@keyframes");

const seen = new Set();
for (const r of picked) {
  if (seen.has(r.sel)) continue;
  seen.add(r.sel);
  const s = prefixSel(r.sel);
  styleOut += `${s} { ${r.body} }\n`;
  for (const [f] of forceSel(r.sel)) styleOut += `${prefixSel(f)} { ${r.body} }\n`;
}

// ---------- demo markup ----------
const fig = (cls, inner, label) =>
  `<figure class="vd-fig"><div class="vd-cell${cls ? " " + cls : ""}">${inner}</div><figcaption>${label}</figcaption></figure>`;

const sections = [];

sections.push({ id: "button-primary", title: "Button — primary", contract: "The one filled accent action per view (.btn-primary on a .btn-text base): accent fill, --on-accent ink. One per dialog foot or screen; never in lists.", rows: [
  fig("", `<button class="btn-text btn-primary" type="button">Save profile</button>`, "default"),
  fig("f-hover", `<button class="btn-text btn-primary is-hover" type="button">Save profile</button>`, "hover <code>--accent-hover</code>"),
  fig("f-pressed", `<button class="btn-text btn-primary is-pressed" type="button">Save profile</button>`, "pressed <code>--accent-active</code>"),
  fig("f-focus", `<button class="btn-text btn-primary is-focus" type="button">Save profile</button>`, "focus-visible <code>--focus-ring</code>"),
  fig("", `<button class="btn-text btn-primary" type="button" disabled>Save profile</button>`, "disabled"),
]});

sections.push({ id: "button-text", title: "Button — text (tertiary)", contract: "Compact accent-text action for rows, footers, secondary choices (.btn-text). It is a BUTTON, not a link — never inline inside a sentence. No hover state by design: hover changes surfaces, never text.", rows: [
  fig("", `<button class="btn-text" type="button">Retry</button>`, "default"),
  fig("f-focus", `<button class="btn-text is-focus" type="button">Retry</button>`, "focus-visible"),
  fig("", `<button class="btn-text" type="button" style="color:var(--danger)">Remove</button>`, "destructive — --danger ink, no red fill"),
]});

sections.push({ id: "icon-button", title: "Icon button", contract: "40px round, svg 20–22, 50% radius; aria-label required. Hover tints the surface; no dedicated focus rule exists yet in main.css — a known gap this page documents (#182).", rows: [
  fig("", `<button class="icon-btn" type="button" aria-label="Search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></button>`, "default"),
  fig("f-hover", `<button class="icon-btn is-hover" type="button" aria-label="Search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></button>`, "hover <code>--bg-hover</code>"),
]});

sections.push({ id: "tabs", title: "Tabs — category chips", contract: "Equal-width chips (.chat-cats); active = accent fill + --on-accent-chip; a disabled category hides its chip entirely, it never greys out.", rows: [
  fig("", `<div class="chat-cats" style="padding:2px 0"><button type="button">All</button><button type="button">Unread</button><button type="button" class="active">Groups</button><button type="button">Bots</button></div>`, "default · selected"),
  fig("f-hover", `<div class="chat-cats" style="padding:2px 0"><button type="button">All</button><button type="button" class="is-hover">Unread</button><button type="button" class="active">Groups</button><button type="button">Bots</button></div>`, "hover (non-active)"),
]});

sections.push({ id: "menu-item", title: "Menu item", contract: "Row menu entry (.ctx-item inside .msg-actions): icon + label; hover and pressed tint the surface; destructive entries take --danger ink; focus-visible 2px --focus-ring.", rows: [
  fig("", `<div class="msg-actions"><button class="ctx-item" type="button"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 19a8 8 0 1 1 8-8v1a3 3 0 0 1-6 0V10"/><path d="M8 12h.01"/></svg>Reply</button><button class="ctx-item danger" type="button">Delete</button></div>`, "default · destructive"),
  fig("f-hover", `<div class="msg-actions"><button class="ctx-item is-hover" type="button">Reply</button></div>`, "hover"),
  fig("f-pressed", `<div class="msg-actions"><button class="ctx-item is-pressed" type="button">Reply</button></div>`, "pressed"),
  fig("f-focus", `<div class="msg-actions"><button class="ctx-item is-focus" type="button">Reply</button></div>`, "focus-visible"),
]});

sections.push({ id: "chip", title: "Chip — relay capability flag", contract: "Passive metadata pill (.relay-flag); letters with a green corner dot when the relay advertises the capability. Status chips use their status token, never accent.", rows: [
  fig("", `<span class="relay-flag" title="calls (TURN)">C</span> <span class="relay-flag on" title="offered">I</span> <span class="relay-flag on" title="offered">W</span>`, "off · offered"),
]});

sections.push({ id: "day-chip", title: "Day chip", contract: "Sticky date divider between message groups; opaque fill (blur is a scroll-frame cost on Android), theme-specific ink measured in the comment block.", rows: [
  fig("", `<div class="day-chip"><span>Today</span></div>`, "default"),
]});

sections.push({ id: "text-field", title: "Text field", contract: "Full-width, 12/14px padding, 10px radius, --bg-hover fill; focus recolors the border to accent. The placeholder is a hint, not a label — label above or aria-label.", rows: [
  fig("", `<input class="text-field" type="text" placeholder="Group name" aria-label="Group name">`, "default"),
  fig("f-focus", `<input class="text-field is-focus" type="text" placeholder="Group name" aria-label="Group name">`, "focus"),
]});

sections.push({ id: "dialog", title: "Dialog", contract: "Bottom sheet on phones, centered card on desktop (.modal): one primary action in the foot, cancel as .btn-text. History-back integration follows the modalHistorySettled contract. Static demo — the real sheet animates in and docks.", rows: [
  fig("", `<div class="modal" style="position:static;animation:none;width:100%"><div style="padding:16px 18px 8px"><h3 style="font-size:17px;margin-bottom:6px">Remove relay?</h3><p style="font-size:14px;color:var(--text-dim)">The relay stops being used right away and your contacts are informed automatically.</p></div><div style="display:flex;gap:8px;padding:12px 18px 16px"><button class="btn-text" type="button">Cancel</button><button class="btn-text btn-primary" type="button" style="width:auto;padding:10px 22px">Remove</button></div></div>`, "card · foot buttons"),
]});

sections.push({ id: "link", title: "Link", contract: "Navigation, underlined. In message bodies links are accent-colored with underline; on app surfaces accent-colored UI text reads --accent-text (AA in every theme).", rows: [
  fig("", `<div class="msg-text">See the <a href="#">spec</a> — it covers the wire format.</div>`, "in message body"),
]});

let demoOut = "";
for (const s of sections) {
  demoOut += `<section class="vdemo" id="${s.id}">\n<h3>${s.title}</h3>\n<p class="vd-contract">${s.contract}</p>\n<div class="vd-row">${s.rows.join("")}</div>\n</section>\n`;
}

// ---------- stamp + write ----------
let sha = "unknown";
try { sha = execSync("git log -1 --format=%h -- app/css/main.css", { cwd: fileURLToPath(ROOT_URL) }).toString().trim(); } catch {}
const version = JSON.parse(read("velta-app/src-tauri/tauri.conf.json")).version;

export function generateDesignComponents() {
  return `<!-- GENERATED by tools/gen-design-components.mjs — do not hand-edit.
     Source: app/css/main.css @ ${sha} · v${version}. Regenerate: node tools/gen-design-components.mjs;
     tests/design-components-doc.test.mjs fails when this file is stale. -->
<!-- GENERATED:START -->
<style>
.vc { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
${styleOut}</style>
<div class="vc">
${demoOut}</div>
<!-- GENERATED:END -->
`;
}

if (!process.env.VELTA_GEN_NO_WRITE) {
  writeFileSync(new URL("docs/design-components.html", ROOT_URL), generateDesignComponents());
  console.log(`wrote docs/design-components.html · main.css @ ${sha} · v${version}`);
}
