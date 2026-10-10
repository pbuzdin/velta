# Android shell — agent notes

Extracted from AGENTS.md. The Android-side specifics of the Tauri shell:
in-app browser chain, background sync, keyboard/IME handling, text zoom and
on-device diagnosis.

## In-app browser chain (1.4.1 → 1.4.16)

`openInAppBrowser(url)` invokes `open_in_app_browser` (JNI →
`org.velta.InAppBrowser`). The chain, in order:

1. **Chrome Custom Tab** — the normal path. Launched from the ACTIVITY
   (`InAppBrowser.attach`): launching from the application context crashed
   with AndroidRuntimeException (modern androidx no longer adds
   FLAG_ACTIVITY_NEW_TASK for non-Activity contexts). Provider selection
   (1.4.16): the user's DEFAULT browser wins when it offers the
   CustomTabsService; else the first visible service provider; else
   `CustomTabsClient.getPackageName(CT_CANDIDATES)`. Earlier versions
   picked any provider by PackageManager order, which sent links to Chrome
   Dev while Edge was default. A bare CustomTabsIntent resolves like
   ACTION_VIEW, so devices whose default browser has no Custom Tabs
   support (vivo.browser) opened a full browser task — hence the explicit
   provider. KEEP: the `<queries>` block needs BOTH the
   CustomTabsService intent and ACTION_VIEW/https — package visibility
   hides the providers and the default browser on API 30+ otherwise.
   The `VeltaIAB` log tag carries `provider=… default=…` diagnosis lines.
2. **Default browser** — `InAppBrowser.kt` catches the launch failure
   (`launchUrl` does not fall back on its own) and re-launches via plain
   ACTION_VIEW + FLAG_ACTIVITY_NEW_TASK.
3. **Native second-WebView overlay** (`openWebView` via the
   `open_webview_browser` command): a fullscreen `android.webkit.WebView`
   over the activity (bar: host + open-external + close; BACK handled by an
   OnBackPressedCallback registered AFTER wry's so it wins while open —
   see `MainActivity.attach`; JS + domStorage on, file/content access off,
   no bridges). A top-level browsing context ignores X-Frame-Options;
   plain-http renders because the network security config permits
   cleartext app-wide (1.4.13; the SPA never top-level-navigates and the
   CSP blocks plain-http subresources, so the shell's own cleartext stays
   the loopback media server).
4. **JS iframe overlay** — last resort and dev only: sites sending
   X-Frame-Options are blocked by Chromium
   (`ERR_BLOCKED_BY_RESPONSE`); the bar's external-open button is the
   escape hatch.

JNI gotcha: `find_class` for app classes is unreliable from Rust worker
threads attached via `attach_current_thread` (boot classloader context), so
`org.velta.InAppBrowser` is resolved once and cached as a global ref in
`setApplicationContext`. System classes work from anywhere. Desktop keeps
its system-browser convention — `open_in_app_browser` is
`#[cfg(target_os = "android")]` and errors elsewhere.

## Background sync

