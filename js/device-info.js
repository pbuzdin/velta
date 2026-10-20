// device-info.js — the "Show device info" block of the About dialog: a plain
// "Key: value" text for bug reports (screen, viewport, scaling, UA, platform,
// versions, media preferences). DOM-free core so it is unit-tested
// (tests/device-info.test.mjs): collectDeviceInfo() takes the globals it reads
// as an injected env. Never add personal identifiers (addresses, keys,
// display names, account ids) — this text is meant to be shared.

const num = (v, d = 2) => (typeof v === "number" && isFinite(v) ? +v.toFixed(d) : null);

// "Android app" | "Desktop app" | "Installed PWA" | "Browser (PWA)"
export function platformLabel({ tauri, android, standalone, ua }) {
  if (tauri) return android ? "Android app (Tauri)" : `Desktop app (Tauri${/Windows/i.test(ua) ? ", Windows" : /Mac OS X|Macintosh/i.test(ua) ? ", macOS" : /Linux/i.test(ua) ? ", Linux" : ""})`;
  return standalone ? "Installed PWA" : "Browser (PWA)";
}

// Entries: [key, value] pairs; null/undefined/"" values are dropped by format.
export function collectDeviceInfo(env = {}) {
  const w = env.window || {}, nav = env.navigator || {}, scr = env.screen || w.screen || {};
  const mq = q => { try { return !!w.matchMedia?.(q)?.matches; } catch { return false; } };
  const dpr = num(w.devicePixelRatio) || 1;
  const sw = scr.width, sh = scr.height;
  const standalone = mq("(display-mode: standalone)") || mq("(display-mode: fullscreen)") || nav.standalone === true;
  const ua = String(nav.userAgent || "");
  const vv = w.visualViewport;
  const uad = nav.userAgentData;
  const orient = scr.orientation?.type || (typeof w.orientation === "number" ? `${w.orientation}°` : null)
    || (w.innerWidth && w.innerHeight ? (w.innerWidth > w.innerHeight ? "landscape" : "portrait") : null);
  let tz = null;
  try { tz = env.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  const insets = env.safeArea;
  const e = [
    ["Velta version", env.appVersion],
    ["Core version", env.coreVersion],
    ["Platform", platformLabel({ tauri: !!env.tauri, android: !!env.android, standalone, ua })],
    ["Core backend", env.backendKind],
    ["Tauri version", env.tauriVersion],
    ["Display mode", standalone ? "standalone" : "browser"],
    ["Screen", sw && sh ? `${sw} x ${sh} CSS px` : null],
    ["Screen (physical)", sw && sh ? `${Math.round(sw * dpr)} x ${Math.round(sh * dpr)} px` : null],
    ["Available screen", scr.availWidth && scr.availHeight ? `${scr.availWidth} x ${scr.availHeight}` : null],
    ["Device pixel ratio", String(dpr)],
    ["Approx. DPI", `${Math.round(96 * dpr)} (96 x DPR; CSS assumes 96 dpi)`],
    ["Color depth", scr.colorDepth ? `${scr.colorDepth}-bit` : null],
    ["Viewport", w.innerWidth && w.innerHeight ? `${w.innerWidth} x ${w.innerHeight}` : null],
    ["Visual viewport", vv ? `${num(vv.width, 1)} x ${num(vv.height, 1)} @ scale ${num(vv.scale)}` : null],
    ["Interface scale", env.uiScale && env.uiScale !== "1" ? `${env.uiScale} (CSS zoom)` : "1"],
    ["Orientation", orient],
    ["Safe-area insets", insets ? `top ${insets.top}, right ${insets.right}, bottom ${insets.bottom}, left ${insets.left} px` : null],
    ["Touch points", typeof nav.maxTouchPoints === "number" ? String(nav.maxTouchPoints) : null],
    ["Pointer", mq("(pointer: coarse)") ? "coarse" : mq("(pointer: fine)") ? "fine" : "none"],
    ["Hover", mq("(hover: hover)") ? "yes" : "no"],
    ["Color scheme", mq("(prefers-color-scheme: dark)") ? "dark" : "light"],
    ["App theme", env.theme],
    ["Reduced motion", mq("(prefers-reduced-motion: reduce)") ? "reduce" : "no-preference"],
    ["Forced colors", mq("(forced-colors: active)") ? "active" : null],
    ["Language", nav.language],
    ["Languages", Array.isArray(nav.languages) && nav.languages.length ? nav.languages.join(", ") : null],
    ["Time zone", tz],
    ["UA platform", uad?.platform || nav.platform || null],
    ["UA mobile", uad && typeof uad.mobile === "boolean" ? String(uad.mobile) : null],
    ["UA brands", Array.isArray(uad?.brands) && uad.brands.length ? uad.brands.map(b => `${b.brand} ${b.version}`).join(", ") : null],
    ["CPU cores", nav.hardwareConcurrency ? String(nav.hardwareConcurrency) : null],
    ["Device memory", nav.deviceMemory ? `${nav.deviceMemory} GB` : null],
    ["Online", typeof nav.onLine === "boolean" ? String(nav.onLine) : null],
    ["Connection", nav.connection?.effectiveType || null],
    ["Service worker", nav.serviceWorker?.controller ? "active" : nav.serviceWorker ? "none" : "unsupported"],
    ["User agent", ua || null],
  ];
  return e;
}

export function formatDeviceInfo(entries) {
  return entries
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v).replace(/\s*\n\s*/g, " ")}`)
    .join("\n");
}

// Safe-area insets: env() is only readable through a laid-out element.
export function measureSafeArea(doc = globalThis.document) {
  try {
    const el = doc.createElement("div");
    el.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    doc.body.appendChild(el);
    const cs = getComputedStyle(el);
    const r = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    el.remove();
    return r;
  } catch { return null; }
}
