// QR Code encoder with optimal mode segmentation.
//
// Port of Project Nayuki's QR Code generator (MIT, nayuki.io/page/qr-code-generator-library),
// the same library the chatmail core uses (qrcodegen crate). The core calls
// encode_text, which picks ONE mode for the whole string, so a link such as
// https://i.delta.chat/#<40 hex>&… ends up all in byte mode. makeSegmentsOptimally
// (Nayuki's QrSegmentAdvanced algorithm) splits the text into numeric /
// alphanumeric / byte runs instead: the payload stays byte-identical, the
// symbol often drops a version. Kanji mode is not used.

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const MODE = {
  numeric: { bits: 0x1, cc: [10, 12, 14] },
  alnum: { bits: 0x2, cc: [9, 11, 13] },
  byte: { bits: 0x4, cc: [8, 16, 16] },
};
const MODES = [MODE.byte, MODE.alnum, MODE.numeric];
const ccBits = (mode, ver) => mode.cc[ver <= 9 ? 0 : ver <= 26 ? 1 : 2];

// Ecc: [ordinal, format bits]
export const Ecc = { LOW: [0, 1], MEDIUM: [1, 0], QUARTILE: [2, 3], HIGH: [3, 2] };
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const utf8 = s => new TextEncoder().encode(s);
const isNum = c => c >= "0" && c <= "9";
const isAlnum = c => ALNUM.includes(c);

function push(bits, val, len) { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }

/** One segment: { mode, numChars, data: bit array }. */
function makeSeg(mode, text) {
  const data = [];
  if (mode === MODE.numeric) {
    for (let i = 0; i < text.length; i += 3) { const n = Math.min(3, text.length - i); push(data, Number(text.slice(i, i + n)), n * 3 + 1); }
    return { mode, numChars: text.length, data };
  }
  if (mode === MODE.alnum) {
    let i = 0;
    for (; i + 1 < text.length; i += 2) push(data, ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
    if (i < text.length) push(data, ALNUM.indexOf(text[i]), 6);
    return { mode, numChars: text.length, data };
  }
  const b = utf8(text);
  for (const x of b) push(data, x, 8);
  return { mode, numChars: b.length, data };
}

/** What the core does (qrcodegen encode_text): one mode for the whole text. */
export function makeSegmentsSimple(text) {
  if (text === "") return [];
  const cs = [...text];
  if (cs.every(isNum)) return [makeSeg(MODE.numeric, text)];
  if (cs.every(isAlnum)) return [makeSeg(MODE.alnum, text)];
  return [makeSeg(MODE.byte, text)];
}

function totalBits(segs, ver) {
  let n = 0;
  for (const s of segs) {
    const cc = ccBits(s.mode, ver);
    if (s.numChars >= 1 << cc) return Infinity;
    n += 4 + cc + s.data.length;
  }
  return n;
}

/** Optimal segmentation for one version's char-count widths (costs in 1/6 bit). */
export function makeSegmentsForVersion(text, ver) {
  const cps = [...text];
  if (!cps.length) return [];
  const head = MODES.map(m => (4 + ccBits(m, ver)) * 6);
  let prev = head.slice();
  const charModes = [];
  for (const c of cps) {
    const cur = [Infinity, Infinity, Infinity];
    const cm = [null, null, null];
    cur[0] = prev[0] + utf8(c).length * 8 * 6; cm[0] = MODES[0];
    if (isAlnum(c)) { cur[1] = prev[1] + 33; cm[1] = MODES[1]; }
    if (isNum(c)) { cur[2] = prev[2] + 20; cm[2] = MODES[2]; }
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        const cost = Math.ceil(cur[k] / 6) * 6 + head[j];
        if (cm[k] !== null && (cm[j] === null || cost < cur[j])) { cur[j] = cost; cm[j] = cm[k]; }
      }
    }
    charModes.push(cm);
    prev = cur;
  }
  let curIdx = prev.indexOf(Math.min(...prev));
  const modes = new Array(cps.length);
  for (let i = cps.length - 1; i >= 0; i--) {
    const m = charModes[i][curIdx];
    modes[i] = m;
    curIdx = MODES.indexOf(m);
  }
  const segs = [];
  let start = 0;
  for (let i = 1; i <= cps.length; i++) {
    if (i === cps.length || modes[i] !== modes[start]) {
      segs.push(makeSeg(modes[start], cps.slice(start, i).join("")));
      start = i;
    }
  }
  return segs;
}

