import test from "node:test";
import assert from "node:assert/strict";
import {
  sniffImage, decideTranscode, webpWins, scaledSize, scaledSideCap, webpName, coreLimits, compressImage, cropFitScale,
  MIN_BYTES, MIN_SAVING, COMPRESS_KEY, RESIZE_KEY, RESIZE_JPEG_QUALITY,
} from "../app/js/image-compress.js";

// #81: outgoing photos → lossy WebP only when it clearly pays. Everything here
// is the pure policy plus compressImage() driven by fake decode/encode deps.

const KB = 1024;
const bytesOf = (...parts) => Uint8Array.from(parts.flatMap(p => typeof p === "string" ? [...p].map(c => c.charCodeAt(0)) : p));
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

const jpeg = (extra = 0) => bytesOf([0xff, 0xd8, 0xff, 0xe0], new Array(extra).fill(0));
const gif = () => bytesOf("GIF89a", [1, 0, 1, 0]);
function png(colorType, { trns = false } = {}) {
  const ihdr = [...u32(13), ..."IHDR".split("").map(c => c.charCodeAt(0)), ...u32(1), ...u32(1), 8, colorType, 0, 0, 0, 0, 0, 0, 0];
  const out = [0x89, ...bytesOf("PNG\r\n\x1a\n").slice(0, 7), ...ihdr];
  if (trns) out.push(...u32(1), ...bytesOf("tRNS"), 0, 0, 0, 0, 0);
  out.push(...u32(0), ...bytesOf("IDAT"), 0, 0, 0, 0);
  return Uint8Array.from(out);
}
const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngFile(colorType, opts) { const p = png(colorType, opts); p.set(pngSig, 0); return p; }
// RIFF....WEBP + one chunk
function webp(fourcc, payload) {
  return bytesOf("RIFF", le32(4 + 8 + payload.length), "WEBP", fourcc, le32(payload.length), payload);
}
const webpLossy = () => webp("VP8 ", new Array(20).fill(0));
const webpVp8x = flags => webp("VP8X", [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const webpAnimatedChunk = () => bytesOf("RIFF", le32(100), "WEBP", "VP8X", le32(10), [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0], "ANIM", le32(6), [0, 0, 0, 0, 0, 0], "ANMF", le32(4), [0, 0, 0, 0]);
const webpLosslessAlpha = alpha => webp("VP8L", [0x2f, 0, 0, 0, alpha ? 0x10 : 0, 0, 0, 0]);

test("sniffImage: formats come from bytes, not extensions", () => {
  assert.equal(sniffImage(jpeg()).format, "jpeg");
  assert.equal(sniffImage(gif()).format, "gif");
  assert.equal(sniffImage(pngFile(2)).format, "png");
  assert.equal(sniffImage(webpLossy()).format, "webp");
  assert.equal(sniffImage(bytesOf("hello world, not an image")).format, null);
  assert.equal(sniffImage(new Uint8Array(0)).format, null);
});

test("sniffImage: PNG alpha — color types 4/6, tRNS chunk; opaque RGB/gray/palette are fine", () => {
  assert.equal(sniffImage(pngFile(6)).alpha, true);
  assert.equal(sniffImage(pngFile(4)).alpha, true);
  assert.equal(sniffImage(pngFile(2, { trns: true })).alpha, true);
  assert.equal(sniffImage(pngFile(3, { trns: true })).alpha, true);
  assert.equal(sniffImage(pngFile(2)).alpha, false);
  assert.equal(sniffImage(pngFile(0)).alpha, false);
  assert.equal(sniffImage(pngFile(3)).alpha, false);
  // truncated header: assume transparency rather than transcode blindly
  assert.equal(sniffImage(Uint8Array.from(pngSig)).alpha, true);
});

test("sniffImage: WebP animated / alpha detection", () => {
  assert.equal(sniffImage(webpLossy()).animated, false);
  assert.equal(sniffImage(webpLossy()).alpha, false);
  assert.equal(sniffImage(webpVp8x(0x02)).animated, true);
  assert.equal(sniffImage(webpVp8x(0x10)).alpha, true);
  assert.equal(sniffImage(webpVp8x(0)).animated, false);
  assert.equal(sniffImage(webpAnimatedChunk()).animated, true);
  assert.equal(sniffImage(webpLosslessAlpha(true)).alpha, true);
  assert.equal(sniffImage(webpLosslessAlpha(false)).alpha, false);
});

test("coreLimits mirror the core's Image quality constants", () => {
  assert.deepEqual(coreLimits("0"), { maxBytes: 940_000, maxWh: 1760 });
  assert.deepEqual(coreLimits("1"), { maxBytes: 130_000, maxWh: 640 });
  assert.deepEqual(coreLimits(undefined), { maxBytes: 940_000, maxWh: 1760 });
});

const info = (format, extra = {}) => ({ format, animated: false, alpha: false, ...extra });

test("decideTranscode: size gate (Standard)", () => {
  const d = bytes => decideTranscode({ bytes, info: info("jpeg"), quality: "0" });
  assert.equal(d(40 * KB).try, false);          // 40 KB JPEG → unchanged
  assert.equal(d(40 * KB).reason, "small");
  assert.equal(d(MIN_BYTES).try, false);        // exactly at the threshold: not above it
  assert.equal(d(MIN_BYTES + 1).try, true);
  const mid = d(600 * KB);
  assert.deepEqual([mid.try, mid.limited, mid.targetBytes], [true, false, null]);
  const big = d(3 * 1024 * KB);                 // 3 MB: the core would recode it
  assert.deepEqual([big.try, big.limited, big.targetBytes, big.maxPixels], [true, true, 940_000, 1760 * 1760]);
});

test("decideTranscode: Compact quality lowers the gate to the core's 130 KB", () => {
  const d = bytes => decideTranscode({ bytes, info: info("jpeg"), quality: "1" });
  assert.equal(d(100_000).try, false);
  const r = d(200_000); // above 130 KB, below 256 KiB: the core would recode it anyway
  assert.deepEqual([r.try, r.limited, r.targetBytes, r.maxPixels], [true, true, 130_000, 640 * 640]);
});

test("decideTranscode: skip list", () => {
  const big = 2 * 1024 * KB;
  const why = (i, extra = {}) => decideTranscode({ bytes: big, info: i, ...extra });
  assert.equal(why(info("gif")).reason, "gif");
  assert.equal(why(info("webp", { animated: true })).reason, "animated");
  assert.equal(why(info("png", { animated: true })).reason, "animated");
  assert.equal(why(info("webp", { alpha: true })).reason, "alpha");
  assert.equal(why(info("png", { alpha: true })).reason, "alpha");
  assert.equal(why(info(null)).reason, "unknown-format");
  assert.equal(why(info("jpeg"), { enabled: false }).reason, "disabled");
  assert.equal(decideTranscode({ bytes: 80 * 1024 * KB, info: info("jpeg") }).reason, "too-big");
});

test("decideTranscode: opaque PNG only when the core would recode it to JPEG anyway", () => {
  const p = bytes => decideTranscode({ bytes, info: info("png") });
  assert.equal(p(600 * KB).reason, "png-lossless"); // screenshot-sized: stays lossless PNG
  assert.equal(p(2000 * KB).try, true);              // over 940 KB: WebP beats the core's JPEG
  assert.equal(p(2000 * KB).targetBytes, 940_000);
});

test("static WebP above the threshold is a candidate", () => {
  assert.equal(decideTranscode({ bytes: 500 * KB, info: info("webp") }).try, true);
});

test("webpWins: keep the smaller", () => {
  const free = { targetBytes: null };
  assert.equal(webpWins(1000, 600, free), true);
  assert.equal(webpWins(1000, 900, free), true);               // exactly the 10 % bar
  assert.equal(webpWins(1000, 901, free), false);
  assert.equal(webpWins(1000, 1200, free), false);
  assert.equal(webpWins(1000, 0, free), false);
  assert.equal(MIN_SAVING, 0.9);
  const limited = { targetBytes: 940_000 };
  assert.equal(webpWins(3_000_000, 500_000, limited), true);
  assert.equal(webpWins(3_000_000, 940_000, limited), true);
  assert.equal(webpWins(3_000_000, 940_001, limited), false);  // would be recoded again by the core
  assert.equal(webpWins(930_000, 935_000, { targetBytes: 130_000 }), false);
});

test("scaledSize follows the core's pixel budget and never upscales", () => {
  const s = scaledSize(4000, 3000, 1760 * 1760);
  assert.ok(s.width * s.height <= 1760 * 1760 * 1.001);
  assert.ok(Math.abs(s.width / s.height - 4 / 3) < 0.01);
  assert.deepEqual(scaledSize(800, 600, 1760 * 1760), { width: 800, height: 600 });
  assert.deepEqual(scaledSize(800, 600, Infinity), { width: 800, height: 600 });
  assert.deepEqual(scaledSize(0, 0, 100), { width: 1, height: 1 });
});

test("webpName", () => {
  assert.equal(webpName("IMG_0001.JPG"), "IMG_0001.webp");
  assert.equal(webpName("a/b\\c.photo.jpeg"), "c.photo.webp");
  assert.equal(webpName(null), "photo.webp");
  assert.equal(webpName(".jpg"), "photo.webp");
});

// ---- compressImage with fake browser primitives ----

function blobOf(bytes, type = "image/jpeg") {
  return { size: bytes.length, type, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
}
const big = (n, head = jpeg()) => { const b = new Uint8Array(n); b.set(head); return b; };
function fakes({ w = 4000, h = 3000, sizes = [300_000], type = "image/webp", fail = null } = {}) {
  const calls = { decode: 0, encode: [], closed: 0 };
  return {
    calls,
    deps: {
      decode: async () => { calls.decode++; if (fail === "decode") throw new Error("boom"); return { width: w, height: h, close: () => calls.closed++ }; },
      encode: async (_d, width, height, q, outType) => {
        calls.encode.push({ width, height, q, type: outType });
        const size = sizes[Math.min(calls.encode.length - 1, sizes.length - 1)];
        return { size, type: outType || type };
      },
    },
  };
}

test("compressImage: 3 MB JPEG → WebP that fits the core limit, scaled to its pixel budget", async () => {
  const f = fakes({ sizes: [420_000] });
  const r = await compressImage(blobOf(big(3_000_000)), { name: "IMG_1.jpg", quality: "0", deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.equal(r.name, "IMG_1.webp");
  assert.equal(r.blob.type, "image/webp");
  assert.equal(f.calls.encode.length, 1);
  assert.equal(f.calls.encode[0].q, 0.8);
  assert.ok(f.calls.encode[0].width * f.calls.encode[0].height <= 1760 * 1760 * 1.001);
  assert.equal(f.calls.closed, 1);
});

test("compressImage: climbs the quality ladder only to fit the byte limit, then gives up", async () => {
  const f = fakes({ sizes: [1_200_000, 800_000] });
  const r = await compressImage(blobOf(big(3_000_000)), { deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.deepEqual(f.calls.encode.map(e => e.q), [0.8, 0.65]);
  const g = fakes({ sizes: [2_000_000] });
  const r2 = await compressImage(blobOf(big(3_000_000)), { deps: g.deps });
  assert.equal(r2.transcoded, false);
  assert.equal(r2.reason, "not-smaller");
  assert.deepEqual(g.calls.encode.map(e => e.q), [0.8, 0.65, 0.5]);
});

test("compressImage: 40 KB JPEG is returned unchanged and never decoded", async () => {
  const f = fakes();
  const input = blobOf(big(40 * KB));
  const r = await compressImage(input, { deps: f.deps });
  assert.equal(r.transcoded, false);
  assert.equal(r.blob, input);
  assert.equal(f.calls.decode, 0);
});

test("compressImage: animated WebP and GIF stay byte-exact; alpha only rescues on the 2k cap", async () => {
  const f = fakes();
  // Animated/unknown: never touched, not even decoded.
  for (const head of [webpAnimatedChunk(), webpVp8x(0x02), gif(), bytesOf("not-an-image")]) {
    const input = blobOf(big(2_000_000, head), "image/whatever");
    const r = await compressImage(input, { deps: f.deps });
    assert.equal(r.transcoded, false);
    assert.equal(r.blob, input);
  }
  assert.equal(f.calls.decode, 0);
  // Codec-only mode (resize off): transparency is never converted for size
  // alone — the old #509 rule stands there.
  for (const head of [pngFile(6), webpVp8x(0x10)]) {
    const input = blobOf(big(2_000_000, head), "image/whatever");
    const r = await compressImage(input, { resize: false, deps: f.deps });
    assert.equal(r.transcoded, false);
    assert.equal(r.blob, input);
  }
  // 2k on: an oversized transparent PNG is RESCUED — WebP keeps alpha, the
  // bar is "smaller" (#560 follow-up).
  const g = fakes({ sizes: [300_000] });
  const r = await compressImage(blobOf(big(2_000_000, pngFile(6))), { name: "shot.png", deps: g.deps });
  assert.equal(r.transcoded, true);
  assert.equal(r.name, "shot.webp");
  assert.equal(r.blob.type, "image/webp");
  assert.deepEqual([g.calls.encode[0].width, g.calls.encode[0].height], [2048, 1536]);
  assert.equal(g.calls.encode[0].q, 0.8);
  // …and a transparent image already within 2k stays byte-exact.
  const w2k = fakes({ w: 1500, h: 1000 });
  const in2k = blobOf(big(2_000_000, pngFile(6)), "image/png");
  const r2 = await compressImage(in2k, { deps: w2k.deps });
  assert.equal(r2.transcoded, false);
  assert.equal(r2.blob, in2k);
  assert.equal(r2.reason, "within-2k");
});

test("compressImage: moderate JPEG needs a 10 % saving, else the original is sent", async () => {
  const f = fakes({ w: 1200, h: 900, sizes: [550_000] });
  const input = blobOf(big(600_000));
  const r = await compressImage(input, { deps: f.deps });
  assert.equal(r.transcoded, false);
  assert.equal(r.reason, "not-smaller");
  assert.equal(r.blob, input);
  assert.equal(f.calls.encode.length, 1); // no ladder without a byte limit
  assert.deepEqual([f.calls.encode[0].width, f.calls.encode[0].height], [1200, 900]); // not rescaled
  const g = fakes({ w: 1200, h: 900, sizes: [400_000] });
  assert.equal((await compressImage(blobOf(big(600_000)), { deps: g.deps })).transcoded, true);
});

test("compressImage: toggle off is byte-exact and does no work", async () => {
  const f = fakes();
  const input = blobOf(big(3_000_000));
  const r = await compressImage(input, { enabled: false, deps: f.deps });
  assert.equal(r.transcoded, false);
  assert.equal(r.blob, input);
  assert.equal(r.reason, "disabled");
  assert.equal(f.calls.decode, 0);
});

test("compressImage: encoders without WebP support (PNG fallback) and errors keep the original", async () => {
  const input = blobOf(big(3_000_000));
  assert.equal((await compressImage(input, { deps: fakes({ type: "image/png" }).deps })).reason, "no-webp-encoder");
  const r = await compressImage(input, { deps: fakes({ fail: "decode" }).deps });
  assert.equal(r.transcoded, false);
  assert.match(r.reason, /^error:boom/);
  assert.equal(r.blob, input);
});

test("compressImage: Compact quality uses the 640² budget and 130 KB limit", async () => {
  const f = fakes({ sizes: [100_000] });
  const r = await compressImage(blobOf(big(200_000)), { quality: "1", deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.ok(f.calls.encode[0].width * f.calls.encode[0].height <= 640 * 640 * 1.001);
});

test("the setting keys are the ones the drawer and the strip write", async () => {
  const fs = await import("node:fs");
  assert.equal(COMPRESS_KEY, "velta-compress-photos");
  assert.equal(RESIZE_KEY, "velta-resize-photos");
  const ui = fs.readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.ok(ui.includes('"velta-compress-photos"'));
  assert.ok(ui.includes("Compress photos to save relay space"));
  const st = fs.readFileSync(new URL("../app/js/settings-transfer.js", import.meta.url), "utf8");
  assert.ok(st.includes('"velta-resize-photos"'), "the 2k row exists in Settings");
  const cv = fs.readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(cv, /compressImage\(pm\.blob/);
  assert.match(cv, /compressEnabled\(\)/);
});

test("cropFitScale: fits the measured box, never upscales", () => {
  assert.equal(cropFitScale(4000, 3000, 400, 320), 0.1);
  assert.equal(cropFitScale(1920, 1080, 2000, 1200), 1, "never upscales");
  assert.equal(cropFitScale(1080, 1920, 384, 800), 384 / 1080, "portrait binds on width");
  assert.equal(cropFitScale(1000, 100, 500, 500), 0.5, "the long side binds");
  assert.equal(cropFitScale(0, 100, 500, 500), 1, "degenerate inputs fall back to 1");
  assert.equal(cropFitScale(100, 100, 0, 0), 1);
});

// ---- HEIC ----
// The Android WebView cannot decode HEIC, so a HEIC pick went out as a
// generic file with no preview. Android now converts it at pick time with the
// platform decoder (convert_heic_photo); where the WebView can decode HEIC
// (macOS, Windows with the HEIF codec) the compressor does it, always within
// the core's budget because the core cannot recode HEIC.
const heic = (brand = "heic", extra = 0) => bytesOf([0, 0, 0, 24], "ftyp", brand, [0, 0, 0, 0], "mif1", brand, new Array(extra).fill(0));

test("sniffImage: HEIC/HEIF by ftyp brand; AVIF is not HEIC", () => {
  for (const b of ["heic", "heix", "hevc", "hevx", "mif1", "msf1"]) assert.equal(sniffImage(heic(b)).format, "heic", b);
  assert.equal(sniffImage(heic("avif")).format, null, "AVIF decodes everywhere and keeps its own path");
  assert.equal(sniffImage(bytesOf("ftyp", "heic")).format, null, "ftyp has to sit at byte 4");
});

test("decideTranscode: HEIC always converts, inside the core's budget, with no size gate", () => {
  const s = coreLimits("0");
  // 150 KB is under every gate for JPEG and PNG, yet an unconverted HEIC is a file to most receivers.
  assert.deepEqual(decideTranscode({ bytes: 150_000, info: info("heic"), quality: "0" }), { try: true, limited: true, maxPixels: s.maxWh * s.maxWh, targetBytes: s.maxBytes });
  const c = coreLimits("1");
  assert.deepEqual(decideTranscode({ bytes: 4_000_000, info: info("heic", { alpha: true }), quality: "1" }), { try: true, limited: true, maxPixels: c.maxWh * c.maxWh, targetBytes: c.maxBytes }, "transparency is kept; Compact uses its own budget");
  assert.equal(decideTranscode({ bytes: 150_000, info: info("heic"), enabled: false }).reason, "disabled", "Compress photos off: the original HEIC");
});

test("compressImage: HEIC becomes WebP that fits the core limit; a WebView without a HEIC decoder keeps the original", async () => {
  const f = fakes({ sizes: [500_000] });
  const r = await compressImage(blobOf(big(2_500_000, heic("heic")), "image/heic"), { name: "IMG_0142.HEIC", quality: "0", deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.equal(r.name, "IMG_0142.webp");
  assert.equal(r.blob.type, "image/webp");
  assert.equal(f.calls.encode[0].q, 0.8);
  assert.ok(f.calls.encode[0].width * f.calls.encode[0].height <= 1760 * 1760 * 1.001, "scaled to the core's pixel budget");
  // Android's WebView: createImageBitmap throws, the original is returned untouched.
  const no = fakes({ fail: "decode" });
  const orig = blobOf(big(2_500_000, heic()), "image/heic");
  const kept = await compressImage(orig, { name: "IMG_0142.HEIC", deps: no.deps });
  assert.equal(kept.blob, orig);
  assert.equal(kept.transcoded, false);
  assert.match(kept.reason, /^error:/);
});

test("HEIC picks are converted on Android, and elsewhere count as photos only when the WebView can show them", async () => {
  const fs = await import("node:fs");
  const read = p => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
  const cv = read("app/js/chat-view.js");
  assert.match(cv, /resolved = \(await this\._heicToPhoto\(resolved, picked\)\) \|\| resolved;/, "the picker converts a staged HEIC before classifying it");
  assert.match(cv, /path = \(await this\._heicToPhoto\(path, file\)\) \|\| path;/, "share-in does the same");
  assert.match(cv, /invoke\("convert_heic_photo", \{ uri: contentUri, filename: name \}\)/);
  assert.match(cv, /\(kind === "image" && !heic\) \|\| isImage/, "a HEIC the WebView cannot decode is not staged as a photo");
  assert.match(cv, /heic && await this\._imageDecodes\(resolved\)/);
  const rust = read("velta-app/src-tauri/src/lib.rs");
  assert.match(rust, /convert_heic_photo, prep_backup/, "the command is registered");
  assert.match(rust, /\("HeicPhotos", &APP_HEIC_PHOTOS_CLASS\)/, "the Kotlin class is cached at startup");
  const kt = read("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/HeicPhotos.kt");
  assert.match(kt, /ImageDecoder\.decodeBitmap/, "the platform decoder; it applies the stored orientation");
  assert.match(kt, /else Bitmap\.CompressFormat\.JPEG/, "a photo becomes JPEG; transparency needs PNG");
  assert.match(kt, /bitmap\.compress\(format, 95, out\)/, "full quality: the crop and the Send-time budget work on the whole picture");
  assert.match(kt, /Build\.VERSION_CODES\.P/, "Android 8 and older cannot decode HEIC: the original is sent");
  assert.match(kt, /MAX_PIXELS = 24_000_000L/, "a 108 or 200 megapixel shot is sampled down before it is decoded");
  assert.match(kt, /catch \(_: OutOfMemoryError\)/, "a failed decode sends the original instead of crashing");
});

// ---- the 2k resize setting (independent of the WebP setting) ----

test("scaledSideCap: longest side never exceeds 2k, never upscales", () => {
  assert.deepEqual(scaledSideCap(4000, 3000), { width: 2048, height: 1536, scaled: true });
  assert.deepEqual(scaledSideCap(8000, 1000), { width: 2048, height: 256, scaled: true });
  assert.deepEqual(scaledSideCap(1000, 500), null);
  assert.deepEqual(scaledSideCap(2048, 1536), null);
});

test("compressImage: WebP off + resize on → oversized JPEG re-encodes as JPEG at 2k", async () => {
  const f = fakes({ w: 4000, h: 3000, sizes: [800_000], type: "image/jpeg" });
  const r = await compressImage(blobOf(big(3_000_000)), { name: "IMG_1.jpg", webp: false, deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.equal(r.name, "IMG_1.jpg", "keeps its name and extension");
  assert.deepEqual([f.calls.encode[0].width, f.calls.encode[0].height], [2048, 1536]);
  assert.equal(f.calls.encode[0].q, RESIZE_JPEG_QUALITY);
  assert.equal(f.calls.encode.length, 1, "one shot, no ladder");
});

test("compressImage: WebP off, image already within 2k → untouched", async () => {
  const f = fakes({ w: 1200, h: 900 });
  const input = blobOf(big(600_000));
  const r = await compressImage(input, { webp: false, deps: f.deps });
  assert.equal(r.transcoded, false);
  assert.equal(r.reason, "within-2k");
  assert.equal(r.blob, input);
  assert.equal(f.calls.encode.length, 0, "nothing re-encoded");
});

test("compressImage: WebP off resizes in the SAME format — alpha kept, GIF/unknown refused", async () => {
  // GIF and unknown formats are still refused outright.
  for (const bytes of [gif(), bytesOf("not-an-image")]) {
    const f = fakes({});
    const r = await compressImage(blobOf(bytes), { webp: false, deps: f.deps });
    assert.equal(r.transcoded, false, bytes.length + " bytes");
    assert.equal(f.calls.decode, 0);
  }
  // Oversized alpha PNG over 2k: PNG → PNG resample, alpha natively kept,
  // name unchanged (no codec change when WebP is off).
  const f = fakes({ sizes: [300_000] });
  const r = await compressImage(blobOf(big(2_000_000, pngFile(6)), "image/png"), { name: "shot.png", webp: false, deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.equal(r.blob.type, "image/png");
  assert.equal(r.name, "shot.png");
  assert.equal(f.calls.encode[0].type, "image/png");
  assert.deepEqual([f.calls.encode[0].width, f.calls.encode[0].height], [2048, 1536]);
  // Opaque PNG likewise (was refused as png-lossless before #560).
  const f2 = fakes({ sizes: [300_000] });
  const r2 = await compressImage(blobOf(big(2_000_000, pngFile(2)), "image/png"), { name: "flat.png", webp: false, deps: f2.deps });
  assert.equal(r2.transcoded, true);
  assert.equal(r2.blob.type, "image/png");
  // Alpha WebP over 2k: WebP → WebP.
  const f3 = fakes({ sizes: [300_000] });
  const r3 = await compressImage(blobOf(big(2_000_000, webpVp8x(0x10))), { name: "t.webp", webp: false, deps: f3.deps });
  assert.equal(r3.transcoded, true);
  assert.equal(r3.blob.type, "image/webp");
  // Within 2k: untouched.
  const f4 = fakes({ w: 1500, h: 1000 });
  const in4 = blobOf(big(2_000_000, pngFile(6)), "image/png");
  const r4 = await compressImage(in4, { webp: false, deps: f4.deps });
  assert.equal(r4.transcoded, false);
  assert.equal(r4.blob, in4);
  assert.equal(r4.reason, "within-2k");
});

test("compressImage: oversized opaque PNG under the core limit gets its 2k cap (webp on)", async () => {
  // Was skipped as png-lossless (#509); the cap is the point now.
  const f = fakes({ sizes: [300_000] });
  const r = await compressImage(blobOf(big(500_000, pngFile(2)), "image/png"), { name: "scan.png", deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.equal(r.name, "scan.webp");
  assert.deepEqual([f.calls.encode[0].width, f.calls.encode[0].height], [2048, 1536]);
  // Not smaller → original sent.
  const f2 = fakes({ sizes: [900_000] });
  const in2 = blobOf(big(500_000, pngFile(2)), "image/png");
  const r2 = await compressImage(in2, { deps: f2.deps });
  assert.equal(r2.transcoded, false);
  assert.equal(r2.blob, in2);
  assert.equal(r2.reason, "not-smaller");
});

test("compressImage: both settings off → disabled, nothing decoded", async () => {
  const f = fakes({});
  const r = await compressImage(blobOf(big(3_000_000)), { webp: false, resize: false, deps: f.deps });
  assert.equal(r.transcoded, false);
  assert.equal(r.reason, "disabled");
  assert.equal(f.calls.decode, 0);
});

test("compressImage: the 2k cap lowers the acceptance bar to 'smaller'", async () => {
  // A 4000px photo whose WebP is only 5 % smaller used to go out unscaled
  // (MIN_SAVING); with the resize on, the cap is the point — take it.
  const f = fakes({ w: 4000, h: 3000, sizes: [570_000] });
  const r = await compressImage(blobOf(big(600_000)), { deps: f.deps });
  assert.equal(r.transcoded, true);
  assert.equal(f.calls.encode[0].width, 2048);
  // ...and with the resize setting off the old bar holds.
  const g = fakes({ w: 4000, h: 3000, sizes: [570_000] });
  const kept = await compressImage(blobOf(big(600_000)), { resize: false, deps: g.deps });
  assert.equal(kept.transcoded, false);
});
