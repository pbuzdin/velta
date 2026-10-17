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
