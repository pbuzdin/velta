import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Drawer → Chat appearance (app/js/chat-appearance.js): a classic pre-paint
// script, so it is run here the way the browser runs it — in a fresh global
// with localStorage and a minimal document — and its API read back from
// globalThis.VeltaChatAppearance.
const SRC = readFileSync(new URL("../app/js/chat-appearance.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const UI = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}
function fakeDoc() {
  const props = new Map();
  const classes = new Set();
  const nodes = new Map();
  const head = { children: [], appendChild(n) { this.children.push(n); nodes.set(n.id, n); n.remove = () => { nodes.delete(n.id); head.children.splice(head.children.indexOf(n), 1); }; } };
  const meta = { content: "#0f0f14" };
  return {
    props, classes, head, meta,
    documentElement: {
      dataset: {},
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) },
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    },
    getElementById: id => nodes.get(id) || null,
    createElement: () => ({ id: "", textContent: "" }),
    querySelector: sel => (sel.includes("theme-color") ? meta : null),
  };
}
function load({ storage = fakeStorage(), doc = fakeDoc(), light = false } = {}) {
  const ctx = { localStorage: storage, document: doc, matchMedia: () => ({ matches: light }) };
  ctx.globalThis = ctx;
  vm.runInNewContext(SRC, ctx);
  return { A: ctx.VeltaChatAppearance, storage, doc };
}

test("clamping: font 10..22 in half px, radius 0..14 whole px, junk → defaults", () => {
  const { A } = load();
  assert.equal(A.clampFont(9), 10);
  assert.equal(A.clampFont(30), 22);
  assert.equal(A.clampFont("16.3"), 16.5);
  assert.equal(A.clampFont("abc"), 15.5);
  assert.equal(A.clampFont(15.5), 15.5);
  assert.equal(A.clampRadius(-3), 0);
  assert.equal(A.clampRadius(99), 14);
  assert.equal(A.clampRadius("7.6"), 8);
  assert.equal(A.clampRadius(null), 0); // Number(null) = 0, a real "square"
  assert.equal(A.clampRadius(undefined), 14);
  assert.equal(A.normHex("#ABC"), "#aabbcc");
  assert.equal(A.normHex("3fa34d"), null);
  assert.equal(A.normHex("#3fa34d "), "#3fa34d");
  assert.equal(A.normHex("red"), null);
});

