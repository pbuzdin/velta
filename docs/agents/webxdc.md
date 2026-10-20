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
- **Every webxdc response carries its own `Content-Security-Policy`**
  (`WEBXDC_CSP`, webxdc_serve.rs, 1.4.28): the app CSP in tauri.conf.json
  does NOT apply to custom-protocol responses, so without it mini-apps had
  unrestricted network access. KEEP: policy = webxdc origins + `data:`/`blob:`
  only, no remote hosts; `'unsafe-inline'`/`'unsafe-eval'`
  stay for scripts (apps and the injected `__TAURI_INTERNALS__` stub rely on
  them). Same shape as Delta Chat desktop's — except `webrtc 'block'`, which
  DC desktop ships but Chromium does not recognize (console warning per app,
  directive ignored); deliberately omitted. WebRTC is instead OFF: the shim
  stubs `RTCPeerConnection`/`webkitRTCPeerConnection` before the app's
  scripts run (webxdc-shim.js; a determined app can bypass via nested
  about:blank frames — documented ceiling).
- `webxdc_rpc` registers its waiter in `wxdc_pending` BEFORE sending the
  request, and ids use a counter (`wxdc-<n>`), not a timestamp — a fast
  response used to find no waiter, and parallel requests collided on
  nanosecond ids.

## No capture or location for webxdc (Phase 0 of research/webxdc-group-calls.md, 2026-10-20)

Finding (Chromium 14x, fake devices + auto-granting UI, `scripts/e2e-webxdc-media-deny.mjs`
and the PWA e2e): the opaque-origin webxdc frame was ALREADY refused by the
browser (`getUserMedia` → `SecurityError: Invalid security origin`, nested
about:blank too). But the Android shell had no origin check of its own:
wry's stock `RustWebChromeClient.onPermissionRequest` grants every
request from any frame once the OS permission exists, so the opaque-origin
rule in the WebView renderer was the only barrier. WebKit shells (macOS
WKWebView, Linux WebKitGTK) are not covered by these tests.

KEEP, all layers:
- Android `VeltaWebChromeClient.onPermissionRequest` denies unless
  `WebPermissionPolicy.mayCapture(origin)` (only `tauri.localhost`, the Velta UI).
  API 24/25 keep wry's client (no wrapper, `getWebChromeClient` needs 26) —
  there only the renderer rule applies.
- `Permissions-Policy: camera=(), microphone=(), display-capture=(), geolocation=(), …`
  on every webxdc response (`WEBXDC_PERMISSIONS_POLICY`, webxdc_serve.rs) and the PWA
  loader document (sw-route.js).
- iframe `allow` = `WEBXDC_FRAME_ALLOW` (webxdc-manager.js): autoplay + `'none'` for
  mic/camera/display-capture/geolocation.
- The shim pins `mediaDevices.getUserMedia/getDisplayMedia` to a NotAllowedError reject.
- Group calls never relax this: trusted apps get `webxdc.veltaCall`, the HOST captures.
Tests: tests/webxdc-media-deny.test.mjs, scripts/e2e-webxdc-media-deny.mjs, scripts/e2e-webxdc-pwa.mjs.

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

Refuses to open in a plain browser (no Tauri, not the wasm PWA): toast
"webxdc apps run in the Velta app" — the `webxdc.localhost` handler exists
only in the Tauri shell. The wasm PWA has its own host (next section).

## Wasm PWA host (Step A of docs/research/beam-pwa-research.md, 2026-10-16)

Files: `app/webxdc-host/sw-route.js` (importScripts'd by the generated
sw.js), `app/webxdc-host/frame.js` (loader, runs in the app frame), the
SAME `webxdc-shim.js` as native (build-pwa copies it into the dist),
`isPwaHost()`/`veltaBundle`/icon handler in webxdc-manager.js.
E2E: `node scripts/e2e-webxdc-pwa.mjs` (Chromium, stub core);
unit: tests/webxdc-pwa.test.mjs.

- Frame URL `<scope>webxdc-run/<account>/<msg>/<path>`. The SW answers the
  iframe NAVIGATION with a loader document (frame.js + shim inlined) and
  the header CSP `WEBXDC_FRAME_CSP`: `sandbox allow-scripts allow-forms
  allow-downloads allow-modals` (no allow-same-origin -> opaque origin) and
  only `blob:`/`data:` sources — no network, not even the PWA origin.
