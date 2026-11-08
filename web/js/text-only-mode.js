// text-only-mode.js — issue #300: a device-global renderer gate for
// attachments and link previews, keyed per sender. Renderer-only policy: it
// decides what the interface loads and shows; it does not stop the mail core
// from receiving message data (see the issue's scope boundary — do not
// describe it as transport-level protection).
const KEY = "velta-text-only";

export const TEXT_ONLY_LABELS = { unknown: "Unknown senders", off: "Off", all: "All messages" };

// "unknown" (default) | "off" | "all". Unset/invalid falls back to "unknown",
// which is why the default state stores nothing.
export function textOnlyMode() {
  let v = null;
  try { v = localStorage.getItem(KEY); } catch {}
  return v === "off" || v === "all" ? v : "unknown";
}

export function setTextOnlyMode(mode) {
  try {
    if (mode === "unknown") localStorage.removeItem(KEY);
    else if (mode === "off" || mode === "all") localStorage.setItem(KEY, mode);
  } catch {}
  clearReveals(); // a state change invalidates the session's exceptions
}

// Revealed items live for the session only (issue: cleared on reload, account
// switch and state changes; they survive virtual scrolling). Keys are
// `${accountId}:${msgId}` — a message has at most one covered item (media OR
// link preview), so the message id is the item id. Revealing here also
// reveals the same message's tile in the chat-info gallery, and vice versa.
const reveals = new Set();

export function itemKey(accountId, msgId) { return `${accountId}:${msgId}`; }
export function isItemRevealed(key) { return reveals.has(key); }
export function revealItem(key) { reveals.add(key); }
export function clearReveals() { reveals.clear(); }

// Contacts you have a 1:1 chat with — the "known contacts" definition from
// #169. app.js (which owns state.chats) installs the provider at boot; with
// none installed, or before the chat list loads, classification stays
// unresolved and fails closed (covered).
let knownIds = null;
export function setKnownContactIds(fn) { knownIds = fn; }

// "self" | "known" | "unknown". 1:1 chats classify by chat kind alone (an
// accepted single chat is a known partner, a contact request is not); group
// senders classify per message — a group being accepted does not make its
// members known. Device messages are the device's own.
export function senderClassification(m, chat) {
  if (m.from === 1 || m.fromDevice === true) return "self";
  if (chat?.kind === "single") return "known";
  if (chat?.kind === "deaddrop") return "unknown";
  const ids = knownIds?.();
  if (!ids || typeof ids.has !== "function") return "unknown"; // unresolved → fail closed
  return ids.has(m.fromContact?.id) ? "known" : "unknown";
}

export function coversMessage(m, chat) {
  if (!m || m.kind === "service") return false;
  if (textOnlyMode() === "off") return false;
  if (textOnlyMode() === "all") return true;
  return senderClassification(m, chat) === "unknown";
}

// Sender-side "Send a picture" previews: outgoing content is only suppressed
// in the global All messages state (issue: Unknown senders classifies
// incoming senders, not recipients).
export function senderPreviewBlocked() { return textOnlyMode() === "all"; }
