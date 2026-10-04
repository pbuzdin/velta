// image-compress.js — outgoing photos → lossy WebP when it clearly pays (#81).
//
// Renderer-side only (createImageBitmap → canvas → WebP), no dependencies, no
// core changes. The core already recodes oversized images to JPEG q75; this
// does the same job at the same size limits with a ~25–35 % smaller result and
// strips EXIF as a side effect of re-encoding. Policy:
//
//  * Only STATIC JPEG, STATIC opaque WebP and OPAQUE PNG are candidates; format
//    is sniffed from the bytes, not trusted from a MIME type or extension.
//    GIF, animated WebP (byte-exact, see the core's is_animated_webp patch),
//    WebP/PNG with transparency, and everything unknown are never touched.
//  * Size gate: bytes must exceed min(MIN_BYTES, the core's limit for the
//    current Image quality) — small photos go out unchanged. Opaque PNG is
//    lossless and often a screenshot, so it is only converted when it exceeds
//    the core's byte limit, i.e. when the core would turn it into a lossy JPEG
//    anyway.
//  * When the original is over the core limit, the image is scaled to the
//    core's pixel budget (maxWh² pixels, the same rule as blob.rs) and the WebP
//    is accepted only if it fits the byte limit, so the core then leaves it
//    alone instead of recoding it a second time. Otherwise the original goes
//    out and the core does what it does today.
//  * Under the limit, the WebP must be at least MIN_SAVING (10 %) smaller than
//    the original, else the original is sent: no generation loss for nothing.
//  * Any failure (no createImageBitmap, WebP encode unsupported — WebKit falls
//    back to PNG —, decode error) sends the original.
//
// The pure decision helpers are exported for tests; compressImage() takes its
// browser primitives as injectable `deps`.

export const COMPRESS_KEY = "velta-compress-photos"; // "0" = off, unset = on
export const MIN_BYTES = 256 * 1024; // ~200–300 KB per the issue
export const MIN_SAVING = 0.9; // WebP must be <= 90 % of the original (under the core limit)
export const QUALITIES = [0.8, 0.65, 0.5]; // first fits => stop; ladder only when a byte limit must be met
export const MAX_INPUT_BYTES = 64 * 1024 * 1024; // don't decode absurd inputs in the renderer

// Mirrors core constants.rs (BALANCED_IMAGE_BYTES/SIZE, WORSE_*) for the
// "Image quality" drawer setting: "0" Standard, "1" Compact.
export function coreLimits(quality) {
  return String(quality) === "1"
    ? { maxBytes: 130_000, maxWh: 640 }
    : { maxBytes: 940_000, maxWh: 1760 };
}

export function compressEnabled() {
  try { return localStorage.getItem(COMPRESS_KEY) !== "0"; } catch { return true; }
}

// ---- sniffing ----

const ascii = (b, off, s) => {
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
  return true;
};

// → { format: "jpeg"|"png"|"webp"|"gif"|null, animated, alpha }
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const info = { format: null, animated: false, alpha: false };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    info.format = "jpeg";
  } else if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) {
    info.format = "png";
    info.alpha = pngHasAlpha(b);
    info.animated = pngIsAnimated(b);
  } else if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
    info.format = "webp";
    Object.assign(info, webpFlags(b));
  } else if (b.length >= 6 && (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) {
    info.format = "gif";
  }
  return info;
}

// Walk PNG chunks up to the first IDAT: color types 4/6 carry alpha, a tRNS
// chunk makes palette/gray/RGB transparent too.
function pngHasAlpha(b) {
  let pos = 8;
  let colorType = -1;
  while (pos + 8 <= b.length) {
    const len = ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]) >>> 0;
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (type === "IHDR" && pos + 8 + 10 <= b.length) colorType = b[pos + 8 + 9];
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") break;
    pos += 12 + len;
  }
  // Unreadable header: assume transparency (never transcode what we can't read).
  return colorType === -1 || colorType === 4 || colorType === 6;
}

function pngIsAnimated(b) {
  let pos = 8;
  while (pos + 8 <= b.length) {
    const len = ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]) >>> 0;
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") break;
    pos += 12 + len;
  }
  return false;
}

