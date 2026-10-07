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
The blobfile scheme is asynchronous (`register_asynchronous_uri_scheme_protocol`);
the read, decode, and encode run in `spawn_blocking`, same as the
`rpc`, `p2p_send_file`, `resolve_content_uri`, `read_media_bytes`, and
`write_poster` commands. Do not put that work back on the UI thread.
Animated gif/webp, non-static formats, Range requests and every failure
fall through to the original bytes, so the UI can never regress on a
failed thumbnail. Bubble images pass `thumb:true`; the lightbox never
does.

## Outgoing photo compression (#81)

`app/js/image-compress.js` re-encodes big outgoing photos to lossy WebP in the
renderer (`createImageBitmap` -> canvas -> `image/webp`, quality 0.8) from
`ChatView._sendPendingMedia`, before the bytes are written to `uploads/`
(`resolve_upload_path`) and handed to the core. No dependency and no core
change; the core's own JPEG recode (`blob.rs`) still applies to whatever is
sent as is.

- Drawer: Image quality -> "Compress photos to save relay space" (localStorage
  `velta-compress-photos`, `"0"` = off, default on). Off is byte-exact as before.
- Format is sniffed from the bytes. Candidates: static JPEG, opaque static
  WebP, opaque PNG. Never touched: GIF, animated WebP/APNG, WebP/PNG with
  transparency, unknown formats, inputs over 64 MB, videos, files, stickers.
- Gate: size above min(256 KiB, core limit for the current Image quality;
  940 KB Standard / 130 KB Compact). Opaque PNG only when it exceeds the core
  limit (the core would turn it into a JPEG anyway).
- Over the core limit the image is scaled to the core's pixel budget (1760^2 /
  640^2) and the WebP is kept only if it fits the byte limit (quality ladder
  0.8 / 0.65 / 0.5); otherwise the original goes out and the core recodes it.
  Under the limit the WebP must be at least 10% smaller than the original.
- Any failure, or an engine whose canvas cannot encode WebP (it returns PNG),
  sends the original. EXIF is dropped only for photos that were transcoded.
- Tests: `tests/image-compress.test.mjs` (sniffing, decision function,
  keep-smaller, `compressImage` with fake decode/encode deps).

## Sender-side link previews (#88)

Drawer **Link previews** is `off` | `picture` | `fetch` (`linkPreviewMode`).
Unset and `"0"` are off; the old `"1"` is `fetch`. Only `picture` bakes.
The composer fetches the OG card (`fetch_link_preview`) and
`renderPreviewImage` paints a 480px card in Velta's dark colors (`#1c1c26`)
to WebP (JPEG if this webview's `toBlob` does not return `image/webp`).
A "Sent with Velta" chip sits in the top-right corner, with a dim fill and
a hairline border. A landscape page image is drawn at the card width and
its own height; a portrait image stays in the 220px cover band. The live
card has no chip, and its image uses `max-width: 100%` plus a max-height
so the sides are not clipped. `_sendPreviewImage` writes
`uploads/lp-<ts>.webp` (or `.jpg`) and sends it as `viewtype: image` with
the draft as the caption. The recipient does not fetch the URL. Plain-text
messages still fetch on receive only when that side is `fetch`;
image, file and video captions do not (`receiveFetchesPreview`). Invite
links, `deltachat.id`, and hosts with no dot are not fetched. Tests:
`tests/link-preview-setting.test.mjs`.

## Voice messages

Attach → Voice message starts `MediaRecorder` (`getUserMedia({audio:true})`).
`#voice-rec` is the timer plus Cancel and Send. The blob is written to
`uploads/voice-<ts>.<ext>` and sent as `viewtype: voice` with that file.
Extension is the first recorder type the webview supports: `audio/mp4` →
`.m4a`, opus ogg → `.ogg`, else `.webm` (`voiceFileExt`). The core rejects
a Voice message with no attachment. Local groups hide the menu item (their
core rejects voice). `MessageData` has no duration; the `<audio>` element
reads it from the file. Tests: `tests/chat-account-isolation.test.mjs`.

## Tracking params on links (#89)

Not a media transform. `app/js/trackers.js` drops known tracker query
params when a link is pasted or opened (drawer **Strip tracking from
links**, default on). The baked preview and the voice file are separate.
Tests: `tests/trackers.test.mjs`.

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
