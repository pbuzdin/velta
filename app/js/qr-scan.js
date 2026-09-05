// qr-scan.js — acquire an out-of-band code (P2P invite, backup ticket, …) by
// pasting it. The live-camera scanner (getUserMedia + jsQR) was removed: QR
// decoding never worked reliably in the Android WebView, and Local chat
// pairing is handled by the LAN beacon "Nearby" list instead.

import { showModal, toast } from "./ui.js";

export function acquireCode({ title, hint, validate }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = document.createElement("div");
    body.innerHTML = `
      <p style="font-size:14.5px;line-height:1.5">${hint}</p>
      <textarea class="text-field" rows="3" placeholder="Paste code…" spellcheck="false" autocomplete="off"></textarea>`;
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
  });
}
