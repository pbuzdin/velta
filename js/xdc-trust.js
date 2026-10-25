// xdc-trust.js — which webxdc apps the host trusts with webxdc.veltaCall
// (docs/agents/group-calls.md). Trust = the SHA-256 of the app's .xdc
// bytes is on the built-in list (trusted-xdc.js, generated with the
// bundles). Name, manifest, file name and sender never count.
import { TRUSTED_XDC } from "./trusted-xdc.js";

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("no WebCrypto");
  const d = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "group-call" (etc.) for a trusted bundle, else null. Never throws. */
export async function trustedAppName(bytes, list = TRUSTED_XDC) {
  try {
    if (!bytes || !bytes.byteLength) return null;
    const h = await sha256Hex(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return Object.prototype.hasOwnProperty.call(list, h) ? list[h] : null;
  } catch { return null; }
}
