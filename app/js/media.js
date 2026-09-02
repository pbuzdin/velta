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

// Media URL resolution order:
//   1. The loopback media HTTP server (proper Range support on every
//      platform) — the Android asset protocol answers the first range read
//      but fails mid-file ones, which kills <video> demuxing there.
//   2. Tauri's asset protocol — plain GETs (images, cached posters) still
//      work everywhere, so it stays the fallback and the poster path.
export function fileUrl(path) {
  if (!path) return "";
  try {
    const base = window.veltaMediaBase;
    if (base) {
      const url = `${base}/${encodeURIComponent(resolveUnderAccounts(path))}`;
      debugLog(`fileUrl path=${path} url=${url} (media server)`);
      return url;
    }
    const tauri = window.__TAURI__;
    if (tauri?.core?.convertFileSrc) {
      const resolved = resolveUnderAccounts(path);
      const url = tauri.core.convertFileSrc(resolved);
      debugLog(`fileUrl path=${path} resolved=${resolved} url=${url}`);
      return url;
    }
  } catch (e) { rustLog(`fileUrl error: ${e}`); }
  return path;
}