`CoreService` is a `remoteMessaging` foreground service started from
`MainActivity.onCreate`; it keeps the process — and the in-process core —
alive after the app is backgrounded. Its persistent notification is tappable (#82):
a MAIN/LAUNCHER `PendingIntent` (immutable) aimed at the `singleTask`
`MainActivity`, with no data or extras so the `velta://chat` deep-link path of
message notifications (#20) is never entered (pinned by
tests/android-core-service-notification.test.mjs). While the UI is hidden, Rust's
`start_bg_event_poller` (lib.rs) drains `get_next_event_batch` itself (ids
prefixed `bg-`, routed via `RpcState.bg_pending` like the `wxdc-`
round-trips) and posts native notifications for IncomingMsg events. The
frontend reports page visibility via `set_ui_visible`. `MainActivity`
onStart/onStop sets a second flag: Home often leaves `document.hidden`
false and freezes the WebView, so the poller used to sleep while the
page's parked poll held IncomingMsg until the next open. The poller runs
when the page is hidden or the activity is stopped, and a page-poll
response that arrives in that state is notified as well (still forwarded
to the WebView). The page does not post its own notification. KEEP: the
poller paused while both flags say the UI is
up — ungated it steals events from the frontend's own polling. `onStart`
calls `maybe_network` and emits `velta-foreground` so the page refetches.
`CoreService` holds a partial wake lock and a default-network callback
(`maybe_network` / `maybe_network_lost`). A 90s kick while the activity
is stopped interrupts a half-open IDLE. Doze ignores the wake lock; the
page asks for the battery-optimization exemption once per cold start
until it is granted.

Notification titles: `bg_notify_incoming` defaults the title to "Velta" and
replaces it with the chat name via `get_basic_chat_info` — the RPC surface
has NO `get_chat` method, and a wrong method name fails silently
(`if let Ok`), leaving every push titled "Velta" (1.4.2 regression, fixed
1.4.3).

## Keyboard vs chat header (1.4.17)

With `enableEdgeToEdge()`, API 30+ ignores `adjustResize` — the system
PANNED the window when the soft keyboard opened and the chat header ended
up above the screen. KEEP all three parts of the fix:

- `android:windowSoftInputMode="adjustResize"` on `.MainActivity`
  (AndroidManifest.xml);
- the IME-insets listener in `MainActivity.onCreate` applying
  `ime().bottom` as content-view bottom padding while the keyboard is
  visible (closed-keyboard spacing stays with the page's
  `env(safe-area-inset-bottom)`);
- `interactive-widget=resizes-content` in the index.html viewport meta so
  the page's layout viewport resizes with the WebView.

## Mobile chat gestures (#35)

Phone only. The gestures run when the page is the overlay chat column
(`max-width: 820px`) and the pointer is not `(hover: hover) and (pointer: fine)`.
A wide window, and a narrow window with a mouse, keep the desktop layout
and do not swipe.

- Swipe right on a `.bubble` translates that bubble up to 64px. Releasing
  past 48px calls `_setReply`. Skipped when the chat is read-only, while
  messages are selected, and during Select text. Translate the bubble, not
  the row: the day chip, unread line, and read marker ride in the row.
- Swipe left on `#history-scroll` translates `#main` with the finger.
  Releasing past 72px, or 28% of the column width, calls `onBack`
  (`closeChat`, the same path as the header back button). `.swipe-back` on
  `.app` shows the sidebar while `.chat-open` would keep it
  `visibility: hidden`.
- A vertical move wins and stays a scroll. Reply-right and back-left do not
  run on the same finger (`_replySwipe` / `_backSwipe`). Any `touchmove`
  still cancels the long-press timer.
- `close()` cancels a back drag. A committed swipe parks `#main` at
  `translateX(100%)` with no transition before `.chat-open` drops, then
  clears that inline transform on the next frame. Clearing it in the same
  turn makes the .22s close slide run from `-100%` across the list.
- In that mobile layout `#history-scroll` is `overflow-x: hidden`, so the
  bubble slide does not scroll the history sideways.
- The close path must not leave a parked column behind (#86: a local chat's
  teardown threw, `.chat-open` stayed and the screen went blank). The swipe
  handler wraps `onBack` in try/catch and clears the inline transform if it
  failed; `closeChatUI` wraps `chatView.close()` in try/catch so the UI
  teardown always runs; `_typingStop` ignores a `TypingSender.stop()` error.

Pinned by `tests/chat-msg-update-hardening.test.mjs`. The same contract is
in AGENTS.md under "Mobile swipes (#35)".

## Text zoom

`MainActivity` pins the WebView's `textZoom = 100` (bounded retry until the
Tauri runtime creates the WebView) — the system font scale otherwise
applies text-only zoom that inflates text out of the px-sized boxes.
Scaling is owned by the app: drawer → Interface scale (CSS zoom, see
AGENTS.md §11).

## On-device diagnosis

