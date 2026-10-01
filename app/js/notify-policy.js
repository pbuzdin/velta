// When an already-received message should raise an OS notification.
// Android posts from Rust (one MessagingStyle card). The page stays quiet
// there: posting too doubled the card once the WebView kept running after
// Home. A minimized or unfocused desktop window often leaves
// document.hidden false (WebView2), so those count as "not looking" too.
export function shouldNotifyIncoming({
  tauri = false,
  android = false,
  hidden = false,
  minimized = false,
  focused = true,
} = {}) {
  if (!tauri) return false;
  if (android) return false;
  return !!(hidden || minimized || focused === false);
}
