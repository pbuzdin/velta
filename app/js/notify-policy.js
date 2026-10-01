// When an already-received message should raise an OS notification.
// Android posts from the Rust poller; the page there only toasts while the
// document is hidden. A minimized or unfocused desktop window often leaves
// document.hidden false (WebView2), so those count as "not looking" too.
export function shouldNotifyIncoming({
  tauri = false,
  android = false,
  hidden = false,
  minimized = false,
  focused = true,
} = {}) {
  if (!tauri) return false;
  if (android) return !!hidden;
  return !!(hidden || minimized || focused === false);
}
