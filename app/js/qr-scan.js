// qr-scan.js — acquire an out-of-band code (P2P invite, relay invite, backup
// ticket, …) by pasting it or by scanning it with the camera. Scanning uses
// the native BarcodeDetector API (getUserMedia + platform decoder, no bundled
// library). The earlier getUserMedia + jsQR scanner was removed because QR
// decoding never worked reliably in the Android WebView; BarcodeDetector
// delegates decoding to the platform instead.
// 🐴 ceiling: WebViews without BarcodeDetector hide the scan button and fall
// back to paste; upgrade path is a bundled WASM decoder if native coverage
// proves insufficient in practice.

import { showModal, toast } from "./ui.js";

export function acquireCode({ title, hint, validate }) {
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

    const canScan = "BarcodeDetector" in window;
    const body = document.createElement("div");
    body.innerHTML = `
      <p style="font-size:14.5px;line-height:1.5">${hint}</p>
      <textarea class="text-field" rows="3" placeholder="Paste code…" spellcheck="false" autocomplete="off"></textarea>
      ${canScan ? `
      <div style="margin-top:10px"><button class="btn-text" data-scan-btn>Scan QR code</button></div>
      <div data-scan hidden style="margin-top:10px">
        <video muted playsinline style="width:100%;border-radius:10px;background:#0b0b10"></video>
      </div>` : ""}`;
    const ta = body.querySelector("textarea");
    const { close } = showModal({ title, body, onClose: () => finish(null) });

    const submit = code => {
      code = (code || "").trim();
      if (!code) return;
      const err = validate?.(code);
      if (err) { toast(err); return; }
      close();
      finish(code);
    };

    ta.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(ta.value); }
    });
    setTimeout(() => ta.focus(), 60);

    if (!canScan) return;
    const scanBtn = body.querySelector("[data-scan-btn]");
    const scanArea = body.querySelector("[data-scan]");
    const video = body.querySelector("video");
    let scanning = false;

    const toggleScan = async () => {
      if (scanning) {
        scanning = false;
        stopScan();
        scanArea.hidden = true;
        scanBtn.textContent = "Scan QR code";
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
      } catch (err) {
        toast("Camera unavailable: " + (err?.message || err));
        return;
      }
      if (settled) { stopScan(); return; }
      scanning = true;
      scanBtn.textContent = "Use paste instead";
      scanArea.hidden = false;
      video.srcObject = stream;
      try { await video.play(); } catch {}
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!scanning || !stream) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            scanning = false;
            stopScan();
            scanArea.hidden = true;
            submit(codes[0].rawValue);
            return;
          }
        } catch {}
        if (stream) setTimeout(tick, 150);
      };
      tick();
    };
    scanBtn.addEventListener("click", toggleScan);
  });
}
