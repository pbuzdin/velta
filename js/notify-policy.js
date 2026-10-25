// When an already-received message should raise an OS notification.
// Android posts from Rust (one MessagingStyle card). The page stays quiet
// there: posting too doubled the card once the WebView kept running after
// Home. A minimized or unfocused desktop window often leaves
// document.hidden false (WebView2), so those count as "not looking" too.
// web = PWA/plain browser: no window APIs, document focus is the only
// "is the user looking" signal.
export function shouldNotifyIncoming({
  tauri = false,
  android = false,
  web = false,
  hidden = false,
  minimized = false,
  focused = true,
} = {}) {
  if (android) return false;
  if (web) return !!(hidden || focused === false);
  if (!tauri) return false;
  return !!(hidden || minimized || focused === false);
}

// Muted chats stay silent, except a message that @mentions me when the
// "Notify me when mentioned in muted chats" switch is on (default on).
// mentionsMe = mentions.js result for the message text.
export function mutedChatAllows({ muted = false, mentionsMe = false, mentionInMuted = true } = {}) {
  if (!muted) return true;
  return !!(mentionInMuted && mentionsMe);
}

// localStorage switch (default on; "0" = off).
export const MUTED_MENTIONS_KEY = "velta-notify-muted-mentions";
export function mentionInMutedOn(storage = globalThis.localStorage) {
  try { return storage?.getItem(MUTED_MENTIONS_KEY) !== "0"; } catch { return true; }
}
