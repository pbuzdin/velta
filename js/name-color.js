// Person colors shared by every surface (local-chat peers, group-call roster
// and cards, sender names, solid avatar tiles). AGENTS.md 6.4 contrast rule:
//   - avatar FILLS keep their hue and carry soft-white initials at >= 3:1
//     (initials are large text); a fill that fails is darkened, others stay;
//   - sender-name TEXT keeps the hue but is nudged per theme (lighter on the
//     dark/brutal incoming bubble, darker on light) to >= 4.5:1.
const INK = [244, 244, 244]; // #f4f4f4, the initials color (main.css .velta-avatar-tile)

function lum([r, g, b]) {
  return [r, g, b].map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrastRgb(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}
const toHex = rgb => "#" + rgb.map(c => Math.round(c).toString(16).padStart(2, "0")).join("");
/** "#rgb" / "#rrggbb" / "hsl(h s% l%)" → [r,g,b], else null. */
export function parseColor(c) {
  const s = String(c || "").trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return m[1].split("").map(x => parseInt(x + x, 16));
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  m = /^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/.exec(s);
  if (m) return hslToRgb(+m[1], +m[2], +m[3]);
  return null;
}

// Name → hue; lightness 55% unless soft-white initials would drop under 3:1.
export function nameColor(name) {
  let h = 0;
  for (const ch of String(name || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  h %= 360;
  let l = 55;
  while (l > 20 && contrastRgb(INK, hslToRgb(h, 55, l)) < 3) l--;
  return `hsl(${h} 55% ${l}%)`;
}

/** Solid avatar fill: the color itself when initials reach 3:1, else darkened (same hue). */
export function avatarFill(color) {
  const rgb = parseColor(color);
  if (!rgb || contrastRgb(INK, rgb) >= 3) return color;
  const [h, s, l0] = rgbToHsl(rgb);
  for (let l = l0; l > 5; l -= 1) { const c = hslToRgb(h, s, l); if (contrastRgb(INK, c) >= 3) return toHex(c); }
  return toHex(hslToRgb(h, s, 5));
}

/** Same hue, lightness moved (dir +1 lighter / -1 darker) until >= ratio on bg. */
export function readableOn(color, bgHex, ratio = 4.6, dir = 1) {
  const rgb = parseColor(color), bg = parseColor(bgHex);
  if (!rgb || !bg) return color;
  if (contrastRgb(rgb, bg) >= ratio) return toHex(rgb);
  const [h, s, l0] = rgbToHsl(rgb);
  for (let l = l0; l >= 0 && l <= 100; l += dir) { const c = hslToRgb(h, s, l); if (contrastRgb(c, bg) >= ratio) return toHex(c); }
  return dir > 0 ? "#f4f4f4" : "#10131a";
}

// Incoming-bubble surfaces per theme (chat-appearance.js SURF mirrors
// main.css; its test pins them).
const BUBBLE_IN = () => {
  const S = globalThis.VeltaChatAppearance?.SURF;
  return S ? { dark: S.dark.bubbleIn, light: S.light.bubbleIn, brutal: S.brutal.bubbleIn } : null;
};
const senderCache = new Map();
/** Inline custom properties for .msg-sender: --sender (dark), --sender-light, --sender-brutal. */
export function senderColorVars(color) {
  if (senderCache.has(color)) return senderCache.get(color);
  const b = BUBBLE_IN();
  const css = b && parseColor(color)
    ? `--sender: ${readableOn(color, b.dark, 4.6, 1)}; --sender-light: ${readableOn(color, b.light, 4.6, -1)}; --sender-brutal: ${readableOn(color, b.brutal, 4.6, 1)}`
    : `--sender: ${color}`;
  senderCache.set(color, css);
  return css;
}