- Finding that shaped the design: **Chromium never routes an opaque-origin
  document's requests through the service worker** — neither the
  navigation of a frame whose sandbox ATTRIBUTE lacks allow-same-origin,
  nor any subresource of an opaque document (verified with Playwright). So:
  - KEEP: the PWA iframe attribute is `allow-scripts allow-same-origin
    allow-downloads allow-forms allow-modals` (attribute + header flags
    combine; the CSP header makes it opaque). Without allow-same-origin in
    the attribute the loader navigation is never intercepted (404).
  - KEEP: frame.js refuses to run unless `self.origin === "null"` and it
    is a child frame; the SW gives EVERY other same-scope iframe navigation
    a 403 with `CSP: sandbox` (an app navigating itself to a PWA URL, or
    third-party framing) and 403s top-level loads of app URLs.
  - Subresources cannot come from the SW: frame.js asks the host for the
    .xdc (`veltaBundle` call; host only answers the open app's own frame,
    for the open instance — same V-05/#63 rule as native), unzips it in the
    sandbox (stored + DecompressionStream deflate), makes blob: URLs, then
    rewrites index.html (src/href/srcset/style/inline modules, drops the
    app's own CSP meta), CSS (`url()`, `@import`) and ES modules (static
    specifiers -> blob:, `import()` -> `__veltaImport`, `import.meta.url` ->
    the virtual URL) and `document.write`s the result. Runtime patches map
    fetch/XHR (GET), element src/href setters, setAttribute, Worker and
    innerHTML-inserted elements. Multi-page apps: navigating to
    `other.html` goes through the SW loader again.
- Icons for chat cards: SW -> page `velta-webxdc-icon` -> `get_webxdc_blob`
  (icon.* only, current account; icons are public like on native).
- importFiles: host `<input type=file>` (user activation from the frame tap
  propagates to the parent). sendToChat: memfs `/uploads/` + send + remove.
- Realtime: not in wasm yet (Step B). getInfo carries `veltaRealtime:false`,
  the shim's `joinRealtimeChannel()` throws, `webxdc.veltaRealtimeAvailable`
  is false (Velta extension), host `realtimeJoin` rejects. Beam shows "Direct
  transfer is not available in the Velta web app yet" and disables sending
  and Receive; offers from status updates still list.
- Limits (document, don't regress silently): the frame can still navigate
  ITSELF to a remote URL (CSP cannot block navigation; no allow-popups /
  top-navigation, so only the frame) — same class as the WebRTC ceiling;
  WebRTC stub ceiling unchanged; regex-based module rewriting (an
  import-looking string literal is rewritten too), static import cycles
  unsupported (clear error), bare specifiers/import maps unsupported,
  Worker-internal relative fetches and CSS set via `element.style` with
  relative `url()` are not mapped, the first request of innerHTML-inserted
  elements is CSP-blocked before the fix-up. All apps share the PWA
  origin's URL space but each document is its own opaque origin: no
  persistent localStorage/IndexedDB (in-memory shim, as native). Firefox
  and Safari behaviour is unverified (Playwright Firefox runs no SW).

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
- Realtime channels (#138, wired 2026-10-15): the shim's
  `joinRealtimeChannel()` returns `{setListener, send, leave}` (one channel
  per app; `send` takes a Uint8Array ≤ 128 000 B, queued until the join
  resolved). Host (`webxdc-manager.js`): `realtimeJoin` →
  `send_webxdc_realtime_advertisement` (core joins the instance's
  iroh-gossip topic and mails a hidden advertisement), `realtimeSend` →
  `send_webxdc_realtime_data` (bytes as a JSON number array),
  `realtimeLeave`/app close → `leave_webxdc_realtime`; the core's
  `WebxdcRealtimeData {msgId, data}` event (rpc-core →
  `webxdc-realtime-data`) is posted to the open frame only while it is
  joined. Same JSON-RPC on desktop (sidecar) and Android (in-process core),
  so both shells are covered; the wasm PWA runs webxdc (see above) but has no
  realtime yet.
  Gossip carries no sender id and is lossy — apps must ack/retry.
  `listRealtimeAdapters()` still returns [].

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

## Shim rules learned in 1.4.72 (both hosts)

- Never set `color-scheme` on the app document: forcing `dark` gave white
  text on white backgrounds (poll app). The iframe element keeps Velta's
  scheme, which drives `prefers-color-scheme` (10141f7).
- `setUpdateListener(cb, serial)` is a lasting subscription: replay the
  stored updates after `serial` from `getStatusUpdates`, then deliver live
  ones; never call `cb` with a synthetic object (c91ee58).
- Info updates (`sendUpdate({info, href})`) become WebxdcInfoMessage rows
  with the app icon; tapping one opens the parent instance at `href`
  (query/fragment only). `sendStatusUpdate` forwards the whole update.
- Card hydration retries when the virtual scroller detaches the row.