// WebP: VP8X flags (animation 0x02, alpha 0x10), an ANMF chunk in the first
// 4 KiB (same header sniff as the core), or a VP8L stream whose header says
// alpha_is_used. Plain "VP8 " (lossy, no alpha) is the only chunk that is
// definitely opaque and static.
function webpFlags(b) {
  const out = { animated: false, alpha: false };
  const head = Math.min(b.length, 4096);
  if (ascii(b, 12, "VP8X") && b.length > 20) {
    const flags = b[20];
    if (flags & 0x02) out.animated = true;
    if (flags & 0x10) out.alpha = true;
  }
  for (let i = 12; i + 4 <= head; i++) {
    if (ascii(b, i, "ANMF") || ascii(b, i, "ANIM")) { out.animated = true; break; }
  }
  if (ascii(b, 12, "VP8L") && b.length > 24 && b[20] === 0x2f) {
    // 0x2f signature, then 14+14 bits of size, then alpha_is_used (bit 28)
    if ((b[24] & 0x10) !== 0) out.alpha = true;
  }
  return out;
}

// ---- decision ----

// → { try: false, reason } | { try: true, limited, maxPixels, targetBytes }
export function decideTranscode({ bytes, info, quality = "0", enabled = true }) {
  const skip = reason => ({ try: false, reason });
  if (!enabled) return skip("disabled");
  if (!info?.format) return skip("unknown-format");
  if (info.format === "gif") return skip("gif");
  if (info.animated) return skip("animated");
  if (info.alpha) return skip("alpha");
  if (bytes > MAX_INPUT_BYTES) return skip("too-big");
  const { maxBytes, maxWh } = coreLimits(quality);
  const overCore = bytes > maxBytes;
  if (info.format === "png" && !overCore) return skip("png-lossless");
  if (bytes <= Math.min(MIN_BYTES, maxBytes)) return skip("small");
  return overCore
    ? { try: true, limited: true, maxPixels: maxWh * maxWh, targetBytes: maxBytes }
    : { try: true, limited: false, maxPixels: Infinity, targetBytes: null };
}

// Keep the smaller of the two. Over the core limit the bar is "fits the limit"
// (the core would otherwise recode the original); below it, a real saving.
export function webpWins(origBytes, webpBytes, plan) {
  if (!(webpBytes > 0)) return false;
  if (plan?.targetBytes != null) return webpBytes <= plan.targetBytes && webpBytes < origBytes;
  return webpBytes <= origBytes * MIN_SAVING;
}

// Target size for the pixel budget; never upscales.
export function scaledSize(w, h, maxPixels) {
  if (!(w > 0 && h > 0)) return { width: 1, height: 1 };
  const k = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export function webpName(name) {
  const base = String(name || "photo").replace(/\\/g, "/").split("/").pop().replace(/\.[^.]*$/, "");
  return (base || "photo") + ".webp";
}

// ---- browser primitives (default deps) ----

async function defaultDecode(blob) {
  if (typeof createImageBitmap !== "function") throw new Error("no createImageBitmap");
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
  catch { bmp = await createImageBitmap(blob); } // engines without the option (orientation then default)
  return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close?.() };
}

async function defaultEncode(decoded, width, height, quality) {
  if (typeof OffscreenCanvas === "function") {
    const c = new OffscreenCanvas(width, height);
    c.getContext("2d").drawImage(decoded.source, 0, 0, width, height);
    return c.convertToBlob({ type: "image/webp", quality });
  }
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  c.getContext("2d").drawImage(decoded.source, 0, 0, width, height);
  return new Promise(res => c.toBlob(res, "image/webp", quality));
}

// → { blob, name, transcoded, reason?, from?, to? } — always usable: on any
// problem it returns the input blob unchanged (transcoded: false).
export async function compressImage(blob, { name = null, quality = "0", enabled = true, deps = {} } = {}) {
  const decode = deps.decode || defaultDecode;
  const encode = deps.encode || defaultEncode;
  const same = reason => ({ blob, name, transcoded: false, reason });
  try {
    if (!enabled) return same("disabled");
    if (!blob || blob.size > MAX_INPUT_BYTES) return same("too-big");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = sniffImage(bytes);
    const plan = decideTranscode({ bytes: bytes.length, info, quality, enabled });
    if (!plan.try) return same(plan.reason);
    const decoded = await decode(blob);
    try {
      const { width, height } = scaledSize(decoded.width, decoded.height, plan.maxPixels);
      for (const q of plan.targetBytes != null ? QUALITIES : QUALITIES.slice(0, 1)) {
        const out = await encode(decoded, width, height, q);
        if (!out || out.type !== "image/webp") return same("no-webp-encoder");
        if (webpWins(bytes.length, out.size, plan)) {
          return { blob: out, name: webpName(name), transcoded: true, from: bytes.length, to: out.size };
        }
        // The quality ladder exists only to meet the core's byte limit; the
        // saving-gated case keeps one attempt (lower quality = visible loss).
        if (plan.targetBytes == null) break;
      }
      return same("not-smaller");
    } finally {
      decoded.close?.();
    }
  } catch (err) {
    return same("error:" + (err?.message || err));
  }
}
