// Chat appearance (drawer → Chat appearance): message text size, bubble
// corners, accent color and hyphenation. Per device, in localStorage, like
// the interface scale (velta-ui-scale):
//   velta-msg-font-size  px, 10..22 (absent = 15.5, the .msg-text default)
//   velta-bubble-radius  px, 0..14  (absent = the theme's --radius-bubble)
//   velta-accent         #rrggbb    (absent = the theme's own accent)
//   velta-hyphens        "0" = off  (absent = on)
// A classic blocking <script src> in <head> right after ui-scale.js (the CSP
// forbids inline scripts), so the values land on :root before first paint.
// It also pins data-theme early from dw-theme (app.js applyTheme repeats
// it later), so a light or custom-accent user never sees a dark/blue frame.
// The API lives on globalThis.VeltaChatAppearance for ui.js and the tests.
(function (g) {
  "use strict";
  const KEYS = { font: "velta-msg-font-size", radius: "velta-bubble-radius", accent: "velta-accent", hyphens: "velta-hyphens" };
  const DEFAULTS = { fontSize: 15.5, radius: 14, accent: null, hyphens: true };
  const FONT_MIN = 10, FONT_MAX = 22, RADIUS_MIN = 0, RADIUS_MAX = 14;
  // Swatches. null = the theme's built-in blue (dark #5aa2e6, light #3390ec),
  // which keeps every legacy hand-measured color untouched.
  const PRESETS = [
    [null, "Blue (default)"], ["#8774e1", "Violet"], ["#3fa34d", "Green"], ["#1fa69a", "Teal"],
    ["#ee8a1f", "Orange"], ["#e0516e", "Rose"], ["#c79a0f", "Amber"], ["#7a8496", "Slate"],
  ];
  // Surfaces the derivation measures against (main.css :root / light).
  const SURF = {
    dark: { text: "#f2f2f5", bubbleIn: "#1c1c26", chat: "#0b0b10", quote: "#292932", sidebar: "#181820", raised: "#1d1d22" },
    light: { text: "#16181d", bubbleIn: "#f4f4f4", chat: "#f4f4f4", quote: "#e9e9e9", sidebar: "#f4f4f4", raised: "#e9e9e9" },
    brutal: { text: "#f2f0e9", bubbleIn: "#2d2d38", chat: "#1b1b22", quote: "#2b2b35", sidebar: "#2a2a35", raised: "#313139" },
  };
  // raised = --bg-hover composited over --bg (buttons on the page, e.g. the
  // group-call app bar).
  // Mirrors of main.css tokens (no DOM before first paint); the
  // chat-appearance test asserts they still match main.css.
  const THEME_BG = { dark: "#0f0f14", light: "#f4f4f4", brutal: "#22222b" };
  const INK_LIGHT = "#f4f4f4", INK_DARK = "#10131a"; // never pure white/black (AGENTS 6.4)

  /* ---------- clamping / parsing ---------- */
  function clampFont(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.fontSize;
    return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n * 2) / 2));
  }
  function clampRadius(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.radius;
    return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(n)));
  }
  function normHex(v) {
    if (typeof v !== "string") return null;
    let s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s.slice(1).split("").map(c => c + c).join("");
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }

  /* ---------- color math (sRGB, WCAG 2.x) ---------- */
  const hexToRgb = h => { const n = parseInt(normHex(h).slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const rgbToHex = rgb => "#" + rgb.map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
  function luminance(hex) {
    const [r, g2, b] = hexToRgb(hex).map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function rgbToHsl([r, g2, b]) {
    r /= 255; g2 /= 255; b /= 255;
    const max = Math.max(r, g2, b), min = Math.min(r, g2, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g2 - b) / d + (g2 < b ? 6 : 0) : max === g2 ? (b - r) / d + 2 : (r - g2) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb([h, s, l]) {
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }
  const mix = (a, b, t) => { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.map((c, i) => c + (y[i] - c) * t)); };
  // Move fg's HSL lightness toward white (dir 1) or black (dir -1) until it
  // reaches `ratio` against bg. The search stays inside the soft range
  // (AGENTS.md 6.4: no pure black or white), so results never need a
  // post-hoc nudge that could undo the ratio. Falls back to the matching
  // soft ink when the hue can't get there.
  const L_MIN = 0.04, L_MAX = 0.955;
  function ensureContrast(fg, bg, ratio, dir) {
    const start = soften(normHex(fg));
    if (contrast(start, bg) >= ratio) return start;
    const hsl = rgbToHsl(hexToRgb(start));
    for (let i = 0; i < 100; i++) {
      hsl[2] = Math.min(L_MAX, Math.max(L_MIN, hsl[2] + dir * 0.01));
      const c = rgbToHex(hslToRgb(hsl));
      if (contrast(c, bg) >= ratio) return c;
      if (hsl[2] === L_MIN || hsl[2] === L_MAX) break;
    }
    return dir > 0 ? INK_LIGHT : INK_DARK;
  }
  // Darken/lighten a SURFACE until fixed text on it reaches the ratio.
  function ensureSurface(bg, text, ratio, dir) { return ensureContrast(bg, text, ratio, dir); }
  const shift = (hex, dl) => { const hsl = rgbToHsl(hexToRgb(hex)); hsl[2] = Math.min(0.955, Math.max(0.04, hsl[2] + dl)); return rgbToHex(hslToRgb(hsl)); };
  function soften(hex) {
    const hsl = rgbToHsl(hexToRgb(hex));
    if (hsl[2] >= 0.04 && hsl[2] <= 0.955) return hex;
    hsl[2] = Math.min(0.955, Math.max(0.04, hsl[2]));
    return rgbToHex(hslToRgb(hsl));
  }
  // Text color for a fill: soft white or soft black, whichever reads better.
  const onColor = bg => contrast(INK_LIGHT, bg) >= contrast(INK_DARK, bg) ? INK_LIGHT : INK_DARK;

  // All theme tokens a custom accent drives. Every text/background pair
  // returned here is >= 4.5:1 (WCAG AA): accent text on the incoming bubble
  // and chat surface, body text / meta / links on the own bubble, ink on
  // accent fills (buttons, chips, badges).
  function deriveAccent(base, theme) {
    const c = normHex(base);
    if (!c) return null;
    const s = SURF[theme] || SURF.dark;
    const dark = theme !== "light";
    const dir = dark ? 1 : -1;
    let accent = ensureContrast(c, s.bubbleIn, 4.5, dir);
    accent = ensureContrast(accent, s.chat, 4.5, dir);
    const out = {};
    out.accent = accent;
    out.accentHover = shift(accent, dark ? 0.06 : -0.06);
    out.accentActive = shift(accent, dark ? -0.06 : -0.12);
    out.onAccent = onColor(accent);
    out.onAccentChip = out.onAccent; // category chips (default dark ink)
    out.accentTint = accent;
    if (dark) {
      // Own bubble: the accent pushed down into the chat's dark (the default
      // #2b5278 is ~50% of #5aa2e6 over #0b0b10), then darkened until the
      // body text clears 7:1 so meta/link tints still fit above 4.5.
      const bubble = ensureSurface(mix(c, s.chat, 0.5), s.text, 7, -1);
      out.bubbleOut = bubble;
      out.bgActive = bubble;
      out.metaOut = ensureContrast(mix(c, INK_LIGHT, 0.55), bubble, 4.5, 1);
      out.outLink = ensureContrast(mix(c, INK_LIGHT, 0.82), bubble, 4.5, 1);
      out.ticksRead = ensureContrast(mix(c, INK_LIGHT, 0.35), bubble, 3, 1);
    } else {
      // Own bubble: a light tint of the accent (default #e1f0fb ≈ 14%).
      const bubble = ensureSurface(mix(c, s.bubbleIn, 0.86), s.text, 7, 1);
      out.bubbleOut = bubble;
      out.bgActive = accent;
      out.metaOut = ensureContrast(mix(c, s.text, 0.25), bubble, 4.5, -1);
      out.outLink = ensureContrast(mix(c, s.text, 0.55), bubble, 4.5, -1);
      out.ticksRead = ensureContrast(c, bubble, 3, -1);
    }
    out.accentTextIn = accent; // inline buttons in incoming bubbles (light)
    // Accent-colored UI text (.btn-text, status, send icon) on the app
    // surfaces: sidebar and the incoming bubble, both >= 4.6:1.
    out.accentText = [s.sidebar, s.bubbleIn, s.quote, s.raised].reduce((a, bg) => ensureContrast(a, bg, 4.6, dir), c);
    // Quote sender sits on --bg-reply over the incoming bubble (SURF.quote =
    // that composite); 4.6 leaves headroom over rounding.
    out.quoteName = ensureContrast(dark ? accent : out.outLink, s.quote, 4.6, dir);
    out.onBubbleOut = s.text;
    return out;
  }
  const VAR_NAMES = {
    accent: "--accent", accentHover: "--accent-hover", accentActive: "--accent-active", onAccent: "--on-accent",
    accentTint: "--accent-tint", bubbleOut: "--bg-bubble-out", bgActive: "--bg-active", metaOut: "--text-meta-out",
    outLink: "--out-link", ticksRead: "--ticks-read", onAccentChip: "--on-accent-chip",
    accentTextIn: "--accent-text-in", quoteName: "--quote-name", accentText: "--accent-text",
  };
  const BRUTAL_KEYS = ["accent", "accentHover", "accentActive", "onAccent", "accentTint", "onAccentChip", "accentText"];
  // The <style> text for a custom accent. Dark covers the default (no
  // data-theme yet) and "dark"; brutal keeps its own yellow-on-ink palette.
  function accentCss(base) {
    const d = deriveAccent(base, "dark"), l = deriveAccent(base, "light");
    const br = deriveAccent(base, "brutal");
    if (!d || !l || !br) return "";
    const block = (o, keys = Object.keys(VAR_NAMES)) => keys.map(k => `${VAR_NAMES[k]}: ${o[k]};`).join(" ");
    // Brutal keeps its yellow own-bubble/selection and ink quote/meta palette;
    // the custom accent drives only the accent fills and accent text there.
    return `:root:not([data-theme="light"]):not([data-theme="brutal"]) { ${block(d)} }\n` +
      `:root[data-theme="light"] { ${block(l)} }\n` +
      `:root[data-theme="brutal"] { ${block(br, BRUTAL_KEYS)} }`;
  }

  /* ---------- storage ---------- */
  function ls() { try { return g.localStorage || null; } catch { return null; } }
  function read() {
    const s = ls();
    const get = k => { try { return s ? s.getItem(k) : null; } catch { return null; } };
    const f = get(KEYS.font), r = get(KEYS.radius);
    return {
      fontSize: f == null ? DEFAULTS.fontSize : clampFont(f),
      radius: r == null ? null : clampRadius(r), // null = theme default
      accent: normHex(get(KEYS.accent)),
      hyphens: get(KEYS.hyphens) !== "0",
    };
  }
  function write(patch) {
    const s = ls();
    if (!s) return read();
    const put = (k, v) => { try { v == null ? s.removeItem(k) : s.setItem(k, String(v)); } catch {} };
    if ("fontSize" in patch) { const v = clampFont(patch.fontSize); put(KEYS.font, v === DEFAULTS.fontSize ? null : v); }
    if ("radius" in patch) put(KEYS.radius, patch.radius == null ? null : clampRadius(patch.radius));
    if ("accent" in patch) put(KEYS.accent, normHex(patch.accent));
    if ("hyphens" in patch) put(KEYS.hyphens, patch.hyphens === false ? "0" : null);
    return read();
  }
  function reset() { return write({ fontSize: DEFAULTS.fontSize, radius: null, accent: null, hyphens: true }); }

  /* ---------- applying to :root ---------- */
  // Inline custom properties on <html> (font size, corners) beat every theme
  // block; the accent goes into one <style id="velta-chat-accent"> because its
  // values differ per theme. Removing a property restores the stylesheet's.
  function radiusVars(r) {
    if (r == null) return null;
    return { "--radius-bubble": r + "px", "--radius-tail": Math.min(6, r) + "px", "--radius-quote": Math.min(6, r) + "px", "--radius-media": Math.max(0, r - 4) + "px" };
  }
  function apply(state, doc) {
    doc = doc || g.document;
    const st = state || read();
    const root = doc && doc.documentElement;
    if (!root) return st;
    const css = root.style;
    if (st.fontSize === DEFAULTS.fontSize) css.removeProperty("--msg-font-size");
    else css.setProperty("--msg-font-size", st.fontSize + "px");
    const rv = radiusVars(st.radius);
    for (const k of ["--radius-bubble", "--radius-tail", "--radius-quote", "--radius-media"]) {
      if (rv) css.setProperty(k, rv[k]); else css.removeProperty(k);
    }
    if (root.classList) root.classList.toggle("no-hyphens", !st.hyphens);
    let tag = doc.getElementById ? doc.getElementById("velta-chat-accent") : null;
    const text = st.accent ? accentCss(st.accent) : "";
    if (text) {
      if (!tag && doc.createElement) {
        tag = doc.createElement("style");
        tag.id = "velta-chat-accent";
        (doc.head || root).appendChild(tag);
      }
      if (tag) tag.textContent = text;
    } else if (tag) tag.remove();
    return st;
  }
  // The pre-paint theme pin (app.js applyTheme owns it after boot).
  function pinTheme(doc) {
    doc = doc || g.document;
    try {
      const root = doc.documentElement;
      if (root.dataset.theme) return;
      const s = ls();
      const mode = (s && s.getItem("dw-theme")) || "auto";
      const eff = mode === "auto" ? (g.matchMedia && g.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
      root.dataset.theme = eff;
      const meta = doc.querySelector && doc.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = THEME_BG[eff] || THEME_BG.light;
    } catch {}
  }

  g.VeltaChatAppearance = {
    KEYS, DEFAULTS, PRESETS, FONT_MIN, FONT_MAX, RADIUS_MIN, RADIUS_MAX,
    clampFont, clampRadius, normHex, soften, contrast, luminance, ensureContrast, deriveAccent, accentCss, onColor, mix,
    read, write, reset, apply, pinTheme, radiusVars, VAR_NAMES, SURF, THEME_BG, BRUTAL_KEYS,
  };
  try { pinTheme(); apply(); } catch {}
})(typeof globalThis !== "undefined" ? globalThis : this);
