// tauri.js — the one place that knows how to reach the Tauri shell.
// Every lookup is lazy (at call time), so tests and late shell injection that
// (re)assign window.__TAURI__ after import keep working. Safe in workers and
// node (no window -> no shell).

// The shell's invoke function (Tauri 2 core.invoke, Tauri 1 invoke), or null
// outside the Tauri shell (PWA, browser, mock core).
export function tauriInvoke() {
  const t = globalThis.window?.__TAURI__;
  return t?.core?.invoke || t?.invoke || null;
}

// invoke(cmd, args) that rejects outside the shell instead of throwing.
export function invoke(cmd, args) {
  const fn = tauriInvoke();
  return fn ? fn(cmd, args) : Promise.reject(new Error(`no Tauri shell for ${cmd}`));
}

export function isTauri() {
  return !!globalThis.window?.__TAURI__;
}

// Case-insensitive on purpose: some WebViews/UA overrides lower-case it.
export function isAndroid() {
  return /android/i.test(globalThis.navigator?.userAgent || "");
}

// Line into velta.log (shell js_log command) plus the console. Never throws;
// a no-op for the shell side outside Tauri.
export function rustLog(msg) {
  try { console.log("[velta]", msg); } catch {}
  try { tauriInvoke()?.("js_log", { msg })?.catch?.(() => {}); } catch {}
}
