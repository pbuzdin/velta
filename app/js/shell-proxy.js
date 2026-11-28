// The proxy the shell-side network features use (link previews, Large file,
// relay probes, update checks): the account's proxy_url, or null for direct.
// app.js registers a reader for the active account. Kept dependency-free so
// any module (and node tests) can import it.
let proxySource = null;
export function setLinkPreviewProxySource(fn) { proxySource = typeof fn === "function" ? fn : null; }

// Throws while the setting is unknown — callers must not fall back to a
// direct connection then (fail closed).
export async function shellProxy() {
  if (!proxySource) throw new Error("proxy setting not known yet");
  return (await proxySource()) || null;
}
