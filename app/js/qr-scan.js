// qr-scan.js — acquire an out-of-band code (P2P invite, relay invite, backup
// ticket, …) by pasting it or by scanning it with the camera. Camera
// permission is requested only when the user taps "Scan QR code" — never on
// opening the dialog.
//
// Decoder: the native BarcodeDetector API where the platform offers it, with
// the vendored jsQR (app/vendor/jsQR.js, loaded on demand) as fallback — many
// Android System WebViews ship no Shape Detection API at all, which used to
// leave camera scanning silently unavailable on those devices. Every failure
// point (no camera API, permission not answered, decoder errors, empty code)
// surfaces as a toast instead of failing silently.

import { showModal, toast } from "./ui.js";
import { diagnosticsSink } from "./diagnostics.js";

const canUseCamera = () => !!navigator.mediaDevices?.getUserMedia;

// jsQR is a UMD bundle loaded on demand so it costs nothing at app boot.
let jsQrLoader = null;
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQrLoader) {
    jsQrLoader = new Promise(resolve => {
      const s = document.createElement("script");
      s.src = "./vendor/jsQR.js";
      s.onload = () => resolve(window.jsQR || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return jsQrLoader;
}

// Decode one video frame with jsQR via a reused offscreen canvas.
async function decodeWithJsQr(video) {
  const jsQR = await loadJsQr();
  if (!jsQR) throw new Error("jsQR decoder not available");
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const c = decodeWithJsQr._canvas || (decodeWithJsQr._canvas = document.createElement("canvas"));
  const scale = Math.min(1, 640 / w);
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, c.width, c.height);
  const res = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "attemptBoth" });
  return res?.data || null;
}

// Native BarcodeDetector when usable; on first-use failure (or a probe that
// never answers) fall back to jsQR for the rest of the app session. The video
// must already be playing — probing a source-less element always throws
// "Invalid element or state".
let nativeDecoderBroken = false;
async function makeDecoder(video) {
  if (!nativeDecoderBroken && "BarcodeDetector" in window) {
    try {
      // Wait for the first frame before probing (max ~4s).
      const t0 = Date.now();
      while (video.readyState < 2 && Date.now() - t0 < 4000) {
        await new Promise(r => setTimeout(r, 100));
      }
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      await Promise.race([
        detector.detect(video),
        new Promise((_, rej) => setTimeout(() => rej(new Error("BarcodeDetector probe timed out")), 2000)),
      ]);
      diagnosticsSink.append("info", "scan: using native BarcodeDetector");
      return async v => (await detector.detect(v))[0]?.rawValue || null;
    } catch (err) {
      // One toast per session — informational, not an error.
      nativeDecoderBroken = true;
      diagnosticsSink.append("info", `scan: native BarcodeDetector unusable (${err?.message || err}) — falling back to jsQR`);
      toast("Native QR reader unusable — using the built-in decoder");
    }
  } else if (nativeDecoderBroken) {
    diagnosticsSink.append("info", "scan: using jsQR (native reader known-broken this session)");
  }
  return decodeWithJsQr;
}

