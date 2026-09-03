// avatar.js — GPG-fingerprint identity avatars.
//
// A contact without a photo gets a square tile generated from their OpenPGP
// fingerprint: a 4-row grid of equal-height cells (three squares, two rects,
// two rects, three squares) where each cell's color is deterministically
// picked from a pool of single-word CSS color keywords by the value of one
// fingerprint group — neighboring cells never receive similar colors. The
// tile is built as a pure SVG string:
//   • badge=true  — grid + soft-black circle with the light fingerprint glyph
//                   (chat list / history)
//   • badge=false — grid only; the caller layers the contact's photo on top
//                   as a padded rounded square (photo contacts)
//   • withCaptions=true — color-name captions per cell (profile view), the
//                   only surface where the color names are shown.
import { diagnosticsSink } from "./diagnostics.js";

// Single-word CSS color keywords with sRGB triples for contrast math.
// Pure black/white and near-white keywords are excluded on purpose.
const COLOR_POOL = [
  ["Crimson", [220, 20, 60]], ["Tomato", [255, 99, 71]], ["Salmon", [250, 128, 114]],
  ["Coral", [255, 127, 80]], ["DarkOrange", [255, 140, 0]], ["Orange", [255, 165, 0]],
  ["Gold", [255, 215, 0]], ["Yellow", [255, 255, 0]], ["Khaki", [240, 230, 140]],
  ["Lavender", [230, 230, 250]], ["Thistle", [216, 191, 216]], ["Plum", [221, 160, 221]],
  ["Magenta", [255, 0, 255]], ["Violet", [238, 130, 238]], ["Orchid", [218, 112, 214]],
  ["Fuchsia", [255, 0, 255]], ["Lime", [0, 255, 0]], ["Olive", [128, 128, 0]],
  ["Green", [0, 128, 0]], ["Teal", [0, 128, 128]], ["Cyan", [0, 255, 255]],
  ["Turquoise", [64, 224, 208]], ["Aquamarine", [127, 255, 212]], ["SkyBlue", [135, 206, 235]],
  ["CadetBlue", [95, 158, 160]], ["SteelBlue", [70, 130, 180]], ["RoyalBlue", [65, 105, 225]],
  ["Blue", [0, 0, 255]], ["Indigo", [75, 0, 130]], ["Purple", [128, 0, 128]],
  ["Navy", [0, 0, 128]], ["Maroon", [128, 0, 0]], ["Chocolate", [210, 105, 30]],
  ["Sienna", [160, 82, 45]], ["Wheat", [245, 222, 179]], ["Beige", [245, 245, 220]],
  ["Gainsboro", [220, 220, 220]], ["Silver", [192, 192, 192]], ["Peru", [205, 133, 63]],
  ["Goldenrod", [218, 165, 32]],
];

// Raw per-group color straight from the fingerprint value.
export function colorForGroup(group) {
  const clean = (group || "").replace(/[^0-9A-Fa-f]/g, "").slice(0, 4);
  if (!clean) return COLOR_POOL[COLOR_POOL.length - 1];
  return COLOR_POOL[parseInt(clean, 16) % COLOR_POOL.length];
}

