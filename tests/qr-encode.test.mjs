import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { encodeQr, makeSegmentsForVersion, reencodeCoreQrSvg, qrSvg, qrPathData } from "../app/js/qr-encode.js";
import { QR_PAYLOADS } from "./qr-fixtures.mjs";

const jsQR = createRequire(import.meta.url)("../app/vendor/jsQR.js");

// Rasterise a code (4-module quiet zone) and decode it with the vendored jsQR.
function decode(qr, scale = 4) {
  const n = (qr.size + 8) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (qr.get(Math.floor(x / scale) - 4, Math.floor(y / scale) - 4)) px.fill(0, (y * n + x) * 4, (y * n + x) * 4 + 3);
  }
  const r = jsQR(px, n, n, { inversionAttempts: "dontInvert" });
  return r && { text: new TextDecoder().decode(Uint8Array.from(r.binaryData)), version: r.version };
}

const extra = {
  numeric: "0123456789012345678901234567890",
  "all alnum": "HTTPS://EXAMPLE.ORG/ABC-123 $%*+",
  unicode: "Привет, 世界 ✓ émoji 🎉 1234567890 ABCDEF",
  "long mixed": "a".repeat(50) + "0123456789".repeat(20) + "XYZ".repeat(40),
};

for (const [name, text] of Object.entries({ ...QR_PAYLOADS, ...extra })) {
  test(`QR round-trip (jsQR): ${name}`, () => {
    const opt = encodeQr(text);
    const old = encodeQr(text, { optimal: false });
    assert.ok(opt.version <= old.version, `${name}: v${opt.version} > core v${old.version}`);
    assert.ok(opt.bits <= old.bits);
    for (const qr of [opt, old]) {
      const got = decode(qr);
      assert.ok(got, `${name}: jsQR could not decode v${qr.version}`);
      assert.equal(got.text, text);
      assert.equal(got.version, qr.version);
    }
  });
}

test("segmentation keeps the text byte-identical and picks modes", () => {
  const text = QR_PAYLOADS["contact invite"];
  const segs = makeSegmentsForVersion(text, 9);
  assert.ok(segs.some(s => s.data && s.mode));
  const qr = encodeQr(text);
  assert.ok(qr.segments.some(s => s.mode === "alnum"), "the 40-hex fingerprint rides an alphanumeric run");
  assert.equal(qr.segments.reduce((n, s) => n + s.chars, 0), text.length, "ASCII: one count per char");
  assert.deepEqual(encodeQr("0123456789").segments, [{ mode: "numeric", chars: 10 }]);
  assert.deepEqual(encodeQr("").segments, []);
});

test("invite links need fewer bits; contact QRs drop a version", () => {
  for (const k of ["contact invite", "group invite", "openpgp4fpr contact"]) {
    const t = QR_PAYLOADS[k];
    assert.ok(encodeQr(t).bits < encodeQr(t, { optimal: false }).bits - 60, k);
  }
  for (const k of ["openpgp4fpr contact", "dcaccount"]) {
    const t = QR_PAYLOADS[k];
    assert.ok(encodeQr(t).version < encodeQr(t, { optimal: false }).version, k);
  }
});

test("reencodeCoreQrSvg swaps the core's module path and keeps the rest", () => {
  const text = QR_PAYLOADS["openpgp4fpr contact"];
  const core = encodeQr(text, { optimal: false });
  const scale = 400 / core.size;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 515 630"><rect x="2" y="2" style="fill:#f2f2f2"/>`
    + `<g transform="translate(57.5,75)"><path style="fill:#000000" d="${qrPathData(core)}" transform="scale(${scale})"/></g>`
    + `<text y="550">Scan to join</text><circle cx="257.5" cy="275" r="56.2" style="fill:#f2f2f2"/></svg>`;
  const out = reencodeCoreQrSvg(svg, text);
  const opt = encodeQr(text);
  assert.ok(out.includes(`d="${qrPathData(opt)}"`));
  assert.ok(out.includes(`transform="scale(${+(400 / opt.size).toFixed(6)})"`));
  assert.ok(out.includes("Scan to join") && out.includes("<circle"));
  assert.ok(!out.includes(qrPathData(core)));
  // Unknown layouts and garbage pass through untouched.
  assert.equal(reencodeCoreQrSvg("<svg/>", text), "<svg/>");
  assert.equal(reencodeCoreQrSvg(null, text), null);
  // Never grows: a core code already smaller than ours is left alone.
  const tiny = svg.replace(qrPathData(core), qrPathData(encodeQr("A")));
  assert.equal(reencodeCoreQrSvg(tiny, text), tiny);
});

test("qrSvg (demo core) is a real code", () => {
  const svg = qrSvg("DCBACKUP2:demo");
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/);
});
