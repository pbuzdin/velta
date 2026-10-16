# Velta Beam in the PWA — research (2026-10-16)

Refs: app/webxdc/send-direct/, app/js/webxdc-manager.js (PWA gate at line ~294),
docs/agents/webxdc.md, docs/iroh-layer-plan.md, docs/research/wasm-patches/.

## Current state
- PWA refuses webxdc: `webxdc-manager.js` toasts "webxdc apps run in the Velta app" when `!window.__TAURI__`.
- Native host: `webxdc://` protocol (Tauri) serves blobs, injects `webxdc-shim.js` (postMessage bridge),
  opaque-origin iframe (no `allow-same-origin`, KEEP), per-response `WEBXDC_CSP`, and the shim **stubs
  `RTCPeerConnection`** (DC desktop ships `webrtc 'block'` CSP; Chromium ignores it).
- Beam (`ui.js`) uses `joinRealtimeChannel()` for data and `sendUpdate` for offers.
- Core 2.63 pins **iroh 0.35.0 / iroh-gossip 0.35.0 / iroh-relay 0.35.0**. Wasm patch 0002 keeps
  `iroh`/`iroh-gossip` (default-features=false) as common deps; whether `peer_channels` actually runs
  on wasm32 is untested.

## A) Running webxdc in the PWA at all
**Implemented 2026-10-16** (docs/agents/webxdc.md "Wasm PWA host"). Correction to option 1 below:
Chromium does NOT send an opaque-origin document's navigation (sandbox attribute without
allow-same-origin) or subresource requests through the parent's SW. Shipped design: the SW serves
only the loader document (CSP-header sandbox -> opaque); the loader gets the .xdc from the host over
postMessage and serves every file from blob: URLs with HTML/CSS/module rewriting.
Options:
1. **Service-worker virtual origin (recommended).** SW intercepts `/webxdc/<acct>/<msg>/<path>` on the
   PWA origin and answers from the wasm core (`get_webxdc_blob`) via a MessageChannel to the page/worker
   holding the core. Iframe `sandbox="allow-scripts allow-forms allow-downloads"` (no allow-same-origin ->
   opaque origin, so it cannot read the PWA's IndexedDB/OPFS/SW-cache or cookies). Every SW response sets
   the same `WEBXDC_CSP` (`default-src 'self'`… no remote hosts, `connect-src 'none'`-style).
   Caveat: an opaque-origin iframe's subresource fetches are still controlled by the parent's SW only if
   the document was loaded from a SW-controlled URL — loading the iframe `src` from the PWA origin works
   (documents in sandboxed frames are still SW-intercepted by the creating origin's registration in
   Chromium/Firefox; verify Safari). Inject `webxdc-shim.js` in the served index.html as on native.
   Effort: 2–4 days (SW route, blob RPC, shim reuse, `sendUpdate`/`setUpdateListener` wired to the wasm
   JSON-RPC, tests on Chrome/Firefox/Safari).
2. **Separate origin** (e.g. `xdc.<pwa-host>` or per-app subdomain). Strongest isolation (real origin
   boundary, can then allow storage), but needs extra DNS/TLS for self-hosters (docs/pwa-self-host.md) and
   cross-origin blob delivery (postMessage streaming). 3–5 days + ops. Good later hardening.
3. **srcdoc/blob: iframe**: blob/srcdoc inherit-or-opaque quirks, relative asset loading breaks; reject.
Bridge: reuse the native shim protocol unchanged; the PWA host implements the same message handlers
against the wasm core JSON-RPC (`send_webxdc_status_update`, `get_webxdc_status_updates`,
`send_webxdc_realtime_data`, `send_webxdc_realtime_advertisement`, `leave_webxdc_realtime`, events
`WebxdcStatusUpdate`/`WebxdcRealtimeData`). This alone makes all non-realtime webxdc apps work.

## B) Transport 1: iroh in wasm (relay-only)
Status (sources below): iroh compiles to wasm32-unknown-unknown + wasm-bindgen since **0.33 (Feb 2025)**;
browser endpoints are **relay-only** (WebSocket to relay, still E2E-encrypted, no hole punching).
**iroh-gossip supports browsers since 0.33.** **iroh 1.0** is now released and CI-checks wasm builds;
0.35 is frozen, public n0 relays for 0.35 run until **2026-12-31**.
For core 2.63 (iroh 0.35): versions are new enough. Work needed:
- `peer_channels.rs`: endpoint builder must avoid native-only bits (UDP bind, `discovery-local-network`,
  metrics, port mapping); force relay-only mode on wasm; spawn via `n0-future`/wasm-bindgen-futures
  rather than our velta-tokio-wasm facade (iroh pulls its own runtime abstractions — likely
  conflicts with the facade's `tokio` rename need checking).
- Relay URL: core advertises the relay from chatmail `iroh_relay` metadata / n0 default; the browser
  must reach it over `wss://` (fine for HTTPS relays; ws-tcp-proxy not needed).
- Interop: native peers join the same gossip topic and reach the browser through the shared relay —
  **full interop with Delta Chat and native Velta, Beam unchanged.**
- Risk: native-UDP-only code paths in iroh-net-report/portmapper under 0.35 default-features=false;
  bundle size (+~1–2 MB wasm); throughput limited by relay (rate-limited on public n0 relays — large files
  through a relay is slow and costs the relay operator).
Effort: 4–8 days (compile + runtime spike 2–3, fixes/patches 2–3, testing with native 1–2). Upgrading
core to iroh 1.0 is upstream's job; don't fork that.
Privacy: browser IP visible only to the relay (same as mail server trust model); no peer IP leak.

## C) Transport 2: WebRTC data channels
Signalling via `sendUpdate` (persistent, slow, visible in chat) or better via realtime messages
(needs B) — without iroh, signal over status updates (ephemeral-ish, small SDP+ICE, 2–4 messages).
ICE: core exposes chatmail TURN via `ice_servers` (calls.rs); host passes them to the app.
- CSP/policy: DC webxdc spec forbids internet access; WebRTC is explicitly blocked (DC desktop
  `webrtc 'block'`, Velta shim stubs RTCPeerConnection). A Velta-only exception must be keyed on the
  **built-in app identity** (host-known message whose blob hash matches bundled send-direct), never on
  manifest claims. Safer: keep RTCPeerConnection out of the iframe entirely and run it in the **host**,
  exposing a narrow `webxdc.velta.directChannel(peer)` API; host controls ICE servers and can force
  `iceTransportPolicy:"relay"` to hide IPs.
- Interop: works PWA<->native Velta (WebView2/WebKitGTK/Android WebView have RTCDataChannel; WebKitGTK
  needs WebRTC enabled — verify). **No interop with other Delta Chat clients** (they block WebRTC);
  Beam must keep the iroh path for them.
- Privacy: direct ICE leaks local/public IPs to the peer (and STUN server); relay-only via TURN hides
  them at the cost of TURN bandwidth. Signalling in status updates leaves SDP in chat history unless
  sent as realtime/ephemeral.
Effort: 5–8 days (host-side RTC broker, signalling protocol, Beam dual-transport, policy gate, tests).
Benefit: real P2P throughput even from a browser; independent of iroh.

## D) Other options
- **Lufi/HTTP upload fallback** (core already has large-file/upload paths, docs/agents/large-file.md):
  works everywhere incl. Delta Chat, store-and-forward, no realtime. 1–2 days if reused. Server sees
  ciphertext only if encrypted client-side; costs storage.
- **WebSocket relay on the user's chatmail relay** (ws-tcp-proxy style blob pipe): simple, but a
  Velta-only protocol and server component; iroh relay already *is* this, standardized. Not recommended.
- **No-op**: keep "open in Velta app" for Beam only after A lands.

## Recommendation
1. Do **A (SW virtual origin, opaque sandbox, reused shim)** first — prerequisite for anything, unlocks
   all ordinary webxdc in the PWA. ~3 days.
2. Then **B (iroh relay-only in wasm)**: keeps Beam's code and wire protocol, interops with every
   Delta Chat/Velta peer, no IP exposure, no WebRTC policy exception. Spike first (compile `peer_channels`
   to wasm32, join a topic with a native peer via relay). ~4–8 days.
3. Keep **C** as an optional later speed-up between Velta clients (host-brokered, TURN-relay policy by
   default), and **D Lufi** as the fallback when realtime fails.
Total for A+B: ~7–11 days.

## Sources
- iroh WebAssembly & browsers docs: https://docs.iroh.computer/languages/wasm-browser
- iroh 0.32 browser alpha: https://iroh.computer/blog/iroh-0-32-0-browser-alpha-qad-and-n0-future
- iroh 0.33 browsers: https://www.iroh.computer/blog/iroh-0-33-0-browsers-and-discovery-and-0-RTT-oh-my
- iroh 1.0 + 0.35 relay support schedule: https://www.iroh.computer/blog/v1
- iroh changelog: https://www.iroh.computer/changelog
