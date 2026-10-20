// Network watcher for core I/O (#28 follow-up: "never reconnects after a VPN
// toggle"). The original wiring paused IO on the webview's `offline` event
// and resumed ONLY on `online`. Android WebView (and some desktop stacks)
// don't reliably fire `online` after a VPN is torn down — the VPN network is
// lost, the default network comes back underneath, and navigator.onLine can
// stay stale — so IO stayed stopped forever. maybe_network from the native
// side is a no-op while IO is stopped.
//
// Policy now:
//  * a loss is only acted on after a grace period (brief drops / VPN
//    switches never stop IO; we just nudge maybe_network);
//  * ANY positive signal (online, connection change, native network
//    available, foreground/visibility, focus) resumes when paused, and
//    nudges maybe_network otherwise;
//  * a periodic safety tick resumes when navigator says online, and after
//    a ceiling resumes even if navigator.onLine is stuck false (the core's
//    own backoff handles a genuinely dead network; the next real `offline`
//    pauses again).
export const NET_DEFAULTS = Object.freeze({
  offlineGraceMs: 10000,
  tickMs: 30000,
  pausedCeilingMs: 120000,
});

export function createNetWatch({ core, isOnline, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, opts = {} } = {}) {
  const o = { ...NET_DEFAULTS, ...opts };
  let paused = false;
  let pausedAt = 0;
  let pending = null;
  let busy = Promise.resolve();
  const getCore = typeof core === "function" ? core : () => core;
  const online = () => { try { return isOnline() !== false; } catch { return true; } };
  const run = fn => (busy = busy.then(fn, fn).catch(() => {}));

  function resume(reason) {
    if (pending) { clearTimer(pending); pending = null; }
    return run(async () => {
      const c = getCore();
      if (paused) {
        const ok = await c?.setNetworkIo?.(true, reason);
        if (ok !== false) { paused = false; pausedAt = 0; }
      } else {
        await c?.nudgeNetwork?.();
      }
    });
  }

  function pause() {
    return run(async () => {
      if (paused || online()) return;
      const ok = await getCore()?.setNetworkIo?.(false);
      if (ok !== false) { paused = true; pausedAt = now(); }
    });
  }

  return {
    get paused() { return paused; },
    // Positive / "something changed" signal.
    onSignal(reason = "signal") {
      if (!online() && !paused) { this.onOffline(); return busy; }
      if (!online() && paused) return busy; // wait for tick ceiling
      return resume(reason);
    },
    onOffline() {
      run(async () => { await getCore()?.nudgeNetwork?.(); });
      if (pending || paused) return busy;
      pending = setTimer(() => { pending = null; pause(); }, o.offlineGraceMs);
      return busy;
    },
    tick() {
      if (!paused) return busy;
      if (online() || now() - pausedAt >= o.pausedCeilingMs) return resume("tick");
      return busy;
    },
    // Boot sync: start paused only if still offline after the grace period.
    boot() { if (!online()) this.onOffline(); return busy; },
    idle() { return busy; },
  };
}
