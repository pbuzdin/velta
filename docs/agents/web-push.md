# Web Push (wasm PWA)

Background "New message" notifications for the browser PWA while no Velta
tab is running. Android keeps its own UnifiedPush path (`push-settings.js`,
`UnifiedPushService.kt`); this note covers the browser only.

## Chain

1. Drawer → **Push notifications** (`<details data-webpush-section>`, shown
   only on the `worker-wasm` backend whose transport has
   `setPushDeviceToken`) → switch "Notify me when Velta is closed".
2. `app/js/web-push.js` `enableWebPush`: `Notification.requestPermission()`
   (inside the switch's change gesture) → `pushManager.subscribe({
   userVisibleOnly: true, applicationServerKey: VAPID_KEY })` → token
   `webpush:<endpoint>|<p256dh>|<auth>` (base64url, unpadded — what
   chatmail/notifiers `NotificationToken::from_str` splits on `|`).
3. `WorkerWasmTransport.setPushDeviceToken` → worker message
   `set-push-token` → `DeltaChat.set_push_device_token` in
   `packages/velta-wasm/rust/src/lib.rs` → `Accounts::set_push_device_token`
   (one token for EVERY account) + `maybe_network()` to wake IDLE loops.
   No production `core/` change and no wasm-series patch: the binding lives
   in the Velta wrapper crate.
4. Core (stock 2.63 `imap.rs register_token`): per transport whose relay
   advertises `XDELTAPUSH`, OpenPGP-encrypts the token to the notifier key
   and `SETMETADATA /private/devicetoken`. Relays without push support
   are skipped silently.
5. Relay → `notifications.delta.chat/notify` → VAPID-signed, RFC 8291
   encrypted payload `"ping"` → browser push service → SW `push` event.
6. SW (`scripts/build-pwa.mjs`): skips when a window client is focused AND
   visible; otherwise `showNotification('Velta', { body: 'New message',
   tag: 'velta-push', renotify: true })`. Tap → existing
   `notificationclick` (focus an in-scope window or open the scope; no chat
   id, so the app just comes up and syncs).

## KEEP

- The token is in core MEMORY only. `refreshWebPush` runs on every boot
  (after the account loads) and on the SW's
  `velta-push-subscription-changed` message; it never runs while the
  `velta-webpush` pref is off.
- `VAPID_KEY` must equal the notifier's key (same constant as
  `UnifiedPushService.kt`, ArcaneChat's `VAPID_KEY`). A mismatch makes the
  push service reject the notifier (FCM 403 → notifier 410) — no error in
  the browser. `tests/web-push.test.mjs` pins the two constants together.
  A subscription made under another key is dropped and recreated.
- Off = `subscription.unsubscribe()`; the dead endpoint answers 404/410 to
  the notifier. Nothing is cleared in IMAP METADATA (the core has no
  "unset token" API); the relay keeps a token that resolves to Gone.
- iOS: Safari needs iOS/iPadOS 16.4+ AND a home-screen install
  (`navigator.standalone`); the section shows the hint and a disabled
  switch otherwise. Safari also revokes subscriptions that receive pushes
  without a notification — the focused-client skip is a residual risk
  there (a focused app means the user sees the message anyway).
- The SW cannot fetch mail: the core lives in the page's worker.

## Verified (2026-10-20, box)

- `notifications.delta.chat/notify` with a raw `webpush:` token for a
  Chrome (FCM) subscription made with `VAPID_KEY` → 200 (FCM 201); the same
  with a random applicationServerKey → 410. So the notifier's VAPID key IS
  `VAPID_KEY`.
- Firefox (Playwright, Mozilla autopush over wss) subscribed with
  `VAPID_KEY`: the SW `push` event fired with data `"ping"` seconds after
  the `/notify` call. (Chrome on the box: FCM accepted, but GCM's port 5228
  is blocked, so no delivery to the browser.)
- wasm: `wasm-pack build` of velta-wasm on an apply-on-copy tree exports
  `set_push_device_token`; a dist built from it, booted in Firefox
  (`worker-wasm.js`, persist off), answers `set-push-token` with
  `push-token-set`. Generated sw.js passes `node --check`.
- A dist on an OLDER wasm (e.g. the current pwa-dist) fails the switch with
  "wasm core has no set_push_device_token (rebuild velta-wasm)": ship a new
  wasm-core run with this change before advertising the feature.

Not verified: the relay side (IMAP METADATA registration from the wasm
core — box blocks 993/465 and needs a real relay session), notification
display on a desktop/Android/iOS browser, iOS behaviour,
`pushsubscriptionchange`.