test("defaults match the stylesheet (.msg-text 15.5px, --radius-bubble 14px)", () => {
  const { A } = load();
  assert.equal(A.DEFAULTS.fontSize, 15.5);
  assert.equal(A.DEFAULTS.radius, 14);
  assert.match(CSS, /--msg-font-size: 15\.5px;/);
  assert.match(CSS, /:root \{[\s\S]*?--radius-bubble: 14px;/);
  assert.equal(A.FONT_MIN, 10);
  assert.equal(A.FONT_MAX, 22);
  assert.equal(A.RADIUS_MAX, A.DEFAULTS.radius);
});

test("persistence: per-key localStorage, defaults remove their key", () => {
  const { A, storage } = load();
  assert.deepEqual({ ...A.read() }, { fontSize: 15.5, radius: null, accent: null, hyphens: true });
  A.write({ fontSize: 22, radius: 0, accent: "#3FA34D", hyphens: false });
  assert.equal(storage.getItem("velta-msg-font-size"), "22");
  assert.equal(storage.getItem("velta-bubble-radius"), "0");
  assert.equal(storage.getItem("velta-accent"), "#3fa34d");
  assert.equal(storage.getItem("velta-hyphens"), "0");
  assert.deepEqual({ ...A.read() }, { fontSize: 22, radius: 0, accent: "#3fa34d", hyphens: false });
  A.write({ fontSize: 15.5 });
  assert.equal(storage.getItem("velta-msg-font-size"), null);
  A.write({ accent: "not-a-color" });
  assert.equal(storage.getItem("velta-accent"), null);
  A.reset();
  assert.equal(storage._m.size, 0);
  // Corrupt stored values are clamped on read, never trusted.
  storage.setItem("velta-msg-font-size", "500");
  storage.setItem("velta-bubble-radius", "-4");
  assert.equal(A.read().fontSize, 22);
  assert.equal(A.read().radius, 0);
});

test("contrast is the WCAG 2.x ratio", () => {
  const { A } = load();
  assert.equal(Math.round(A.contrast("#ffffff", "#000000") * 100) / 100, 21);
  assert.equal(A.contrast("#777777", "#777777"), 1);
  // Stock dark pairs: body text on the own bubble, raw accent on it (why
  // links there use --out-link).
  assert.equal(Math.round(A.contrast("#f2f2f5", "#2b5278") * 100) / 100, 7.28);
  assert.equal(Math.round(A.contrast("#5aa2e6", "#2b5278") * 100) / 100, 3);
});

const SAMPLE = ["#8774e1", "#3fa34d", "#1fa69a", "#ee8a1f", "#e0516e", "#c79a0f", "#7a8496",
  "#ffff00", "#00ff00", "#ff0000", "#0000ff", "#000000", "#ffffff", "#808080", "#ff00ff", "#00ffff"];

test("derived accent palettes keep every text pair at WCAG AA in both themes", () => {
  const { A } = load();
  const surf = { dark: { bubbleIn: "#1c1c26", chat: "#0b0b10" }, light: { bubbleIn: "#f4f4f4", chat: "#f4f4f4" } };
  for (const c of SAMPLE) for (const theme of ["dark", "light"]) {
    const d = A.deriveAccent(c, theme);
    const at = `${c} ${theme}`;
    assert.ok(A.contrast(d.accent, surf[theme].bubbleIn) >= 4.5, `${at} accent on incoming bubble`);
    assert.ok(A.contrast(d.accent, surf[theme].chat) >= 4.5, `${at} accent on chat`);
    assert.ok(A.contrast(d.onBubbleOut, d.bubbleOut) >= 4.5, `${at} text on own bubble`);
    assert.ok(A.contrast(d.metaOut, d.bubbleOut) >= 4.5, `${at} meta on own bubble`);
    assert.ok(A.contrast(d.outLink, d.bubbleOut) >= 4.5, `${at} link on own bubble`);
    assert.ok(A.contrast(d.onAccent, d.accent) >= 4.5, `${at} ink on accent fill`);
    for (const [k, v] of Object.entries(d)) {
      assert.match(v, /^#[0-9a-f]{6}$/, `${at} ${k}`);
      assert.ok(v !== "#ffffff" && v !== "#000000", `${at} ${k} is pure ${v} (AGENTS.md 6.4)`);
    }
  }
});

test("derivation: ink picked by contrast, hover/active differ, tail follows theme", () => {
  const { A } = load();
  assert.equal(A.onColor("#f4f4f4"), "#10131a");
  assert.equal(A.onColor("#1a1a1a"), "#f4f4f4");
  const light = A.deriveAccent("#ffff00", "light");
  assert.notEqual(light.accent, "#ffff00", "yellow is darkened for the light theme");
  const dark = A.deriveAccent("#3fa34d", "dark");
  assert.notEqual(dark.accentHover, dark.accent);
  assert.notEqual(dark.accentActive, dark.accent);
  assert.ok(A.contrast(dark.bubbleOut, "#f2f2f5") >= 7, "dark own bubble keeps body text at 7:1");
  assert.equal(A.deriveAccent("nope", "dark"), null);
});

test("apply(): inline :root properties + one per-theme accent <style>", () => {
  const storage = fakeStorage({ "velta-msg-font-size": "10", "velta-bubble-radius": "3", "velta-accent": "#3fa34d", "velta-hyphens": "0" });
  const { A, doc } = load({ storage });
  assert.equal(doc.props.get("--msg-font-size"), "10px");
  assert.equal(doc.props.get("--radius-bubble"), "3px");
  assert.equal(doc.props.get("--radius-tail"), "3px");
  assert.equal(doc.props.get("--radius-quote"), "3px");
  assert.equal(doc.props.get("--radius-media"), "0px");
  assert.ok(doc.classes.has("no-hyphens"));
  const tag = doc.getElementById("velta-chat-accent");
  assert.ok(tag, "accent style element created at boot");
  assert.match(tag.textContent, /:root:not\(\[data-theme="light"\]\):not\(\[data-theme="brutal"\]\) \{[^}]*--accent: #/);
  assert.match(tag.textContent, /:root\[data-theme="light"\] \{[^}]*--bg-bubble-out: #/);
  // Brutal: the accent drives fills/accent text only; its yellow bubble stays.
  const br = tag.textContent.match(/:root\[data-theme="brutal"\] \{([^}]*)\}/);
  assert.ok(br, "brutal accent block");
  assert.match(br[1], /--accent: #/);
  assert.doesNotMatch(br[1], /--bg-bubble-out|--bg-active|--text-meta-out/, "brutal keeps its own-bubble palette");
  // Back to defaults: everything removed, stylesheet values return.
  A.apply(A.reset(), doc);
  assert.equal(doc.props.size, 0);
  assert.equal(doc.getElementById("velta-chat-accent"), null);
  assert.ok(!doc.classes.has("no-hyphens"));
  const r = A.radiusVars(14);
  assert.deepEqual({ ...r }, { "--radius-bubble": "14px", "--radius-tail": "6px", "--radius-quote": "6px", "--radius-media": "10px" });
});

test("pre-paint theme pin follows dw-theme / the system and sets meta theme-color", () => {
  let { doc } = load({ storage: fakeStorage({ "dw-theme": "light" }) });
  assert.equal(doc.documentElement.dataset.theme, "light");
  assert.equal(doc.meta.content, "#f4f4f4");
  ({ doc } = load({ light: true }));
  assert.equal(doc.documentElement.dataset.theme, "light");
  ({ doc } = load({ storage: fakeStorage({ "dw-theme": "brutal" }) }));
  assert.equal(doc.meta.content, "#22222b");
});

test("CSS wiring: every derived token and size var is consumed by main.css", () => {
  const { A } = load();
  for (const v of Object.values(A.VAR_NAMES)) assert.match(CSS, new RegExp(`var\\(${v}[,)]`), `${v} is used`);
  assert.match(CSS, /\.msg-text \{[^}]*font-size: var\(--msg-font-size\)/);
  assert.match(CSS, /\.msg-sender \{[^}]*font-size: calc\(var\(--msg-font-size\)/);
  assert.match(CSS, /\.bubble \{[^}]*border-bottom-left-radius: var\(--radius-tail\)/);
  assert.match(CSS, /\.msg-row\.out \.bubble \{[^}]*border-bottom-right-radius: var\(--radius-tail\)/);
  assert.match(CSS, /\.msg-quote \{[^}]*border-radius: var\(--radius-quote\)/);
  assert.match(CSS, /\.msg-image \{[^}]*border-radius: var\(--radius-media\)/);
  assert.match(CSS, /\.msg-image \.img-wrap \{[^}]*border-radius: var\(--radius-media\)/);
  assert.match(CSS, /\.msg-video \{[^}]*border-radius: var\(--radius-media\)/);
  // The old hard-coded accent tint must not come back (it ignores the setting).
  assert.doesNotMatch(CSS, /rgba\(90, ?162, ?230/);
  // Defaults for the derived tokens exist, so the stock look is unchanged.
  for (const v of ["--accent-tint", "--accent-hover", "--accent-active", "--on-accent", "--out-link", "--ticks-read"]) {
    assert.match(CSS, new RegExp(`:root \\{[\\s\\S]*?${v}:`), `${v} default`);
  }
});

test("index.html loads the pre-paint script in <head>, after ui-scale.js", () => {
  const head = HTML.slice(0, HTML.indexOf("</head>"));
  const a = head.indexOf('<script src="js/ui-scale.js"></script>');
  const b = head.indexOf('<script src="js/chat-appearance.js"></script>');
  assert.ok(a > 0 && b > a, "chat-appearance.js right after ui-scale.js");
  assert.ok(head.indexOf('href="css/main.css"') < b, "after the stylesheet, so the accent <style> wins on order too");
  assert.doesNotMatch(SRC, /^\s*(import|export)\s/m, "classic script, no module syntax");
});

test("drawer section: native <details>, labelled ranges with px valuetext, swatches, reset", () => {
  assert.match(UI, /<details class="drawer-details" data-chat-appearance>/);
  assert.match(UI, /<label for="ca-font">\$\{escapeHtml\(t\("Message text size"\)\)\}<\/label>/);
  assert.match(UI, /<input type="range" id="ca-font"[^>]*aria-valuetext="\$\{pxText\(st\.fontSize\)\}"/);
  assert.match(UI, /<input type="range" id="ca-radius"[^>]*step="1"/);
  assert.match(UI, /<fieldset class="ca-accent" data-ca-accent>\s*<legend>\$\{escapeHtml\(t\("Accent color"\)\)\}<\/legend>/);
  assert.match(UI, /<input type="color" data-ca-custom aria-label="\$\{escapeHtml\(t\("Custom accent color"\)\)\}"/);
  assert.match(UI, /data-ca-reset>\$\{escapeHtml\(t\("Reset to defaults"\)\)\}</);
  assert.match(UI, /setAttribute\("aria-valuetext", pxText\(v\)\)/);
  assert.ok(UI.indexOf("${chatAppearanceHtml()}") > UI.indexOf("data-theme-opts"), "placed after Theme");
  assert.ok(UI.indexOf("${chatAppearanceHtml()}") < UI.indexOf("data-scale-opts"), "and before Interface scale");
  const { A } = load();
  assert.equal(A.PRESETS.length, 8);
  assert.equal(A.PRESETS[0][0], null, "first swatch = the theme's stock blue");
});

// The pre-paint mirrors of main.css tokens must not drift (design audit #4).
test("SURF / THEME_BG mirror main.css tokens per theme", () => {
  const { A } = load();
  const block = sel => { const i = CSS.indexOf(sel + " {"); return CSS.slice(i, CSS.indexOf("\n}", i)); };
  const tok = (b, n) => (b.match(new RegExp("--" + n + ":\\s*(#[0-9a-f]{6})", "i")) || [])[1];
  const blocks = { dark: block(":root"), light: block('html[data-theme="light"]'), brutal: block('html[data-theme="brutal"]') };
  for (const [th, b] of Object.entries(blocks)) {
    assert.equal(A.THEME_BG[th], tok(b, "bg"), th + " --bg");
    assert.equal(A.SURF[th].text, tok(b, "text"), th + " --text");
    assert.equal(A.SURF[th].bubbleIn, tok(b, "bg-bubble-in"), th + " --bg-bubble-in");
  }
  assert.equal(A.SURF.dark.chat, tok(blocks.dark, "bg-chat"));
  assert.equal(A.SURF.brutal.chat, tok(blocks.brutal, "bg-chat"));
});