const rawModules = ver => {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const na = Math.floor(ver / 7) + 2; r -= (25 * na - 10) * na - 55; if (ver >= 7) r -= 36; }
  return r;
};
const dataCodewords = (ver, ecl) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl[0]][ver] * NUM_BLOCKS[ecl[0]][ver];

function rsMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(deg) {
  const r = new Array(deg).fill(0); r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) { r[j] = rsMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
    root = rsMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= rsMul(c, f); });
  }
  return r;
}

const MASKS = [
  (x, y) => (x + y) % 2, (x, y) => y % 2, x => x % 3, (x, y) => (x + y) % 3,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2, (x, y) => (x * y) % 2 + (x * y) % 3,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2,
];

function buildMatrix(ver, ecl, codewords, mask) {
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  let align = [];
  if (ver > 1) {
    const na = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.floor((ver * 4 + na * 2 + 1) / (na * 2 - 2)) * 2;
    align = [6];
    for (let i = 0; i < na - 1; i++) align.splice(1, 0, size - 7 - i * step);
  }
  const na = align.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const formatBits = m => {
    const data = (ecl[1] << 3) | m;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = i => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, true);
  };
  formatBits(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = ver * 4096 + rem;
    for (let i = 0; i < 18; i++) {
      const d = Math.floor(bits / 2 ** i) % 2 === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, d); set(b, a, d);
    }
  }
  // ECC + interleave
  const nb = NUM_BLOCKS[ecl[0]][ver], eccLen = ECC_PER_BLOCK[ecl[0]][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = codewords.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((blk, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(blk[i]); });
  // zigzag placement
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && bi < all.length * 8) { mod[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
    }
  }
  const applyMask = m => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y) === 0) mod[y][x] = !mod[y][x];
  };
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); formatBits(m);
      const p = penalty(mod, size);
      if (p < best) { best = p; mask = m; }
      applyMask(m);
    }
  }
  applyMask(mask); formatBits(mask);
  return { mod, mask };
}

function penalty(mod, size) {
  let result = 0;
  const line = get => {
    let color = false, run = 0;
    let hist = [0, 0, 0, 0, 0, 0, 0];
    const add = r => { if (hist[0] === 0) r += size; hist = [r, ...hist.slice(0, 6)]; };
    const count = () => {
      const n = hist[1];
      const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
      return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      if (get(i) === color) { run++; if (run === 5) result += 3; else if (run > 5) result++; }
      else { add(run); if (!color) result += count() * 40; color = get(i); run = 1; }
    }
    if (color) { add(run); run = 0; }
    add(run + size);
    result += count() * 40;
  };
  for (let y = 0; y < size; y++) line(x => mod[y][x]);
  for (let x = 0; x < size; x++) line(y => mod[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (mod[y][x]) dark++;
    if (x < size - 1 && y < size - 1) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) result += 3; }
  }
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

/**
 * Encodes text. Options: ecl (default Ecc.MEDIUM, boosted when free, as in
 * the core), optimal (default true; false = the core's single-mode choice),
 * mask (-1 = auto). Returns { version, size, ecl, mask, segments, get(x, y) }.
 */
