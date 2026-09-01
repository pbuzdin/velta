// avatar.js — GPG-fingerprint identity avatars.
//
// A contact without a photo gets a square tile generated from their OpenPGP
// fingerprint: a 3-4-3 grid (three squares, four rectangles, three squares)
// where each cell's color is deterministically picked from a pool of
// single-word CSS color keywords by the value of one fingerprint group.
// The tile is built as a pure SVG string — the same builder produces the
// caption-less variant (chat list / history, with a fingerprint overlay)
// and the captioned variant (profile view), so both can be cached to files
// verbatim later.
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

// Fingerprint glyph (svgrepo 445761, 48x48 viewBox), three <path>s; fill is
// inherited from the wrapping <g> so the overlay can pick a contrast color.
const FINGERPRINT_PATHS = `
<path d="M31.7,37.3V21.9a7.7,7.7,0,0,0-15.4,0V37.3a10.7,10.7,0,0,0,4,8.3,1.8,1.8,0,0,0,.9.4,1.4,1.4,0,0,0,1.2-.6,1.5,1.5,0,0,0-.2-2.2,7.4,7.4,0,0,1-2.8-5.9V21.9a4.6,4.6,0,0,1,9.2,0V37.3a1.5,1.5,0,0,1-1.5,1.5,1.6,1.6,0,0,1-1.6-1.5V21.9a1.5,1.5,0,0,0-3,0V37.6a4.6,4.6,0,0,0,4.6,4.3,4.7,4.7,0,0,0,4.6-4.3Z"/>
<path d="M24,8.1A13.8,13.8,0,0,0,10.2,21.9V37.3a17,17,0,0,0,1.9,7.9,1.6,1.6,0,0,0,1.4.8l.7-.2a1.6,1.6,0,0,0,.6-2.1,14.1,14.1,0,0,1-1.6-6.4V21.9a10.8,10.8,0,0,1,21.6,0V37.3a7.9,7.9,0,0,1-2.9,6,1.4,1.4,0,0,0-.2,2.1,1.4,1.4,0,0,0,1.2.6,1.6,1.6,0,0,0,.9-.3,10.6,10.6,0,0,0,4-8.4V21.9A13.8,13.8,0,0,0,24,8.1Z"/>
<path d="M24,2A20,20,0,0,0,4,21.9V40.4a1.5,1.5,0,0,0,1.5,1.5,1.6,1.6,0,0,0,1.6-1.5V21.9a16.9,16.9,0,0,1,33.8,0V37.3a12.9,12.9,0,0,1-1.6,6.4,1.5,1.5,0,0,0,.7,2.1l.7.2a1.4,1.4,0,0,0,1.3-.8A16.5,16.5,0,0,0,44,38V21.9A20,20,0,0,0,24,2Z"/>`;

export function colorForGroup(group) {
  const clean = (group || "").replace(/[^0-9A-Fa-f]/g, "").slice(0, 4);
  if (!clean) return COLOR_POOL[COLOR_POOL.length - 1];
  return COLOR_POOL[parseInt(clean, 16) % COLOR_POOL.length];
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

// Build the square tile as a standalone SVG string. 12x3 grid: rows of
// three 40-unit squares, four 30-unit rectangles, three squares.
export function buildAvatarSvg({ groups, withCaptions = false, size = 120, radius = 26 }) {
  if (!groups || groups.length !== 10) return "";
  const cells = groups.map((g, i) => {
    const [name, rgb] = colorForGroup(g);
    if (i < 3) return { x: i * 40, y: 0, w: 40, h: 40, name, rgb };
    if (i < 7) return { x: (i - 3) * 30, y: 40, w: 30, h: 40, name, rgb };
    return { x: (i - 7) * 40, y: 80, w: 40, h: 40, name, rgb };
  });
  const rects = cells.map((c) =>
    `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${c.name}"/>`).join("");
  const captions = !withCaptions ? "" : cells.map((c) => {
    const base = c.w >= 40 ? 9 : 7;
    const fs = Math.min(base, (c.w - 2) / (c.name.length * 0.62)).toFixed(1);
    return `<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,sans-serif" font-weight="700" font-size="${fs}" fill="${contrastTextFor(c.rgb)}">${c.name}</text>`;
  }).join("");
  // Caption-less variant carries the fingerprint glyph, centered at 70%,
  // colored for the best contrast against the average tile luminance.
  let overlay = "";
  if (!withCaptions) {
    const avg = cells.reduce((a, c) => a + luminance(c.rgb), 0) / cells.length;
    const light = (luminance([244, 244, 244]) + 0.05) / (avg + 0.05);
    const dark = (avg + 0.05) / (luminance([32, 32, 32]) + 0.05);
    const color = light >= dark ? "#f4f4f4" : "#202020";
    overlay = `<g transform="translate(18,18) scale(1.75)" fill="${color}">${FINGERPRINT_PATHS}</g>`;
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
