// avatar.js — GPG-fingerprint identity avatars.
//
// A contact without a photo gets a square tile generated from their OpenPGP
// fingerprint: a 4-row grid of equal-height cells (three squares, two rects,
// two rects, three squares) whose ten cells are visually distinct — each
// cell's color is deterministically picked from a pool of single-word CSS
// color keywords by the value of one fingerprint group, a color already used
// in the tile is skipped, and edge-sharing neighbors never receive similar
// colors. The tile is built as a pure SVG string:
//   • badge=true  — grid + soft-black circle with the light fingerprint glyph
//                   (chat list / history)
//   • badge=false — grid only; the caller layers the contact's photo on top
//                   as a padded rounded square (photo contacts)
//   • withCaptions=true — color-name captions per cell (profile view), the
//                   only surface where the color names are shown.
import { diagnosticsSink } from "./diagnostics.js";
import { LruCache } from "./lru.js";

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
// which cells sit visually above cell i in the 3/2/2/3 layout — ALL cells
// sharing an edge, not just the max-overlap one (cell 1 also touches cell 4
// along 20px; guarding only the primary neighbor let two Tomatoes touch).
const ABOVE = { 3: [1, 0], 4: [2, 1], 5: [3], 6: [4], 7: [5], 8: [6, 5], 9: [6] };
// Cell color = raw group color, stepped 7 places through the pool. Two
// constraints, in priority order: never similar to an edge-sharing neighbor
// (hard), and never a color already used elsewhere in the tile (strong
// preference — 40 colors for 10 cells makes ten distinct hues always
// reachable; if a tile paints itself into a corner, the first non-clashing
// repeat is taken rather than risking a neighbor clash).
function colorForCell(groups, i, chosen) {
  let idx = parseInt((groups[i] || "").replace(/[^0-9A-Fa-f]/g, "").slice(0, 4) || "0", 16) % COLOR_POOL.length;
  const neighbors = [i - 1, ...(ABOVE[i] || [])].filter(j => j >= 0 && chosen[j]);
  const used = new Set(Object.values(chosen).map(([name]) => name));
  let fallback = null;
  for (let step = 0; step < COLOR_POOL.length; step++) {
    const cand = COLOR_POOL[(idx + step * 7) % COLOR_POOL.length];
    if (neighbors.some(j => colorsClash(cand, chosen[j]))) continue;
    if (!used.has(cand[0])) return cand;
    if (!fallback) fallback = cand;
  }
  return fallback ?? COLOR_POOL[idx];
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

// Address inside the first "(user@host)" of an encryption-info block.
function blockAddr(block) {
  const m = String(block).match(/\(([^()\s]+@[^()\s]+)\)/);
  return m ? m[1].toLowerCase() : "";
}

// Pull the contact's fingerprint out of get_contact_encryption_info output.
// Core <= 2.65 wrote blocks as "<name> (<addr>):\n<fpr>"; core 2.66 dropped
// the address ("<name>:\n<fpr>") and orders blocks by fingerprint, not by
// address. So: match by address when present, else drop our own key (selfFpr)
// and take the remaining one, else skip a "Me"-ish header. Only the
// fingerprint lines count: a display name or a chatmail address can itself
// contain 4 hex characters.
function blockFpr(block) {
  const lines = String(block).match(/(?:[0-9A-Fa-f]{4} ){4}[0-9A-Fa-f]{4}/g) || [];
  const hex = lines.join("").replace(/[^0-9A-Fa-f]/g, "");
  return hex.length >= 40 ? hex.slice(0, 40).toUpperCase() : null;
}

export function parseFingerprint(encrInfo, contactAddr, selfFpr) {
  if (!encrInfo) return null;
  const blocks = String(encrInfo).split(/\n\s*\n/)
    .map((b) => ({ b, fpr: blockFpr(b) })).filter((x) => x.fpr);
  if (!blocks.length) return null;
  const want = String(contactAddr || "").trim().toLowerCase();
  if (want) {
    const hit = blocks.find((x) => blockAddr(x.b) === want);
    if (hit) return hit.fpr;
  }
  const self = String(selfFpr || "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (self.length >= 40) {
    const others = blocks.filter((x) => x.fpr !== self.slice(0, 40));
    if (others.length === 1) return others[0].fpr;
    // Both blocks carry our key: this is the self contact.
    if (!others.length) return blocks[0].fpr;
  }
  const notMe = blocks.find((x) => !/^\s*(me|you)\b/i.test(x.b.trim()));
  return (notMe || blocks[0]).fpr;
}

// OpenPGP fingerprint of the primary public-key packet in a make_vcard KEY
// (core writes `KEY:data:application/pgp-keys;base64\,…`). v4 = SHA-1 of
// 0x99||len16||body; v6 = SHA-256 of 0x9B||len32||body. Null if there is
// no key yet — never invent one from the address.
export async function fingerprintFromVcard(vcard) {
  const unfolded = String(vcard || "").replace(/\r?\n[ \t]/g, "");
  const m = unfolded.match(/KEY(?::|;[^\r\n]*:)data:application\/pgp-keys;base64\\?,([A-Za-z0-9+/=]+)/i);
  if (!m) return null;
  const b64 = m[1];
  let raw;
  try { raw = atob(b64); } catch { return null; }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return fingerprintFromPublicKey(bytes);
}

export async function fingerprintFromPublicKey(bytes) {
  const pkt = firstPublicKeyPacket(bytes);
  if (!pkt) return null;
  const version = pkt[0];
  let prefix, hash;
  if (version === 4) {
    const n = pkt.length;
    prefix = new Uint8Array(3 + n);
    prefix[0] = 0x99;
    prefix[1] = (n >> 8) & 0xff;
    prefix[2] = n & 0xff;
    prefix.set(pkt, 3);
    hash = "SHA-1";
  } else if (version === 6 || version === 5) {
    const n = pkt.length;
    prefix = new Uint8Array(5 + n);
    prefix[0] = version === 6 ? 0x9b : 0x9a;
    prefix[1] = (n >>> 24) & 0xff;
    prefix[2] = (n >>> 16) & 0xff;
    prefix[3] = (n >>> 8) & 0xff;
    prefix[4] = n & 0xff;
    prefix.set(pkt, 5);
    hash = "SHA-256";
  } else {
    return null;
  }
  try {
    const buf = await crypto.subtle.digest(hash, prefix);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  } catch {
    return null;
  }
}

function firstPublicKeyPacket(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if ((b & 0x80) === 0) return null;
    let tag, hdr, len;
    if (b & 0x40) {
      tag = b & 0x3f;
      const l1 = bytes[i + 1];
      if (l1 == null) return null;
      if (l1 < 192) { hdr = 2; len = l1; }
      else if (l1 < 224) {
        const l2 = bytes[i + 2];
        if (l2 == null) return null;
        hdr = 3; len = ((l1 - 192) << 8) + l2 + 192;
      } else if (l1 === 255) {
        if (i + 5 >= bytes.length) return null;
        hdr = 6;
        len = ((bytes[i + 2] << 24) | (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5]) >>> 0;
      } else {
        return null;
      }
    } else {
      tag = (b >> 2) & 0x0f;
      const lt = b & 0x03;
      if (lt === 0) { hdr = 2; len = bytes[i + 1]; }
      else if (lt === 1) {
        if (i + 2 >= bytes.length) return null;
        hdr = 3; len = (bytes[i + 1] << 8) | bytes[i + 2];
      } else if (lt === 2) {
        if (i + 4 >= bytes.length) return null;
        hdr = 5;
        len = ((bytes[i + 1] << 24) | (bytes[i + 2] << 16) | (bytes[i + 3] << 8) | bytes[i + 4]) >>> 0;
      } else {
        return null;
      }
    }
    if (len == null || i + hdr + len > bytes.length) return null;
    const body = bytes.subarray(i + hdr, i + hdr + len);
    if (tag === 6) return body;
    i += hdr + len;
  }
  return null;
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
//
// The result is cached per (fingerprint, variant, size) — chat-list re-renders
// rebuild every <velta-avatar> and the color-matrix math plus string assembly
// dominated that path. radius=0 callers (all of them today) skip the clipPath:
// it would be a no-op, and a cached string reused across many DOM insertions
// must not carry an id (duplicate-id clip-path references break when the
// first row owning the id unmounts).
// 🐴 ceiling: Elena's unsafeHTML still parses the cached string into DOM on
// every render; upgrade path if profiling shows that parse matters: return
// template-content clones instead of strings.
// Bounded (lru.js): 100 strings / 2 MB; a miss just rebuilds the string.
const svgCache = new LruCache({ maxItems: 100, maxBytes: 2 * 1024 * 1024 }); // cacheKey → svg string

// Grey of the same lightness: the tile keeps its pattern but carries no
// identity colors (no key behind it yet).
export function monoFill([r, g, b]) {
  const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const h = y.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

export function buildAvatarSvg({ groups, size = 120, radius = 26, withCaptions = false, badge = true, mono = false }) {
  if (!groups || groups.length !== 10) return "";
  const cacheKey = groups.join("") + `|${withCaptions ? 1 : 0}|${badge ? 1 : 0}|${radius}|${size}|${mono ? "m" : "c"}`;
  const cached = svgCache.get(cacheKey);
  if (cached) return cached;
  const chosen = {};
  const cells = groups.map((g, i) => {
    const [name, rgb] = (chosen[i] = colorForCell(groups, i, chosen));
    if (i < 3) return { x: i * 40, y: 0, w: 40, h: 30, name, rgb };
    if (i < 5) return { x: (i - 3) * 60, y: 30, w: 60, h: 30, name, rgb };
    if (i < 7) return { x: (i - 5) * 60, y: 60, w: 60, h: 30, name, rgb };
    return { x: (i - 7) * 40, y: 90, w: 40, h: 30, name, rgb };
  });
  const rects = cells.map((c) =>
    `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${mono ? monoFill(c.rgb) : c.name}"/>`).join("");
  // Color names only describe a real key's colors.
  const captions = (!withCaptions || mono) ? "" : cells.map((c) => {
    const base = c.w >= 40 ? 9 : 8;
    const fs = Math.min(base, (c.w - 4) / (c.name.length * 0.72)).toFixed(1);
    return `<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,sans-serif" font-weight="700" font-size="${fs}" fill="${contrastTextFor(c.rgb)}">${c.name}</text>`;
  }).join("");
  let overlay = "";
  if (!withCaptions && badge) {
    overlay = `<circle cx="60" cy="60" r="40" fill="${BADGE_DARK}"/>` +
      `<g transform="translate(31.2,31.2) scale(2.4)" stroke="${GLYPH_LIGHT}">${FINGERPRINT_PATHS}</g>`;
  }
  // clipPath only for radius > 0 (no current caller) — see the cache note above.
  const cid = radius > 0 ? `velta-av-${++clipSeq}` : null;
  const defs = cid ? `<defs><clipPath id="${cid}"><rect width="120" height="120" rx="${radius}"/></clipPath></defs>` : "";
  const clip = cid ? ` clip-path="url(#${cid})"` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 120 120" role="img">${defs}<g${clip}>${rects}${overlay}${captions}</g></svg>`;
  svgCache.set(cacheKey, svg);
  return svg;
}
let clipSeq = 0;

// Identity tiles as CSS backgrounds instead of inline SVG subtrees: a
// percent-encoded data URL costs zero child nodes per tile and skips
// Elena's per-render DOM parse entirely; the browser decodes and caches
// one image per unique fingerprint. Still vector — sharp at any size/DPR.
// Only the node-less grid/badge variants (no captions, no clipPath id).
// Bounded (lru.js): 100 data URLs / 2 MB (size = length*2).
const bgCache = new LruCache({ maxItems: 100, maxBytes: 2 * 1024 * 1024 }); // fingerprint+variant → data URL

export function avatarBackgroundUrl({ groups, badge = true, mono = false }) {
  if (!groups || groups.length !== 10) return "";
  const key = groups.join("") + (badge ? "|b" : "|g") + (mono ? "|m" : "");
  let url = bgCache.get(key);
  if (!url) {
    const svg = buildAvatarSvg({ groups, size: 120, radius: 0, badge, mono });
    if (!svg) return "";
    url = "data:image/svg+xml," + encodeURIComponent(svg);
    bgCache.set(key, url);
  }
  return url;
}

/* ---------- fingerprint lookup (wired by app.js to the active core) ---------- */
// Keyed by (accountId, contactId): contact ids are per-account, so switching
// accounts must not reuse — or wipe — another account's entries. A contact
// bound to its key never changes; entries are one short string each, so the
// LRU cap is generous (1000 contacts) — eviction only costs one refetch.
// Pending promises are never evicted (concurrent callers must share them).
const fprCache = new LruCache({ maxItems: 1000, maxBytes: Infinity, sizeOf: () => 0,
  canEvict: (p) => "value" in p }); // `${accountId}:${contactId}` -> Promise<fingerprint|null>
let fingerprintSource = null;
let fingerprintAccountId = null;
// (contactId) => address. Used when the tile was not given one, so a contact
// with no key yet hashes the address (stable across devices) instead of the
// per-database contact id.
let addrOf = null;
// () => OpenPGP fingerprint hex for contact 1. get_contact_encryption_info
// throws for SELF, so the real key comes from make_vcard (or a test stub).
let selfFingerprint = null;

export function setFingerprintSource(fn, accountId = null, extras = null) {
  fingerprintSource = fn;
  fingerprintAccountId = accountId;
  addrOf = typeof extras?.addrOf === "function" ? extras.addrOf : null;
  selfFingerprint = typeof extras?.selfFingerprint === "function" ? extras.selfFingerprint : null;
  // Greyscale stand-ins are not final: the profile may have been configured
  // or the contact's key may have arrived since. Ask again.
  for (const [k, p] of fprCache) if (p.derived) fprCache.delete(k);
}

export function cachedFingerprint(contactId) {
  const p = fprCache.get(`${fingerprintAccountId}:${contactId}`);
  return p ? p.value ?? null : null; // .value set once resolved (see below)
}

// True when the cached tile for this contact is NOT backed by a real key.
// Those tiles render in greyscale; the profile-key row shows "—".
export function cachedFingerprintIsDerived(contactId) {
  const p = fprCache.get(`${fingerprintAccountId}:${contactId}`);
  return !!(p && p.derived);
}

export function fingerprintFor(contactId, addr) {
  const key = `${fingerprintAccountId}:${contactId}`;
  const hit = fprCache.get(key);
  // Derived self is not final: make_vcard grows a KEY after configure.
  if (hit && !(contactId === 1 && hit.derived && hit.value)) return hit;
  if (!fingerprintSource || !contactId || contactId < 1) return Promise.resolve(null);
  const infoP = Promise.resolve().then(() => fingerprintSource(contactId)).catch(() => "");
  const whoP = (addr || !addrOf)
    ? Promise.resolve(addr || "")
    : Promise.resolve().then(() => addrOf(contactId)).then((a) => a || "").catch(() => "");
  const p = Promise.all([infoP, whoP]).then(async ([encrInfo, who]) => {
    // Core 2.66+ no longer prints addresses; our own key disambiguates.
    let own = null;
    if (contactId !== 1 && selfFingerprint && encrInfo && !String(encrInfo).includes(`(${who}`)) {
      own = await Promise.resolve().then(() => selfFingerprint()).catch(() => null);
    }
    const parsed = parseFingerprint(encrInfo, who, own);
    if (parsed) return parsed;
    if (contactId === 1 && selfFingerprint) {
      const own = await Promise.resolve().then(() => selfFingerprint()).catch(() => null);
      const hex = String(own || "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
      if (hex.length >= 40) return hex;
    }
    p.derived = true;
    return deriveFingerprint(who || "id:" + contactId);
  });
  fprCache.set(key, p);
  p.then((fpr) => { p.value = fpr; }, () => { p.value = null; });
  return p;
}
