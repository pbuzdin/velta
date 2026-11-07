// #110: which relays support UnifiedPush, as the core itself observed it.
// The core registers the push token only on relays whose IMAP METADATA
// says supports_push, then stores it with SETMETADATA; core patch #13
// reports the outcome per relay ("Transport N (addr): push notifications
// registered" / "… (addr): relay did not accept the push token"). That is
// the only signal: no probe, no guessing. Unknown relays get no mark.
// Results are cached per relay domain (push support is a relay property).
import { t } from "./i18n.js";

const KEY = "velta.relayPush";
const OK = /^Transport \d+ \(([^()\s]+@[^()\s]+)\): push notifications registered\b/;
const NO = /^Transport \d+ \(([^()\s]+@[^()\s]+)\): relay did not accept the push token\b/;

const domainOf = (addr) => String(addr || "").split("@").pop().trim().toLowerCase();

function load(storage) {
  try { const v = JSON.parse(storage?.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; }
  catch { return {}; }
}

/** Parse a core diagnostic line; returns { domain, supported } or null. */
export function parsePushDiagnostic(message) {
  const s = String(message || "");
  let m = OK.exec(s);
  if (m) return { domain: domainOf(m[1]), supported: true };
  m = NO.exec(s);
  if (m) return { domain: domainOf(m[1]), supported: false };
  return null;
}

/** Record a diagnostic if it is a push-registration result. */
export function notePushDiagnostic(message, storage = globalThis.localStorage) {
  const r = parsePushDiagnostic(message);
  if (!r || !r.domain) return false;
  const all = load(storage);
  all[r.domain] = { supported: r.supported, ts: Date.now() };
  try { storage?.setItem(KEY, JSON.stringify(all)); } catch { /* quota/private mode */ }
  return true;
}

/** true only when the core confirmed push for this relay's domain. */
export function relaySupportsPush(addrOrDomain, storage = globalThis.localStorage) {
  return load(storage)[domainOf(addrOrDomain)]?.supported === true;
}

export const PUSH_MARK_LABEL = "Supports UnifiedPush push notifications";
export function pushMarkHtml() {
  return ` <span class="relay-push-mark" title="${t(PUSH_MARK_LABEL)}" aria-label="${t(PUSH_MARK_LABEL)}" role="img">(U)</span>`;
}