export function encodeQr(text, { ecl = Ecc.MEDIUM, optimal = true, mask = -1, boostEcl = true } = {}) {
  text = String(text);
  let ver, segs, used;
  const cache = new Map();
  for (ver = 1; ver <= 40; ver++) {
    const group = ver <= 9 ? 9 : ver <= 26 ? 26 : 40;
    if (!cache.has(group)) cache.set(group, optimal ? makeSegmentsForVersion(text, group) : makeSegmentsSimple(text));
    segs = cache.get(group);
    used = totalBits(segs, ver);
    if (used <= dataCodewords(ver, ecl) * 8) break;
  }
  if (ver > 40) throw new RangeError("Data too long for a QR code");
  if (boostEcl) for (const e of [Ecc.MEDIUM, Ecc.QUARTILE, Ecc.HIGH]) if (used <= dataCodewords(ver, e) * 8) ecl = e;
  const bits = [];
  for (const s of segs) { push(bits, s.mode.bits, 4); push(bits, s.numChars, ccBits(s.mode, ver)); bits.push(...s.data); }
  const cap = dataCodewords(ver, ecl) * 8;
  push(bits, 0, Math.min(4, cap - bits.length));
  push(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(bits, pad, 8);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cw.push(b); }
  const { mod, mask: m } = buildMatrix(ver, ecl, cw, mask);
  const size = ver * 4 + 17;
  const modeName = s => (s.mode === MODE.byte ? "byte" : s.mode === MODE.alnum ? "alnum" : "numeric");
  return {
    version: ver, size, ecl: ["L", "M", "Q", "H"][ecl[0]], mask: m, bits: used,
    segments: segs.map(s => ({ mode: modeName(s), chars: s.numChars })),
    get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && mod[y][x],
  };
}

/** The core's module path ("M{x},{y}h1v1h-1z" per dark module). */
export function qrPathData(qr) {
  let d = "";
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) d += `M${x},${y}h1v1h-1z`;
  return d;
}

/** Plain QR SVG (white quiet zone of 4 modules), for callers without a core SVG. */
export function qrSvg(text, opts) {
  const qr = encodeQr(text, opts);
  const n = qr.size + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path transform="translate(4,4)" fill="#000" d="${qrPathData(qr)}"/></svg>`;
}

const CORE_PATH = /<path style="fill:#000000" d="([^"]*)" transform="scale\(([0-9.eE+-]+)\)"\s*\/?>(?:<\/path>)?/;

/**
 * Swaps the module path in an SVG the core rendered (create_qr_svg,
 * get_chat_securejoin_qr_code_svg) for an optimally segmented encoding of
 * the same text, keeping the core's card, logo and caption. The QR keeps its
 * pixel size; only the module count changes. Returns the core SVG unchanged
 * when it doesn't look like the core's layout or encoding fails.
 */
export function reencodeCoreQrSvg(svg, text) {
  try {
    const m = CORE_PATH.exec(svg || "");
    if (!m) return svg;
    let oldSize = 0;
    for (const mm of m[1].matchAll(/M(\d+),\d+/g)) oldSize = Math.max(oldSize, Number(mm[1]) + 1);
    if (!oldSize) return svg;
    const px = oldSize * Number(m[2]);
    const qr = encodeQr(text);
    if (qr.size > oldSize) return svg; // same size still wins: fewer bits can boost the ECC level
    const path = `<path style="fill:#000000" d="${qrPathData(qr)}" transform="scale(${+(px / qr.size).toFixed(6)})"/>`;
    return svg.replace(m[0], () => path);
  } catch {
    return svg;
  }
}

// create_qr_svg (512x512, QR 416 at 48,48) ends with the Delta Chat logo
// group, a 96px badge dead-centre. Swap it for the Velta logo on a dark
// disc inside a white ring (quiet zone so the finder-free centre still
// reads; ~6% of the QR area, well under the Medium-or-better ECC budget).
const CORE_LOGO = /<g transform="translate\(208,208\) scale\(2\)">[\s\S]*<\/g>(\s*<\/svg>\s*)$/;
export const VELTA_QR_LOGO = '<g data-velta-logo><circle cx="256" cy="256" r="56" fill="#fff"/><circle cx="256" cy="256" r="48" fill="#1c1c1c"/><image href="./icons/v-logo.svg" x="214" y="216" width="84" height="84"/></g>';
export function brandCoreQrSvg(svg) {
  if (!svg || !CORE_LOGO.test(svg)) return svg;
  return svg.replace(CORE_LOGO, (_, tail) => VELTA_QR_LOGO + tail);
}