// --- perceptual clash avoidance between neighboring cells ---
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
function hueDist(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function colorsClash(a, b) {
  const [h1, s1, l1] = rgbToHsl(a[1]), [h2, s2, l2] = rgbToHsl(b[1]);
  const achromatic = s1 < .15 && s2 < .15;
  if (achromatic) return Math.abs(l1 - l2) < .3;
  if (s1 < .15 || s2 < .15) return Math.abs(l1 - l2) < .35; // grey vs color: needs a real lightness gap
  return hueDist(h1, h2) < 30 && Math.abs(s1 - s2) < .35 && Math.abs(l1 - l2) < .3;
}
// which cell sits visually above cell i in the 3/2/2/3 layout
const ABOVE = { 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 5, 9: 6 };
// Cell color = raw group color, stepped 7 places through the pool while it
// would look too similar to its left or above neighbor (deterministic).
function colorForCell(groups, i, chosen) {
  let idx = parseInt((groups[i] || "").replace(/[^0-9A-Fa-f]/g, "").slice(0, 4) || "0", 16) % COLOR_POOL.length;
  const neighbors = [i - 1, ABOVE[i]].filter(j => j >= 0 && chosen[j]);
  for (let step = 0; step < COLOR_POOL.length; step++) {
    const cand = COLOR_POOL[(idx + step * 7) % COLOR_POOL.length];
    if (!neighbors.some(j => colorsClash(cand, chosen[j]))) return cand;
  }
  return COLOR_POOL[idx];
}

function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Caption text color per cell: better WCAG contrast between softened
// near-white (#f4f4f4) and near-black (#1c1c1c) — never pure #000/#fff.
function contrastTextFor(rgb) {
  const l = luminance(rgb);
  const light = (luminance([244, 244, 244]) + 0.05) / (l + 0.05);
  const dark = (l + 0.05) / (luminance([28, 28, 28]) + 0.05);
  return light >= dark ? "#f4f4f4" : "#1c1c1c";
}

// "DD1F DB8A ... 7594" (10 groups of 4) or null.
export function fingerprintGroups(fpr) {
  const hex = (fpr || "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (hex.length < 40) return null;
  return hex.slice(0, 40).match(/.{4}/g);
}

// Pull the contact's fingerprint out of get_contact_encryption_info output.
// The info contains a "Me (...):" block and one block per other key owner
// ("<name> (<addr>):"), each followed by the grouped fingerprint.
export function parseFingerprint(encrInfo, contactAddr) {
  if (!encrInfo) return null;
  const blocks = encrInfo.split(/\n\s*\n/).filter((b) => b.includes("("));
  if (!blocks.length) return null;
  let block = null;
  if (contactAddr) block = blocks.find((b) => b.toLowerCase().includes(String(contactAddr).toLowerCase()));
  if (!block) block = blocks.find((b) => !/^\s*me\b/i.test(b.trim()));
  if (!block) return null;
  const hex = (block.match(/[0-9A-Fa-f]{4}/g) || []).join("");
  return hex.length >= 40 ? hex.slice(0, 40).toUpperCase() : null;
}

// Deterministic fallback for contacts without a PGP key: derive a stable
// pseudo-fingerprint from the address so every contact gets an identity tile.
export async function deriveFingerprint(addr) {
  const seed = "velta-avatar:" + (addr || "");
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    return [...new Uint8Array(buf)].slice(0, 20)
      .map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  } catch {
    let out = "";
    for (let round = 0; round < 10; round++) {
      let h = 2166136261 ^ round;
      for (const byte of new TextEncoder().encode(seed + ":" + round)) {
        h ^= byte;
        h = Math.imul(h, 16777619) >>> 0;
      }
      out += (h >>> 16).toString(16).padStart(4, "0").toUpperCase();
    }
    return out;
  }
}

// Fingerprint glyph (fingerprint-03-svgrepo-com), stroked paths, 24x24 viewBox.
const FINGERPRINT_PATHS = [
  "M8.10008 21.221C6.71021 19.2375 5.89258 16.8243 5.89258 14.2187C5.89258 10.8443 8.6265 8.10938 11.9989 8.10938C15.3712 8.10938 18.1051 10.8443 18.1051 14.2187",
  "M18.4361 20.3118C18.3262 20.3179 18.2182 20.3281 18.1073 20.3281C14.7349 20.3281 12.001 17.5931 12.001 14.2188",
  "M13.2694 21.9999C10.675 20.382 8.94705 17.5024 8.94705 14.2187C8.94705 12.5315 10.3145 11.164 12.0007 11.164C13.6869 11.164 15.0543 12.5315 15.0543 14.2187C15.0543 15.9059 16.4218 17.2733 18.108 17.2733C19.7942 17.2733 21.1616 15.9059 21.1616 14.2187C21.1616 9.1571 17.0602 5.05469 12.0017 5.05469C6.94319 5.05469 2.8418 9.1571 2.8418 14.2187C2.8418 15.3469 2.96806 16.4455 3.20021 17.5045",
  "M20.5257 5.86313C18.4435 3.4978 15.399 2 12.0002 2C8.60136 2 5.55687 3.4978 3.47461 5.86313",
].map(d => `<path d="${d}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`).join("");

const BADGE_DARK = "#1c1c1c"; // soft black — never pure
const GLYPH_LIGHT = "#f4f4f4"; // soft white — never pure

// Build the square tile as a standalone SVG. Equal-height 4-row grid:
// three 40x30 squares, two 60x30 rects, two 60x30 rects, three 40x30 squares.
// badge=true draws the soft-black circle with the light fingerprint glyph;
// badge=false leaves the grid bare (the caller layers a photo on top).
export function buildAvatarSvg({ groups, size = 120, radius = 26, withCaptions = false, badge = true }) {
  if (!groups || groups.length !== 10) return "";
  const chosen = {};
  const cells = groups.map((g, i) => {
    const [name, rgb] = (chosen[i] = colorForCell(groups, i, chosen));
    if (i < 3) return { x: i * 40, y: 0, w: 40, h: 30, name, rgb };
    if (i < 5) return { x: (i - 3) * 60, y: 30, w: 60, h: 30, name, rgb };
    if (i < 7) return { x: (i - 5) * 60, y: 60, w: 60, h: 30, name, rgb };
    return { x: (i - 7) * 40, y: 90, w: 40, h: 30, name, rgb };
  });
  const rects = cells.map((c) =>
    `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${c.name}"/>`).join("");
  const captions = !withCaptions ? "" : cells.map((c) => {
    const base = c.w >= 40 ? 9 : 8;
    const fs = Math.min(base, (c.w - 4) / (c.name.length * 0.72)).toFixed(1);
    return `<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,sans-serif" font-weight="700" font-size="${fs}" fill="${contrastTextFor(c.rgb)}">${c.name}</text>`;
  }).join("");
  let overlay = "";
  if (!withCaptions && badge) {
    overlay = `<circle cx="60" cy="60" r="40" fill="${BADGE_DARK}"/>` +
      `<g transform="translate(31.2,31.2) scale(2.4)" stroke="${GLYPH_LIGHT}">${FINGERPRINT_PATHS}</g>`;
  }
  const cid = `velta-av-${++clipSeq}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 120 120" role="img">` +
    `<defs><clipPath id="${cid}"><rect width="120" height="120" rx="${radius}"/></clipPath></defs>` +
    `<g clip-path="url(#${cid})">${rects}${overlay}${captions}</g></svg>`;
}
let clipSeq = 0;

/* ---------- fingerprint lookup (wired by app.js to the active core) ---------- */
const fprCache = new Map(); // contactId -> Promise<fingerprint|null>
let fingerprintSource = null;

export function setFingerprintSource(fn) {
  fingerprintSource = fn;
  fprCache.clear();
}

export function cachedFingerprint(contactId) {
  const p = fprCache.get(contactId);
  return p ? p.value ?? null : null; // .value set once resolved (see below)
}

export function fingerprintFor(contactId, addr) {
  if (fprCache.has(contactId)) return fprCache.get(contactId);
  if (!fingerprintSource || !contactId || contactId < 1) return Promise.resolve(null);
  const p = Promise.resolve()
    .then(() => fingerprintSource(contactId))
    .then((encrInfo) => parseFingerprint(encrInfo, addr) || deriveFingerprint(addr || "id:" + contactId))
    .catch(() => deriveFingerprint(addr || "id:" + contactId));
  fprCache.set(contactId, p);
  p.then((fpr) => { p.value = fpr; }).catch(() => {});
  return p;
}
