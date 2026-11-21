// text-only-mode.js — issues #300/#310: a device-global renderer gate for
// attachments and link previews. Renderer-only policy: it decides what the
// interface loads and shows; it does not stop the mail core from receiving
// message data (see #300's scope boundary — do not describe it as
// transport-level protection).
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

export function coversMessage(m, chat) {
  if (!m || m.kind === "service") return false;
  const mode = textOnlyMode();
  if (mode === "off") return false;
  if (mode === "all") return true;
  // #310: Auto is only for unaccepted 1:1 requests, never group senders.
  return chat?.kind === "deaddrop" && m.from !== 1 && m.fromDevice !== true;
}

// Sender-side "Send a picture" previews: outgoing content is only suppressed
// in the global All messages state (issue: Unknown senders classifies
// incoming senders, not recipients).
export function senderPreviewBlocked() { return textOnlyMode() === "all"; }
