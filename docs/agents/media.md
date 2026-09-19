# Media pipeline — agent notes

Extracted from AGENTS.md. Source: `app/js/media.js` + `app/js/poster.js` +
the `[media]` server in lib.rs.

## URL resolution order (media.js)

1. **`blobfile://` custom protocol** — registered in `lib.rs`, serves
   account-dir-scoped blobs with real 206 ranges over a fixed origin, no
   TCP listener. Used once an `<img>` boot probe has proven this webview
   dispatches custom-protocol requests at all — the probe is an `<img>`,
   so a 200 vouches for the image pipeline exactly.
2. **Loopback media HTTP server** (`127.0.0.1:20810`, random per-launch
   token, account-directory-scoped, real ranges) — kept running even on the
   happy path: it is the probe-negative fallback AND the one-shot
   per-element fallback, because WebView2's media stack bypasses
   custom-protocol interception even when images through the same scheme
   load (Chromium issue). On Android this server is what `<video>`/`<audio>`
   can always rely on: the asset protocol there answers the first range
   read but fails mid-file ones, which kills demuxing of moov-at-end MP4s
   (most phone recordings).
3. **Asset protocol** — last resort.

`<img>`/`<video>`/`<audio>` error handlers swap to the legacy chain once
(`mediaFallbackUrl`) before showing a failure placeholder — keep those
swaps when touching media rendering.

## Caching

Blob media is served `Cache-Control: immutable` — core blob names are
content-deduplicated, so the WebView can cache image bytes across chat
switches.

## Posters

`app/js/poster.js` extracts and caches WebP poster frames for video
placeholders.

## Related

- Cleartext is permitted app-wide (network security config) so user-opened
  http links render in the in-app browser; the SPA itself never navigates
  top-level and its CSP blocks plain-http subresources, so the shell's own
  cleartext traffic stays the loopback media server.
- Attachment size limits and large-message download flow: README
  "Downloading large messages" / "Attachment size limit".
