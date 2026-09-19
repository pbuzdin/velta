# Webxdc runtime — agent notes

Extracted from AGENTS.md so the runtime narrative can grow without inflating
the standing read. Rules marked KEEP are do-not-regress.

## Runtime and sandbox

- The `webxdc://` protocol handler (lib.rs) serves `<account>/<msg>/<path>`
  blobs via `webxdc_rpc` round-trips (ids prefixed `wxdc-` are routed by the
  response forwarders into `wxdc_pending` — NOT emitted to the WebView).
- The handler injects `webxdc-shim.js` (include_str!) into the app's
  index.html. The shim defines `window.webxdc` over postMessage; the host
  relays to `get_webxdc_status_updates` / `send_webxdc_status_update`,
  tracking per-instance serials.
- Sandbox is opaque-origin: the iframe omits `allow-same-origin` on purpose.
  KEEP: never re-add it — all webxdc apps share the `webxdc.localhost`
  origin, so same-origin would let a malicious app read every other app's
  blobs. The shim backs `localStorage`/`sessionStorage` with in-memory
  storage because real storage throws in opaque origins.
- CSP: `frame-src` + `img-src` carry the `webxdc.localhost` origins — keep
  them when editing the CSP (all three places, AGENTS.md §8).

## WebView2 crash workaround

Tauri's core+plugin init scripts run in opaque-origin frames and throw
`Cannot read properties of undefined (reading 'plugins')`. `webxdc_serve`
stubs `window.__TAURI_INTERNALS__` (plugins/metadata) into the served
index.html before them so the frame's console stays clean — the frame never
legitimately uses Tauri APIs.

## Path handling

`webxdc_serve` aliases `webxdc.js` to the shim (apps using the dev-server
convention) and resolves un-prefixed absolute paths (`/assets/…`, vite
default base) against `OPEN_APP`, the app whose index.html was served last —
one app open at a time makes that safe; spec-compliant apps use relative
paths.

## openWebxdc (1.4.12+)

Refuses to open in a plain browser: toast "webxdc apps run in the Velta
app" — the `webxdc.localhost` handler exists only in the Tauri shell
(before this, the overlay opened with every asset 404ing).

## sendToChat / importFiles (1.4.12+, spec shapes 1.4.13)

- `sendToChat`: the official `webxdc.d.ts` passes `{file: {name, blob|base64}}`
  — plus a legacy raw-File shape and text-only sends. The shim normalizes and
  ships the Blob over the postMessage bridge (structured clone); the host
  confirms via modal, stages the file with the image-send pipeline
  (`resolve_upload_path` + `plugin:fs|write_file`) and sends it as a file
  message into the app's chat — that is what email-composer apps need.
- `importFiles` (app-side attach picker): tauri dialog open (extension filter
  only — mimeTypes in the filter are ignored, a dialog-plugin ceiling),
  `resolve_content_uri` for Android content:// picks, bytes read via fs and
  returned to the app as File objects over the bridge.
- Realtime (low-latency) channels are NOT wired — apps relying on them
  degrade gracefully to status updates.

## App card in chat history (1.4.17)

- Shows the manifest name (never the `.xdc` filename), the summary or the
  official client's "App" fallback, and the manifest icon — or a letter tile
  with the app initial (`.webxdc-ico-letter`) when the app ships none. The
  generic glyph is only a pre-hydrate placeholder.
- KEEP (two halves, keep both): a failed `getWebxdcInfo` RPC stays UNcached
  in webxdc-manager's `infoCache` (return the fallback without caching), and
  chat-view retries once after 2s. Caching the generic fallback froze
  forwarded-app cards on filename + generic glyph (1.4.14–1.4.16 regression
  on forwarded copies). Also KEEP: `iconImg.style.display = "block"` beats
  the CSS `display: none` default — `style.display = ""` cannot.
