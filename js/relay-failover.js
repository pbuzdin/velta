// #286: send failover status + strict pinned relay (core patch #30 reads
// SEND_STRICT_KEY). Pure helpers so node tests can pin them.
export const SEND_STRICT_KEY = "ui.velta.send_strict";

const domainOf = (a) => String(a || "").split("@")[1]?.toLowerCase() || null;

// The SMTP loop is bound to `via` while the user pinned `pinned`: the pin
// failed and the core fell back. null = no failover (or unknown).
export function sendFailover(pinned, via) {
  const p = domainOf(pinned), v = domainOf(via);
  if (!p || !v || p === v) return null;
  return { via: String(via), failed: String(pinned) };
}

// Logs only transitions: returns a line when the failover starts, changes or
// ends, null otherwise (the status refresh runs every few seconds).
export function createFailoverLog() {
  let last = null;
  return (fo) => {
    const key = fo ? `${fo.failed}>${fo.via}` : null;
    if (key === last) return null;
    const prev = last;
    last = key;
    if (key) return `relay: failover — sending via ${fo.via}, ${fo.failed} failed`;
    return prev ? "relay: failover ended — sending via the pinned relay again" : null;
  };
}

export const isStrictOn = (v) => String(v ?? "").trim() === "1";
