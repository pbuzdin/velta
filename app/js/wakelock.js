// Screen Wake Lock: keep the display awake while a call is connected or the
// camera is scanning a QR. Browser-only (no Tauri equivalent needed — the
// shells manage their own screens); silently no-ops where unsupported.
// The lock is dropped by the OS whenever the page hides, so visibilitychange
// re-acquires it while someone still wants it.
let sentinel = null;
let wanters = 0;

async function acquire() {
  if (sentinel || wanters === 0 || !globalThis.navigator?.wakeLock) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => { sentinel = null; });
  } catch {}
}

export function wakeLockAcquire() {
  wanters++;
  return acquire();
}

export function wakeLockRelease() {
  wanters = Math.max(0, wanters - 1);
  if (wanters === 0 && sentinel) {
    try { sentinel.release(); } catch {}
    sentinel = null;
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) acquire();
  });
}