export function acquireCode({ title, hint, validate, autoScan = false }) {
  return new Promise(resolve => {
    let settled = false;
    let stream = null;
    const stopScan = () => {
      stream?.getTracks().forEach(t => t.stop());
      stream = null;
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      stopScan();
      resolve(value);
    };

    const canScan = canUseCamera();
    const body = document.createElement("div");
    body.innerHTML = `
      <p style="font-size:14.5px;line-height:1.5">${hint}</p>
      <textarea class="text-field" rows="3" placeholder="Paste code…" spellcheck="false" autocomplete="off"></textarea>
      <div style="margin-top:8px;text-align:center"><button class="btn-text" data-use-btn>Use this code</button></div>
      ${canScan ? `
      <div style="margin-top:10px"><button class="btn-text" data-scan-btn>Scan QR code</button></div>
      <div data-scan hidden style="margin-top:10px">
        <video muted playsinline style="width:100%;border-radius:10px;background:#0b0b10"></video>
      </div>` : `
      <p style="font-size:13px;color:var(--text-dim,#777);margin-top:8px">Camera scanning is not available here — paste the code instead.</p>`}`;
    const ta = body.querySelector("textarea");
    const { close } = showModal({ title, body, onClose: () => finish(null) });

    const submit = code => {
      code = (code || "").trim();
      if (!code) { diagnosticsSink.append("warning", "scan: empty payload"); toast("That QR code contains no data"); return; }
      const err = validate?.(code);
      if (err) { diagnosticsSink.append("info", `scan: code rejected by validator (${code.length} chars)`); toast(err); return; }
      diagnosticsSink.append("info", `scan: code accepted (${code.length} chars)`);
      finish(code); // settle BEFORE close — close() fires onClose, which must not win
      close();
    };

    ta.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(ta.value); }
    });
    // Android soft keyboards deliver Enter unreliably — always give paste a
    // tappable submit.
    body.querySelector("[data-use-btn]").addEventListener("click", () => submit(ta.value));
    setTimeout(() => ta.focus(), 60);

    if (!canScan) return;
    const scanBtn = body.querySelector("[data-scan-btn]");
    const scanArea = body.querySelector("[data-scan]");
    const video = body.querySelector("video");
    let scanning = false;
    let decoder = null;
    let decodeErrors = 0;
    let startedAt = 0;
    let hinted = false;

    const stopScanningUi = () => {
      scanArea.hidden = true;
      scanBtn.textContent = "Scan QR code";
    };

    const tick = async () => {
      if (!scanning || !stream) return;
      try {
        const raw = await decoder(video);
        decodeErrors = 0;
        if (raw) {
          scanning = false;
          stopScan();
          stopScanningUi();
          submit(raw);
          return;
        }
      } catch (err) {
        if (++decodeErrors === 1) diagnosticsSink.append("warning", `scan: decoder error: ${err?.message || err}`);
        if (decodeErrors === 10) toast("QR reader is failing: " + (err?.message || err));
      }
      if (!hinted && startedAt && Date.now() - startedAt > 12000) {
        // 12 s of live frames without a hit — nudge instead of staying mute.
        hinted = true;
        toast("No code found yet — hold the QR fully inside the frame");
      }
      if (stream) setTimeout(tick, 120);
    };

    const toggleScan = async () => {
      if (scanning) {
        scanning = false;
        stopScan();
        stopScanningUi();
        return;
      }
      if (!canUseCamera()) { toast("Camera API is not available in this WebView"); return; }
      if (!scanning) toast("Starting camera…"); // instant feedback while the permission prompt may be pending
      diagnosticsSink.append("info", "scan: requesting camera");
      try {
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("camera did not start — answer the permission prompt or grant camera access in system settings")), 10000)),
        ]);
      } catch (err) {
        diagnosticsSink.append("error", `scan: camera request failed: ${err?.message || err}`);
        toast("Camera unavailable: " + (err?.message || err));
        return;
      }
      if (settled) { stopScan(); return; }
      diagnosticsSink.append("info", `scan: camera started (${stream.getVideoTracks()[0]?.label || "track"})`);
      scanning = true;
      startedAt = Date.now();
      hinted = false;
      scanBtn.textContent = "Use paste instead";
      scanArea.hidden = false;
      video.srcObject = stream;
      try { await video.play(); } catch (err) {
        diagnosticsSink.append("warning", `scan: video.play failed: ${err?.message || err}`);
      }
      // Probe only after the preview is live — a source-less video element
      // makes every native detect() throw "Invalid element or state".
      if (!decoder) decoder = await makeDecoder(video);
      diagnosticsSink.append("info", "scan: decoder ready");
      tick();
    };
    scanBtn.addEventListener("click", toggleScan);
    // Callers can request the camera right away (e.g. the splash's
    // "Scan a QR code" button) instead of requiring a second tap here.
    if (autoScan) setTimeout(() => { if (!settled) toggleScan(); }, 60);
  });
}
