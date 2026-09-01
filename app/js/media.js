// media.js — turn blob/file paths into URLs the WebView can load.
import { debugLog } from "./diagnostics.js";

function rustLog(msg) {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (invoke) invoke("js_log", { msg }).catch(() => {});
}

// Serve media through Tauri's asset protocol — the configuration that
// reliably rendered images and video posters on every platform.
export function fileUrl(path) {
  if (!path) return "";
  try {
    const tauri = window.__TAURI__;
    if (tauri?.core?.convertFileSrc) {
      let resolved = path.replace(/\\/g, "/");
      const isAbs = /^([a-zA-Z]:|\/)/.test(resolved);
      if (!isAbs && window.veltaAccountsDir) {
        const base = window.veltaAccountsDir.replace(/\\/g, "/").replace(/\/$/, "");
        resolved = `${base}/${resolved.replace(/^\/+/, "")}`;
      }
      const url = tauri.core.convertFileSrc(resolved);
      debugLog(`fileUrl path=${path} resolved=${resolved} url=${url}`);
      return url;
    }
  } catch (e) { rustLog(`fileUrl error: ${e}`); }
  return path;
}
