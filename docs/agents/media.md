# Media pipeline — agent notes

Extracted from AGENTS.md. Source: `app/js/media.js` +
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

## Video posters (removed)

The WebP poster-extraction pipeline (`app/js/poster.js`,
`ensurePoster`, click-to-load) was removed post-1.4.31 — unstable and
unnecessary: `velta-video` renders a native
`<video preload="metadata" src="...#t=0.1">` with NO `controls` (Android
WebView stacks its own large centered native play button on controls
videos — double play button; controls return only in the no-lightbox
fallback via `v.controls = !videoLightboxOpener`) and WebView2/Chromium
paints frame 0 directly. The `#t` fragment forces the first-frame fetch.
`loadedmetadata` shapes the host box to the real aspect. The shell
commands `poster_cache_path`/`read_media_bytes`/`write_poster` (lib.rs)
are frontend-dead but still registered — candidates for removal.

## Bubble image thumbnails

`fileUrl(path, {thumb: true})` appends `?w=720`; BOTH the blobfile
protocol and the loopback server answer with a cached 720px JPEG
thumbnail — key `sha1(path+mtime+size+w)` under `<app-data>/thumbs`,
generated in lib.rs via the `image` crate, EXIF orientation applied.
Animated gif/webp, non-static formats, Range requests and every failure
fall through to the original bytes, so the UI can never regress on a
failed thumbnail. Bubble images pass `thumb:true`; the lightbox never
does.

## Path scoping

`scoped_accounts_path` (lib.rs) scopes every shell filesystem command to
the AppLocalData root — NOT just the accounts subdir: `uploads/`
(`resolve_upload_path`) is a SIBLING of `accounts/` and legitimately
holds picked attachments pre-send. Desktop picker files are copied into
`uploads/` at pick time (`resolveAttachmentPath`, chat-view.js; Android
content-URIs always were). Paths returned to the frontend have the
`\\?\` canonical prefix stripped (convertFileSrc percent-encodes it into
asset.localhost URLs that 404).

## Related

- Cleartext is permitted app-wide (network security config) so user-opened
  http links render in the in-app browser; the SPA itself never navigates
  top-level and its CSP blocks plain-http subresources, so the shell's own
  cleartext traffic stays the loopback media server.
- Attachment size limits and large-message download flow: README
  "Downloading large messages" / "Attachment size limit".
