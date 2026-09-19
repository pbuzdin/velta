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
alive after the app is backgrounded. While the UI is hidden, Rust's
`start_bg_event_poller` (lib.rs) drains `get_next_event_batch` itself (ids
prefixed `bg-`, routed via `RpcState.bg_pending` like the `wxdc-`
round-trips) and posts native notifications for IncomingMsg events. The
frontend reports visibility via `set_ui_visible`; events the poller
consumed never reached the WebView, so the JS `visibilitychange` handler
refetches the chat list and open chat on resume. KEEP: the poller gated on
`UI_VISIBLE` — ungated it steals events from the frontend's own polling.
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
