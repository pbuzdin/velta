// Stall-safe list loads (#stalls): a timed-out or failed RPC must never be
// rendered as an empty list ("No relays", "0 chats in Bots"). Keep the last
// good value and show a "Couldn't load — Retry" banner instead. Node-safe.

// Last-good cache keyed by scope (account id). settle() folds one load
// outcome in: success replaces the value, failure keeps it and records the
// error. `value` is null until the first success in that scope.
export function createLastGood() {
  const byScope = new Map();
  return {
    get(scope) { return byScope.get(scope) ?? { value: null, error: null }; },
    ok(scope, value) { const s = { value, error: null }; byScope.set(scope, s); return s; },
    fail(scope, error) {
      const prev = byScope.get(scope);
      const s = { value: prev ? prev.value : null, error: error || new Error("load failed") };
      byScope.set(scope, s);
      return s;
    },
  };
}

export function loadErrorText(err, t = s => s) {
  return /rpc timeout/i.test(String(err?.message || err)) ? t("Couldn't load — the core is busy.") : t("Couldn't load.");
}

// <div class="load-error" role="alert">msg <button>Retry</button></div>
export function loadErrorBanner(doc, { err, t, onRetry, stale = false }) {
  const el = doc.createElement("div");
  el.className = "load-error";
  el.setAttribute("role", "alert");
  const msg = doc.createElement("span");
  msg.textContent = loadErrorText(err, t) + (stale ? " " + t("Showing the last loaded list.") : "");
  el.appendChild(msg);
  if (onRetry) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "btn-text";
    b.setAttribute("data-retry", "");
    b.textContent = t("Retry");
    b.addEventListener("click", e => { e.stopPropagation(); onRetry(); });
    el.appendChild(b);
  }
  return el;
}

// Best-effort extras (connectivity, server metadata) must not hold a list
// hostage: they wait on core locks an IO restart or an IMAP METADATA fetch
// holds for up to 30 s. Rejects with "rpc timeout: <label>" after `ms`.
export function withTimeout(promise, ms, label = "call") {
  let timer;
  const cap = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("rpc timeout: " + label)), ms); });
  return Promise.race([Promise.resolve(promise), cap]).finally(() => clearTimeout(timer));
}
