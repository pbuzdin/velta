// media.js — turn blob/file paths into URLs the WebView can load.
import { debugLog } from "./diagnostics.js";

function rustLog(msg) {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (invoke) invoke("js_log", { msg }).catch(() => {});
}

function resolveUnderAccounts(path) {
  let resolved = path.replace(/\\/g, "/");
  const isAbs = /^([a-zA-Z]:|\/)/.test(resolved);
  if (!isAbs && window.veltaAccountsDir) {
    const base = window.veltaAccountsDir.replace(/\\/g, "/").replace(/\/$/, "");
    resolved = `${base}/${resolved.replace(/^\/+/, "")}`;
  }
  return resolved;
}

// Custom schemes live at http://<scheme>.localhost on Windows/Android and
// <scheme>://localhost on macOS/Linux (same split as webxdc's baseFor).
function blobfileBase() {
  return /Windows|Android/.test(navigator.userAgent || "")
    ? "http://blobfile.localhost"
    : "blobfile://localhost";
}

// Media URL resolution order:
//   1. The blobfile:// custom protocol (boot-probed) — serverless, fixed
//      origin, real 206 ranges answered in lib.rs. The probe is itself an
//      <img> load, so a positive probe proves the exact pipeline images use.
//   2. The loopback media HTTP server (fixed port 20810, per-launch token,
//      real ranges) — the probe-negative path, and the per-element fallback
//      for <video>/<audio>: WebView2's media stack bypasses custom-protocol
//      interception even when images through the same scheme work.
//   3. Tauri's asset protocol — plain GETs (posters) still work everywhere.
// The HTTP server stays running; it is the fallback, not the primary.
try {
  const probe = new Image();
  probe.onload = () => { window.veltaBlobfileOk = true; };
  probe.onerror = () => {};
  probe.src = `${blobfileBase()}/__velta-probe`;
} catch {}

export function fileUrl(path) {
  if (!path) return "";
  try {
    const resolved = resolveUnderAccounts(path);
    if (window.veltaBlobfileOk) {
      const url = `${blobfileBase()}/${encodeURIComponent(resolved)}`;
      debugLog(`fileUrl path=${path} url=${url} (blobfile)`);
      return url;
    }
    const base = window.veltaMediaBase;
    if (base) {
      const url = `${base}/${encodeURIComponent(resolved)}`;
      debugLog(`fileUrl path=${path} url=${url} (media server)`);
      return url;
    }
    const tauri = window.__TAURI__;
    if (tauri?.core?.convertFileSrc) {
      const url = tauri.core.convertFileSrc(resolved);
      debugLog(`fileUrl path=${path} resolved=${resolved} url=${url}`);
      return url;
    }
  } catch (e) { rustLog(`fileUrl error: ${e}`); }
  return path;
}

// Legacy chain for per-element recovery: when a blobfile media request
// fails (WebView2 media elements, probe race), <video>/<audio>/<img> swap
// to this once before showing a failure placeholder.
export function mediaFallbackUrl(path) {
  if (!path) return "";
  const resolved = resolveUnderAccounts(path);
  const base = window.veltaMediaBase;
  if (base) return `${base}/${encodeURIComponent(resolved)}`;
  const tauri = window.__TAURI__;
  if (tauri?.core?.convertFileSrc) return tauri.core.convertFileSrc(resolved);
  return path;
}