All core/transport diagnostics are mirrored into `velta.log` (via
`js_log`) — pull over adb with
`adb shell run-as org.velta cat /data/data/org.velta/logs/velta.log`,
which requires `android:debuggable="true"` in the AndroidManifest
(diagnosis-only ceiling — strip from release builds). Scoped storage hides
`/sdcard/Android/data/org.velta` on Android 13+; Vivo also requires the
"Install via USB" developer toggle for `adb install`.

The Diagnostics chat's **DevTools** switch flips
`WebView.setWebContentsDebuggingEnabled` for `chrome://inspect` over USB.
The static call MUST run on the Android UI thread — calling it from a Rust
worker thread threw "Java exception was raised during method invocation"
(issue #12). `set_devtools` therefore posts through `org/velta/DevTools.kt`
(`DevTools.set(enabled)`: main-looper `Handler.post`).

## Desktop (Windows) shell debugging

Start the app with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`, then
drive the page over CDP (`/json/list` → WebSocket → `Runtime.evaluate`).
Synthetic OS clicks are unusable: a fullscreen topmost key-remapper overlay
swallows them, foreground locks block `SetForegroundWindow`, and
PrintWindow/DPI coordinate mismatches make blind clicking a lottery.
Helper scripts in the parent workspace `tools/`:
`shot-velta-window.ps1` (PrintWindow capture, DPI-aware),
`focus-velta.ps1` (raise + topmost), `click-at.ps1`, `who-is-at.ps1`
(which window owns a screen point).


## Share sheet for the QR screen (#37)

The Android WebView has no Web Share API, so "Share a link" on the QR screen
calls the shell command `share_text(text, title)` (lib.rs). It follows the
`get_battery_status` pattern: `Share` is cached as a JNI global ref in
`Java_org_velta_MainActivity_setApplicationContext`, then `Share.text(context,
text, title)` (Share.kt) starts an `ACTION_SEND` `text/plain` chooser with
`FLAG_ACTIVITY_NEW_TASK` (the stored context is the application context). It
returns false when no app can handle it, which becomes an error toast. Elsewhere
the page uses `navigator.share` when it exists and hides the button otherwise
(`app/js/qr-actions.js`). Like the rest of the Kotlin here it has no local
compile check - CI is the gate.

## Share into Velta (#97)

Outbound "Share a link" (#37, above) is a different path. This one is Velta
as the destination.

The share sheet lists Velta because `MainActivity` has one `ACTION_SEND`
filter and one `ACTION_SEND_MULTIPLE` filter (`AndroidManifest.xml`), each
with `DEFAULT` and mime types that OR: `text/plain`, `text/*`, `image/*`,
`video/*`, `audio/*`, `application/*`, `*/*`. Kotlin only adds the replay guard below;
`onNewIntent` already reaches `Rust.onNewIntent`. tao turns those intents
into `RunEvent::Opened` (plain text → `data:text/plain,…`, a text URL →
that https URL, files → `content://` or `file://`). `run()` appends every
URL to `OPENED_URLS` and emits `deeplink` as a wake-up. The page listens
first, then drains with `take_opened_urls`, so a burst during boot is not
lost and several photos are one picker. `get_initial_deeplink` still pops
one URL; the page does not call it. A desktop `deep-link://new-url` is not
in the queue: the plugin emits the URL and the page routes that payload.
Notification taps use the same queue (Android `Opened`, Windows toast
`on_activated`); a toast tap that only emits the URL does not open the chat.

`app/js/share-in.js` classifies the payload. `data:text/plain` is share
text. `content://`, `file://`, a Windows path, a UNC path, or an absolute
`/` path is a file. `velta://`, `dcaccount:`, `dclogin:`, `dcbackup:` and `openpgp4fpr:` are
not shares. `handleDeeplinkFromUrl` returns true when it consumed a chat,
backup, or invite link (a chat link with a bad token still counts); other
https, and any other scheme tao passed through because the text parsed as a
URL ("Re: x"), becomes share text.

Shares go through `createShareInbox` (`share-in.js`): boot drains the queue
after the chat list loaded and calls `shareInbox.ready()` last, so a
cold-start share is held, then each burst gets one picker, never two at
once. `visibilitychange` and `velta-foreground` drain again (a wake-up
emitted while the WebView was frozen is not lost; the shell keeps the URLs).
`offerShareNow` waits for a running profile switch, takes the full chat
list (fetching it when `state.chats` is only the diagnostics row or the
list search narrowed it), and opens "Share to…" (`buildSharePicker`: search
field, a chip per profile when there are several, chat rows that are not
`deaddrop`, `device`, or `readOnly`, p2p included; "No chat to share to.").
A profile chip switches and re-opens the picker on that profile. The
picked chat is opened and `ChatView.receiveShare` takes over: text only →
composer (appended to a draft); one jpg/png/gif/webp/bmp or video → the
attachment strip with the text as caption (the user taps Send); a document
or several files → sent at once (one file: text is the caption; several:
text first, then each file), "Sent to …" toast. `content://` is copied with
`resolve_content_uri`; a desktop path gets `allow_picked_path` and is
copied to uploads (`resolveAttachmentPath`), as the file picker does.

Root cause of "chat list not showing" (v1.4.64): `pickShareChat` built a
`velta-chat-item` per chat but never appended it, so the sheet was always
empty. `tests/share-flow.test.mjs` runs the real app.js block and asserts
the rows. `MainActivity.onCreate` also swaps a replayed SEND (launched from
Recents, or restored state) for `ACTION_MAIN` before `super.onCreate`, or
tao would offer the old share again.

Windows 11's Share flyout only lists packaged apps. Velta is unpackaged, so
`setup()` writes `%APPDATA%\Microsoft\Windows\SendTo\Velta.lnk` (target =
current exe, no `%1`). It is recreated only when that file does not contain
the exe path as UTF-16LE. Do not put anything else in Send to: each file
there is a menu entry. Send to passes paths as argv. A cold start queues
them in `set_initial_deeplink_from_env`. A warm start queues them in the
single-instance callback and leaves scheme URLs to the deep-link plugin,
which is the only `velta://` path. The same picker sends the file.

Skipped: Direct Share / ChooserTargetService, mailto, a separate
ShareActivity, and an MSIX share target. The Windows 11 Share flyout needs
package identity: a full MSIX, or a signed sparse package registered by the
installer (`uap:ShareTarget` + `AllowExternalContent`) whose activation the
exe would then read through WinRT `ShareOperation`. That is installer and
signing work, not a shell tweak; Send to covers files meanwhile. tao drops
`EXTRA_TEXT` unless the intent type is exactly `text/plain`, and with a file
share the text extra is ignored. Pinned by `tests/share-in.test.mjs`,
`tests/share-flow.test.mjs`, `tests/share-receive.test.mjs` and
`cargo test --lib opened_args_tests`. The manifest has no local compile
check; CI gradle is the gate.

## Notification preferences bridge (v1.4.54)

The drawer's nine notification switches push the full set to the shell via
`set_notify_prefs` (see AGENTS drawer contract). Shell side: `NotifyPrefs`
struct persisted to `notify-prefs.json` in app local data, plus a copy in
`filesDir` that the Kotlin layer reads directly:

- `bg_notify_incoming` gates on enabled / mentions_only ("Replies only")
  / show_content / system_new_msgs.
- `push_wakeup_impl` skips the scheduled fetch when `use_bg_connection`
  is off; `BackgroundFetchJob` checks the same file.
- `Notifications.kt` picks the channel id from vibration/sound prefs
  (Android freezes channel settings; id-switch = fresh channel).

WARNING: Kotlin changes here have no local compile check — the CI gradle
build is the only gate (a missing `CHANNEL_ID_QUIET` const broke the first
v1.4.54 android job while the local Rust build stayed green).
