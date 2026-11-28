// HTML viewer document preparation (mail body, HTML attachments). Pure and
// DOM-free so it can be tested in node.
//
// Injected into every HTML-view overlay: a capture-phase interceptor that
// stops links from navigating the sandboxed frame and posts them to the
// parent, which opens them outside (Android in-app browser chain / desktop
// system browser). The page CSP blocks inline scripts, so these EXACT bytes
// are hash-whitelisted as script-src in index.html AND both tauri confs, and
// in HTML_VIEW_CSP below — change them all in one commit.
export const HTML_VIEW_LINK_JS = `document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;e.preventDefault();parent.postMessage({veltaHtmlLink:a.href},"*")},true)`;

// Policy of the viewer document itself (meta tag, first thing in <head>).
// Remote content stays off: only inline/data/blob resources load.
export const HTML_VIEW_CSP = [
  "default-src 'none'",
  "script-src 'sha256-8g+JKwDwKdYL2n4VrSU5f2pYq799ckvbz9HvJpfpNF8='",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// A refresh meta tag would navigate the frame to a remote page.
const META_REFRESH_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi;

export function prepareHtmlView(html, dark) {
  html = String(html).replace(META_REFRESH_RE, "");
  // The CSP goes first so it covers everything after it; the theme block
  // carries the color scheme and a font fallback (font-family only — the
  // mail's own CSS must keep absolute rule over layout).
  const inject = `<meta http-equiv="Content-Security-Policy" content="${HTML_VIEW_CSP}">`
    + `<style>html{color-scheme:${dark ? "dark" : "light"}}`
    + `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}</style>`
    + `<script>${HTML_VIEW_LINK_JS}</script>`;
  const head = /<head[^>]*>/i.exec(html) || /<html[^>]*>/i.exec(html);
  return head
    ? html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length)
    : inject + html;
}
