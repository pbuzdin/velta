# Velta — Agent Guide

This document is written for AI coding agents that need to work on the Velta
project. Read it first. It describes the repository layout, technology stack,
build/test commands, and conventions as they actually exist in this checkout.

> **Scope note:** This repository is a Velta-specific workspace layered around a
> copy of the upstream [Delta Chat core](https://github.com/chatmail/core)
> (version `2.60.0`). The `core/` directory is effectively a vendored copy of
> that Rust project. Wrapper code for Velta's own clients lives in `app/`,
> `velta-app/`, `velta-core-service/`, and `deltachat-backend/`.

---

## 1. Project overview

**Velta** is a cross-platform Delta Chat client built as a Progressive Web App
(PWA) that can be hosted in several shells:

- **Tauri desktop/Android app** (`velta-app/`) — the web UI is embedded in a
  system WebView and the Delta Chat Rust core is linked in-process.
- **Background Android service** (`velta-core-service/`) — a headless APK that runs
  the core as a foreground service and exposes it to the PWA over a loopback
  WebSocket/HTTP bridge.
- **Standalone browser** — the PWA can be served from a static host and falls back
  to a mock core for demo/development.

The unifying frontend is in `app/` (vanilla JavaScript, custom web components,
no bundler). It auto-detects the available backend via `app/js/transport.js` and
speaks a JSON-RPC interface to the real core, or falls back to
`app/js/mock-core.js`.

A prebuilt set of command-line RPC servers for Windows and Android is kept in
`deltachat-backend/`.

---

## 2. Directory layout

```
.
├── app/                      # Velta PWA frontend (vanilla JS, no build step)
│   ├── css/main.css          # single stylesheet
│   ├── icons/                # PWA/Tauri icons, including source asset
│   ├── js/                   # application logic
│   │   ├── app.js            # bootstrap, chat list, navigation, account switcher, relay status line, multi-relay manager, modals, PWA lifecycle
│   │   ├── avatar.js         # contact avatars: fingerprint color-grid identity tiles
│   │   ├── boot-net.js       # pre-app.js error/unhandledrejection net: Diagnostics sink once app.js lives, #boot-error banner before
│   │   ├── chat-view.js      # message history, composer, selection actions, webxdc cards, bot command chips
│   │   ├── calls.js          # audio calls: WebRTC media + core signaling state machine
│   │   ├── components.js     # Elena-based web components (<velta-avatar>, <velta-chat-item>, <velta-chat-head>, <velta-video>)
│   │   ├── diagnostics.js    # diagnostics chat store + event sink + shared console-style row renderer
│   │   ├── invites.js        # invite-link registry (mirror domains), parsing, invite cards, settings modal
│   │   ├── local-chat.js     # local chat core adapter: Proxy interceptor for p2p:<peerId> chats, media transfers/progress, offline queue + auto-flush (see 5.4 / conventions)
│   │   ├── markdown.js       # escape-first message markdown: bold/italic/underline, links, lists + bot command extraction
│   │   ├── media.js          # media URL helpers: blobfile:// protocol (boot-probed) → loopback server → asset protocol + per-element fallback
│   │   ├── p2p.js            # Local chat UI: drawer toggle, list card, pairing, legacy 1:1 modal (Tauri only)
│   │   ├── poster.js         # lazy WebP poster extraction + disk cache
│   │   ├── qr-scan.js        # code acquisition: paste or camera scan (native BarcodeDetector probed with a 2s timeout, vendored jsQR fallback — many Android WebViews ship no Shape Detection API or one whose detect() hangs)
│   │   ├── mock-core.js      # in-memory demo core implementing the JSON-RPC surface
│   │   ├── rpc-core.js       # JsonRpcCore wrapper over transports + event mapping
│   │   ├── transport.js      # backend auto-detection (Tauri, WebSocket, HTTP, mock)
│   │   ├── webxdc-manager.js # webxdc host: opaque-origin sandboxed app overlay, shim postMessage relay, per-instance serials
│   │   └── ui.js             # drawer, modals, context menus, toasts
│   ├── vendor/               # third-party frontend libraries
│   │   ├── elena.js          # lightweight web-components library
│   │   └── virtual-scroller.js
│   ├── diag.html             # connection diagnostics page for the service bridge
│   ├── index.html            # main app shell
│   ├── manifest.webmanifest  # PWA manifest (name: "Velta")
│   └── sw.js                 # app-shell service worker (CACHE constant bumped each release)
│
├── core/                     # Delta Chat core Rust library (upstream copy)
│   ├── src/                  # main library (~64 Rust modules, see core/src/lib.rs)
│   ├── deltachat-ffi/        # C FFI bindings (libdeltachat)
│   ├── deltachat-jsonrpc/    # JSON-RPC API wrapper over the core
│   ├── deltachat-rpc-server/ # stdio JSON-RPC server binary
│   ├── deltachat-rpc-client/ # Python JSON-RPC client
│   ├── deltachat-repl/       # CLI REPL for the core
│   ├── python/               # Python CFFI bindings
│   ├── benches/              # Rust benchmarks
│   ├── fuzz/                 # Fuzz targets
│   ├── scripts/              # CI helper scripts (clippy, deny, tests, wheels)
│   ├── test-data/            # fixtures for Rust tests
│   ├── Cargo.toml            # workspace manifest, version 2.60.0
│   ├── CMakeLists.txt        # CMake install wrapper for libdeltachat
│   └── deny.toml             # cargo-deny policy
│
├── velta-app/            # Tauri v2 wrapper
│   └── src-tauri/
│       ├── Cargo.toml        # depends on deltachat-jsonrpc (path on Android)
│       ├── tauri.conf.json   # frontendDist: ../../app, version bumped each release
│       ├── capabilities/     # Tauri v2 ACL (default.json, mobile.json)
│       ├── gen/android/      # generated Android project (cargo tauri android)
│       ├── src/
│       │   ├── lib.rs        # Windows sidecar bridge + Android in-process core
│       │   ├── p2p.rs        # Local chat engine: iroh (relay-less) QUIC pairing + 1:1 chat
│       │   ├── bin/          # p2p-hub.rs — headless terminal hub (debug helper)
│       │   └── main.rs       # Tauri entry point
│       └── build.rs
│
├── velta-core-service/       # Android foreground-service (JNI core + loopback WS bridge)
│   ├── rust/                 # JNI crate (librpc_core.so)
│   ├── android/              # Gradle project; builds velta-core-service.apk
│   └── README.md
│
├── deltachat-backend/        # Prebuilt deltachat-rpc-server binaries
│   ├── windows-x86_64/
│   └── android-arm64/
│
├── signing/                  # local signing keystore (untracked)
└── tools/                    # icon generation, WSL APK build/sign helpers,
                              serve-dev.py (no-cache static server for app/)
```

Not tracked (local runtime/build artifacts): `accounts/` (local core account
databases), `*.apk` builds, `signing/*.keystore`.

---

## 3. Technology stack

| Layer | Technology |
|-------|------------|
| Frontend | Plain HTML/CSS/ES modules, no transpiler or bundler |
| Components | [Elena](https://github.com/arielsalminen/elena) (`@elenajs/core` v1.0.1, vendored as `app/vendor/elena.js`) |
| Virtual list | [virtual-scroller](https://github.com/catamphetamine/virtual-scroller) (`virtual-scroller-dom` build, vendored as `app/vendor/virtual-scroller.js`) |
| Desktop/Android shell | [Tauri v2](https://github.com/tauri-apps/tauri) (`velta-app/src-tauri`) |
| Core runtime | Rust, Tokio async runtime, SQLite (sqlcipher) |
| Crypto | rPGP, Autocrypt, SecureJoin, TLS via rustls or native-tls |
| Networking | async-imap, async-smtp, Iroh gossip, shadowsocks proxy support |
| Core protocol | JSON-RPC 2.0 over Tauri IPC, WebSocket, HTTP, or stdio |
| Android core bridge | JNI (`velta-core-service/rust`) + foreground service |
| Python bindings | CFFI (`core/python`) and JSON-RPC (`core/deltachat-rpc-client`) |

The Rust toolchain required for the core is **1.89+** (see `core/Cargo.toml`).
Tauri (`velta-app`) requires Rust **1.77.2+** and Node.js **22+** (see the
README's requirements section).

---

## 4. Build and test commands

### 4.1 Core Rust library (`core/`)

```bash
cd core   # run from WSL — native Windows cargo fails in openssl-sys (SQLCipher)

# Run all Rust tests; use nextest — plain `cargo test` flakes a varying
# set of ~4 time-shift tests per run (see COREUPDATE.md §4)
cargo nextest run --workspace --locked

# Run only the default non-ignored tests (the fast set)
cargo test

# Run expensive tests marked #[ignore]
cargo test -- --ignored

# Build the C FFI library
cargo build -p deltachat_ffi --release

# Build the stdio JSON-RPC server
cargo build -p deltachat-rpc-server --release

# Run the REPL
cargo run --locked -p deltachat-repl -- ~/profile-db

# Linting / CI quality checks
scripts/clippy.sh          # cargo clippy --workspace --all-targets --all-features
scripts/deny.sh            # cargo deny --workspace --all-features --locked check
scripts/codespell.sh       # spellcheck source code
```

Build profiles are tuned for size in `Cargo.toml`:
- `dev` uses `opt-level = 1` and abort-on-panic.
- `release` uses `opt-level = "z"`, LTO, single codegen unit, and stripping.

### 4.2 Velta PWA (`app/`)

There is **no build step** for the PWA. Open `app/index.html` directly in a
browser, or serve `app/` from any static web server. The app will use the mock
core unless a real backend is reachable.

To refresh the service-worker cache after editing, bump the `CACHE` constant in
`app/sw.js`.

### 4.3 Tauri desktop/Android app (`velta-app/`)

```bash
cd velta-app

# Desktop dev run
cargo tauri dev

# Build Windows installer
cargo tauri build

# Android (requires Android SDK/NDK)
cargo tauri android init
cargo tauri android dev
cargo tauri android build
```

**Never build the Android APK with `velta-app/src-tauri/binaries/` present.**
That directory holds the Windows sidecar staged for the desktop installer
(README "Build locally"); `tauri.conf.json` lists it under `bundle.resources`,
and Tauri packages resources verbatim into every target — including the APK's
`assets/` (+22 MB of useless Windows PE; 68 MB APK instead of ~45 MB). The
`tools/wsl-android-build*.sh` scripts delete the directory as a guard; if you
build by hand, remove it first.

Note: `velta-app/src-tauri/Cargo.toml` currently pins the core via git. For
local development against the bundled `core/`, uncomment the `path` dependency.

### 4.3.1 Rebuilding the Windows sidecar from the vendored core

`cargo build -p deltachat-rpc-server --release` in `core/` builds vendored
OpenSSL (rusqlite `bundled-sqlcipher-vendored-openssl` +
async-native-tls/vendored). On a stock Windows toolchain this fails twice —
both failures were hit and cost a 13-minute dead build; never repeat them:

- **Perl must be Strawberry Perl (or another full Windows perl).** Git Bash's
  bundled perl is missing core modules — OpenSSL's Configure aborts with
  `Can't locate Locale/Maketext/Simple.pm in @INC` (via `Params/Check.pm` →
  `IPC/Cmd.pm`). A portable Strawberry zip extracted to `tools/` and put
  first on `PATH` works; no installer or admin needed.
- **NASM is needed for asm builds.** Without it, set `OPENSSL_NO_ASM=1`
  (builds fine, skips hand-tuned assembly).

Then copy `core/target/release/deltachat-rpc-server.exe` to
`velta-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe`
*and* `velta-app/src-tauri/binaries/deltachat-rpc-server.exe`, and verify the
swap by piping a `get_system_info` JSON-RPC request into the exe's stdin —
it must report the vendored core's version (v2.60.0 since 1.3.30; the
previous prebuilt was silently v2.59.0, which the drawer footer exposed).
`.github/workflows/build-windows.yml` does the same via
chocolatey-installed StrawberryPerl + NASM.

### 4.4 Android background service (`velta-core-service/`)

The skeleton currently contains only Cargo/Gradle manifests. To rebuild when the
source is added:

```bash
cd velta-core-service/rust
CC_aarch64_linux_android=$NDK/aarch64-linux-android24-clang \
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android24-clang \
cargo build --release --target aarch64-linux-android

cp target/aarch64-linux-android/release/librpc_core.so \
   ../android/app/src/main/jniLibs/arm64-v8a/

cd ../android
gradle assembleDebug
```

### 4.5 Python bindings (`core/python/` and `core/deltachat-rpc-client/`)

```bash
cd core/python
pip install -e .
pytest

cd core/deltachat-rpc-client
pip install -e .
pytest
```

Both Python projects use `pyproject.toml`, require Python 3.10+, and configure
`black`/`ruff`/`isort` with line length 120.

---

## 5. Code organization

### 5.1 Frontend (`app/`)

- `app/js/transport.js` is the central adapter. It probes, in order:
  1. Android WebView native bridge (`window.VeltaBridge`)
  2. Tauri IPC (`window.__TAURI__`)
  3. WebSocket to `ws://127.0.0.1:20808`
  4. HTTP to `http://127.0.0.1:20809/rpc`
  5. `MockCore` fallback
- `app/js/rpc-core.js` wraps any transport with a JSON-RPC client, maps core
  events to UI events, and exposes the same API surface as `mock-core.js`. It
  additionally provides the multi-account surface used by the drawer switcher
  (`getAllAccounts`, `switchAccount`, `addAccountWithQr`), the relay status
  primitives (`getConnectivity`, `connectivity-changed` events,
  `send-activity` from `sendMessage` until `MsgDelivered`/`MsgFailed`), the
  multi-transport relay surface (`listTransports`, `checkQr`,
  `addTransportFromQr`, `deleteTransport` — removal is immediate since core
  2.60.0, the core refuses only the last relay and re-elects sending;
  `transports-modified` events drive the reactive relay line), the
  second-device backup
  transfer (`provideBackup`, `getBackupQr`, `addAccountWithBackup` with the
  same two epoch boundaries as `addAccountWithQr`, `importBackup` (file
  restore into the current account, fire-and-forget + `imex-progress`),
  `stopOngoingProcess`;
  transfer progress arrives as `imex-progress` events, 1000 = done, 0 =
  failed), the vCard surface (`parseVcard`, `importVcard`, `makeVcard`) and
  `getMessageHtml` (original body of messages the mail simplifier cut, marked
  by a trailing " [...]"). It also exposes `createQrSvg` for rendering
  arbitrary tickets as QR. Wire types are normalized at this
  boundary (e.g. drawer taps hand ids through dataset attributes and are
  always strings — `switchAccount` coerces to u32).
- **Account isolation contract** (`rpc-core.js` + `app.js` + `chat-view.js`):
  the core keeps an `accountEpoch`, advanced twice around every account
  transition — `account-changing` fires synchronously at the start (the app
  tears down chat/popups/drawer/search state), `account-changed` fires in a
  `finally` after selection succeeds or fails (the app refreshes accounts and
  the chat list). Every multi-step RPC captures its entry account and passes
  that snapshot across awaits; cache writes, UI event emissions and async
  message decoration are dropped when the epoch no longer matches. Foreign
  or unattributed account events (`contextId`) never mutate state.
  `ChatView` sessions are invalidated by both `close()` and the epoch;
  unsent text/replies are drafts keyed by (account, chat) in memory.
  `closeAllPopups()` settles confirmations (dismissal = cancel). Keep this
  Regression suites live in
  `tests/` (see §7.2).
- **Event long-poll contract** (`rpc-core.js`): the backend parks
  `get_next_event` until an event exists and hands each event to exactly one
  waiter. Event polls therefore use a dedicated 240 s backstop
  (`eventPollTimeoutMs`) instead of the 30 s RPC timeout, and an expired poll's
  entry stays registered so its late response is dispatched instead of
  dropped. Don't replace it with a normal `_call`.
- `app/js/app.js` owns the chat list, navigation, modals, diagnostics chat, and
  the PWA shell. It also runs a DOM-budget watchdog that samples node counts.
  It owns the **relay status line** (`#relay-line`, thin strip below the
  sidebar header): one equal-width segment per configured relay (up to
  `MAX_RELAYS = 5` in the core, `configure.rs`), each colored by that relay's
  own status — green connected / yellow connecting or retrying / red
  unreachable / blue demo or local-chat mode. Per-relay status comes from
  parsing the core's `get_connectivity_html` (the only per-transport status
  the core exposes; ceiling noted in `parseConnectivityHtml`). With one relay
  the line is the old single bar; the combined `get_connectivity` view still
  drives the 45 s NotConnected grace and the line's overall semantics, with
  animated dashes while a message is in flight to the relay (driven by
  rpc-core's `send-activity`). Hovering the line (or pulling down at the top
  of the chat list on mobile — touch listeners on `#chat-list`) reveals the
  **relay detail bar** (`#relay-detail`, absolutely positioned inside
  `.relay-zone` so it overlays the chat list instead of pushing it down):
  one row per relay with a state dot, domain, status text and the relay's
  quota (usage/limit + percent, parsed from the connectivity page's
  `quota-list`; same HTML-parsing ceiling as the segments). The transport
  `<li>`s nest the quota `<ul>`, so `parseConnectivityHtml` slices the
  transports section and matches each transport to the next `<li
  class="transport">` / end of section — a first-`</li>` match silently
  truncates the quota. It also owns the **multi-relay manager**
  (`openRelaysModal`, reached from the drawer's "Relays of this profile…" and
  the profile modal's Transport row): `list_transports` for the list,
  `delete_transport` for removal (immediate since core 2.60.0: the core
  refuses only the *last* relay, re-elects the sending transport as needed
  and informs contacts via keyupdate messages; `transports-modified` events
  refresh the modal and status line live),   `add_transport_from_qr`
  with `check_qr` validation and `configure-progress` step UI for adding.
  `addRelayFlow` also takes a preset code, so a clicked/pasted `dcaccount:`
  deeplink (`handleDeeplinkFromUrl` → `chooseRelayOrNewProfile`) can offer
  "add the relay to this profile" alongside the legacy "create a new
  profile" path (`addAccountFromInvite`). Android registers the raw
  `dcaccount:`/`dclogin:`/`dcbackup:` schemes as intent filters; raw scheme
  URLs are opaque (no query/hash to parse), so `extractInviteLink` matches
  them with a regex and `extractBackupLink` routes `dcbackup:` deep links
  into `receiveSecondDeviceProfile` (presetCode).
  Sending always goes through the primary relay (`configured_addr`); the
  Relays modal offers **"Use for sending"** per non-primary relay
  (`rpc-core.setSendRelay` → core `set_config("configured_addr", …)`, which
  republishes/re-signs the key, syncs, clears the SMTP queue — queued
  messages carry the old From — and restarts IO). The segmented status line
  marks only the sending relay's segment with the sending dashes. It also owns the **second-device flow** (`secondDeviceFlow`,
  drawer → "Add a second device…"): the old device shows a `provide_backup`
  QR (the `get_backup_qr_svg` design card with the `.qr-self` v-logo badge on
  the reserved circle) and waits, completion detected via
  `imex-progress`; the new device scans/pastes a `DCBACKUP<n>:…` code (the
  core's format — validate with `/^dcbackup\d*:/i`, not a bare `dcbackup:`),
  and `addAccountWithBackup` imports it into a fresh account — the receive
  path is `receiveSecondDeviceProfile`, shared with the splash. The
  **Welcome to Velta** splash (`showSplash`) is created **on demand**, not at
  boot: boot() shows it only when the account is unconfigured (setup screen:
  large logo, tagline, three setup paths, and a collapsed app-log footer fed
  from the diagnostics store — create a profile on a relay (input or
  camera scan of a relay QR, permission only on tapping Scan), add as second
  device (dcbackup receive), and restore from a backup file (Tauri file
  dialog → `resolve_content_uri` on Android → `importBackup`, fire-and-forget
  with `imex-progress`, app restarts on success)) or when the core failed to
  answer after its retries (log surface). Returning users with a configured
  profile never see it — do not regress this into an unconditional boot splash.
- **Boot hang on Android (do not regress):** `tauri-plugin-notification`'s
  `requestPermission()` can hang forever on some Android 13+ builds (Vivo)
  once the dialog has been dismissed — boot() used to die silently at its
  first `await`, producing a dead UI with an amber relay line. Never await a
  plugin permission call without a timeout: callers race it (2.5 s). Since
  1.3.26 the ask happens only after the user creates or restores an account
  (`askNotificationPermission()`, flag-gated after the restore reload) — not
  at boot. Diagnostics are mirrored to velta.log (js_log) regardless, so a
  hang stays pullable via adb even when no splash is on screen.
- **On-device diagnosis:** all core/transport diagnostics are mirrored into
  `velta.log` (via `js_log`) — pull over adb with
  `adb shell run-as org.velta cat /data/data/org.velta/logs/velta.log`,
  which requires `android:debuggable="true"` in the AndroidManifest (a
  diagnosis-only ceiling — strip it from release builds). Scoped storage
  hides `/sdcard/Android/data/org.velta` from adb on Android 13+; Vivo also
  requires the "Install via USB" developer toggle for `adb install`. The drawer's saved-relays
  bookmark list was removed —
  profile = identity (drawer), relay = property of a profile (Relays modal).
  Its `showChatInfo` is the contact/chat profile modal: the 168px photo
  avatar beside the captioned identity tile, action buttons (Send message,
  Share profile via `navigator.share` with the personal i.delta.chat invite
  link, Edit name, Block), and Address / Profile key / Last seen / Chats in
  common rows. Group message sender avatars open the same modal for their
  contact (`openContactProfile`).
- `app/js/chat-view.js` owns the conversation history (virtualized via
  `virtual-scroller`), composer, selection mode, and the delete-message dialog.
  Rows must NOT get `content-visibility` — the scroller measures mounted rows
  itself (ResizeObserver), and a row collapsing to its `contain-intrinsic-size`
  placeholder when scrolled out of view desyncs the scroller's height cache
  (scroll jumps on remount; "height has changed from 52 to 436" warnings).
  Day chips are rendered inside the first message row of each day
  (`dayFirst` flag), never as separate list items: the scroller's diff needs
  the whole previous items array to appear contiguously after a prepend, and
  separator items broke that on day-crossing batches — failed diffs forced a
  full relayout with estimated heights and no scroll restoration (the
  "scroll jumps more and more" bug when paging up). Keep `_loadOlder`
  prepends pure message prefixes.
  Bubbles use `contain: layout style` but not paint (the reply pill overflows
  the bubble edge); `.chat-item` cards use full `contain: layout paint style`.
  It also owns the **shared-contact cards** (messages with viewtype `Vcard`:
  avatar/name/addr hydrate from the vCard attachment via `parseVcard`; tap
  imports via `importVcard` and opens the DM), the **Read more** button for
  messages the mail simplifier cut (" [...]" suffix → `getMessageHtml`,
  parsed without script execution and rendered as plain text), and the
  **image send flow** shared by clipboard paste and the file picker: a
  preview modal with caption + Send/Crop (`_imagePreviewModal` is built with
  `createElement` + listeners so the test stub can click it), free-form
  canvas cropper (`openImageCropper`), and upload of the final bytes via
  `resolve_upload_path` + `plugin:fs|write_file` (the fs plugin reads the
  path from the IPC `path` header and the bytes from the raw body — a
  Uint8Array as the whole invoke body). The rendered-row LRU (`_rowCache`)
  survives `close()` so reopening a chat reuses its rows; `open()` clears it
  when the account changed (message ids are per-account).
- `app/js/components.js` defines custom elements (`<velta-avatar>`,
  `<velta-chat-item>`, `<velta-chat-head>`, `<velta-video>`) using Elena.
- **Verified rosette** (`nameBadgesFor` in components.js): reads
  `chat.contact.verified` (falling back to `chat.verified`). The contact is
  the real source — `ContactObject.isVerified` means a secure-join-verified
  key contact (`verifierId` 0 = direct, else introduced) — while every
  chat-level path hardcodes `verified: false` because the core's
  `ChatListItemFetchResult` has no such field. The open chat head gets
  `chat.contact` from `refreshChatHeadPresence` (open / chat-updated / 30s
  tick); bare chat-list rows never hydrate contacts (one RPC per row), so
  the rosette shows in the header and profile only — keep it that way unless
  the core exposes verification on chatlist items. Group protection status
  is not exposed by the JSON-RPC chat types at all.
- `app/js/avatar.js` derives contact identity tiles from OpenPGP fingerprints:
  an equal-height 4-row color matrix (3 squares / 2 rects / 2 rects / 3
  squares, one cell per fingerprint group, deterministic colors with
  perceptual neighbor-clash avoidance) plus a soft-black badge holding the
  fingerprint glyph — or a contact's photo padded inside it. Every user
  avatar renders this matrix; group avatars keep solid colors.
- `app/js/diagnostics.js` is the in-app diagnostics event store ("Velta
  Diagnostics" chat). Entries render as console-style rows (Chrome DevTools
  look: monospace, level emoji ❌/⚠️/ℹ️, soft pill, hover copy-to-clipboard
  button) via the shared `diagnosticRow()` helper used by both app.js's direct
  renderer and chat-view's service-message fallback. The store collapses
  identical consecutive entries into one counted row — prefer appending here
  over toasting for repeatable background errors.
- `app/js/media.js` resolves local file paths to WebView-safe media URLs. Resolution order: (1) the `blobfile://` custom protocol (registered in `lib.rs`, serves account-dir-scoped blobs with real 206 ranges over a fixed origin, no TCP listener) once an `<img>` boot probe has proven this webview dispatches custom-protocol requests at all — the probe is an `<img>`, so a 200 vouches for the image pipeline exactly; (2) the loopback media HTTP server (kept running — it is the probe-negative path, and WebView2's media stack bypasses custom-protocol interception even when images through the same scheme load); (3) the asset protocol. `<img>`/`<video>`/`<audio>` error handlers swap to the legacy chain once (`mediaFallbackUrl`) before showing a failure placeholder — keep those swaps when touching media rendering. Blob media is served `Cache-Control: immutable` — core blob names are content-deduplicated, so the WebView can cache image bytes across chat switches.
- `app/js/poster.js` extracts and caches WebP poster frames for video placeholders.
- `app/js/ui.js` is a collection of UI helpers (drawer, modals, context menus,
  toasts, delete-confirmation dialog). The drawer head (`drawer-head`) shows
  the avatar (tap → the self profile sheet via `onProfile`; `showChatInfo`
  skips the Send/Rename/Block row for the self contact, id 1), the display
  name, and pill-button links: **Edit profile** and **Switch account** — the
  latter toggles an account dropdown (`.acct-pop`, anchored to the button,
  entries styled like the buttons) listing profiles with the current one
  checked; it renders only when there is more than zero accounts. No
  address/relay/backend lines in the head. The drawer is as wide as the chat
  list (`clamp(300px, 33vw, 420px)`, full width on mobile). While open, a
  capture-phase document `pointerdown` listener closes it on any tap outside
  (the transparent overlay stays and swallows the click so nothing underneath
  activates). The drawer footer (`drawer-foot`) shows
  the app version (Tauri app version when `window.__TAURI__` is present) plus
  the Tauri framework version in Tauri mode, or the service worker cache
  version in PWA mode. `.qr-box` carries no background/border of its own — the
  core's QR SVG is self-contained (opaque card, quiet zone, stroke).
- `app/js/mock-core.js` is a self-contained demo backend used when no real core
  is reachable (also force-selectable via `localStorage["velta-mock"] = "1"`).
  It must implement the same contract surface as the real core — including
  `accountId`/`accountEpoch` (the isolation contract keys on them; undefined
  values made `a?.x === a.x` guards pass on null and crashed demo mode) — and
  carries demo no-ops for the newer surfaces it can't simulate meaningfully
  (vCard parse/import/make, second-device backup transfer).

### 5.2 Core Rust library (`core/src/`)

The main crate is `deltachat` (see `core/Cargo.toml`). Key modules:

| Module | Responsibility |
|--------|--------------|
| `accounts.rs` | Multi-account management |
| `chat.rs`, `chatlist.rs` | Chats, chat list, visibility, mute |
| `contact.rs` | Contact book |
| `context.rs` | Per-account context and state |
| `imap.rs`, `smtp.rs` | Mail sync and send |
| `e2ee.rs`, `pgp.rs`, `securejoin.rs` | Encryption, key management, verification |
| `message.rs`, `mimefactory.rs`, `mimeparser.rs` | Message objects and MIME |
| `net.rs`, `transport.rs` | Network layer, proxy, connection |
| `scheduler.rs` | IMAP/SMTP scheduling loop |
| `events.rs` | Event emission |
| `webxdc.rs` | webxdc app runtime |
| `sql.rs` | SQLite schema and queries |
| `provider.rs` | Provider/server database |
| `qr.rs` | QR-code invite handling |

Some modules are `pub` only when the `internals` feature is enabled.

### 5.3 JSON-RPC bridge (`core/deltachat-jsonrpc/`)

Exposes the core through `deltachat-jsonrpc/src/api.rs` and the `yerpc` crate.
The API is consumed by the Velta PWA, the Python `deltachat-rpc-client`, and the
`deltachat-rpc-server` binary. Use `deltachat-rpc-server --openrpc` to dump the
full API spec.

### 5.4 Local chat, serverless P2P (`velta-app/src-tauri/src/p2p.rs` + `app/js/p2p.js`)

A second chat transport completely independent of the Delta Chat core: 1:1
end-to-end-encrypted chat between paired devices on the same network, using
iroh (QUIC, `RelayMode::Disabled`, optional mDNS re-discovery via the
`discovery-local-network` feature) — modeled on the core's backup transfer
(`core/src/imex/transfer.rs`).

- Identity: ed25519 key persisted in `<AppLocalData>/p2p/identity.key`; the
  NodeId is the long-term identity. Store: `profile.json`, `peers.json`,
  `messages-<node_id>.jsonl`.
- Pairing: inviter shows a `VELTAP2P1:` ticket (compact base32: NodeId +
  direct addresses + pairing token, rendered as QR via the core's
  `create_qr_svg`); joiner scans/pastes it, presents the token in a `hello`
  frame — token presentation is the out-of-band proof, so the inviter accepts
  automatically. The token is never broadcast: LAN beacons carry only names
  and addresses, and a Nearby tap sends an empty-token request that the other
  device must approve in the UI (`p2p_approve_pair`); wrong tokens are
  rejected without a prompt. Unpaired NodeIds are otherwise rejected.
- Messaging: newline-delimited JSON frames (`msg`/`ack`/`ping`) over one
  bidirectional QUIC stream per session; sends to offline peers are queued and
  flushed on reconnect. Events reach the UI as Tauri `p2p-event`s; commands are
  the `p2p_*` Tauri methods registered in `lib.rs`.
- Enable/disable: **local chat is disabled by default** — the Rust flag
  (`P2pState::empty`) starts `false` and `spawn_startup` refuses to start when
  disabled (checked before *and* after `P2p::start`, so a disable request
  racing the boot spawn still wins). `p2p_set_enabled` starts/stops the engine
  (endpoint socket released, beacons off); the opt-in preference lives in the
  WebView (`localStorage["velta-p2p"] === "1"`, applied on every boot by
  `app/js/p2p.js`, which calls `p2p_set_enabled(true)` only when opted in).
  Don't regress the default to enabled — a fresh install must not open QUIC
  sockets or broadcast LAN beacons without the user asking for it.
- UI (`app/js/p2p.js`): drawer entry (Tauri-only, hidden in browser/PWA mode),
  hub with online dots, "Nearby devices" (UDP beacon on port 53717), invite QR
  display, pairing via beacon tap (requires approval on the other device) or
   pasted/scanned code (`acquireCode` offers camera scanning — native
   `BarcodeDetector` where the WebView supports it, vendored jsQR fallback
   otherwise — plus paste everywhere else).
  Engine-side errors (background connect retries) go to the Diagnostics chat,
  never toasts — several queued connects can fail at once and the store
  collapses identical consecutive entries into one counted row. The toggle
  button lives in the Diagnostics chat's action row.
- Rust tests: `cargo test --lib p2p::` (loopback pairing + offline queue flush).

### 5.5 In-app browser (`app/js/inapp-browser.js` + `InAppBrowser.kt` + `lib.rs`)

Android link handling chain (since 1.4.1, hardened after 1.4.2): `openInAppBrowser(url)`
on Android invokes `open_in_app_browser` (JNI → `org.velta.InAppBrowser`).
Failure chain, in order:

1. **Chrome Custom Tab** — the normal path.
2. **Default browser** — `InAppBrowser.kt` catches the launch failure
   (`CustomTabsIntent.launchUrl` does NOT fall back on its own) and re-launches
   via plain `ACTION_VIEW` + `FLAG_ACTIVITY_NEW_TASK`.
3. **Iframe overlay** (`openIframeOverlay`) — last resort and dev only. Sites
   sending X-Frame-Options / frame-ancestors (github.com, most big sites) are
   blocked by Chromium with `net::ERR_BLOCKED_BY_RESPONSE`; the bar's
   external-open button is the escape hatch.

JNI gotcha: `find_class` for app classes is unreliable from Rust worker
threads attached via `attach_current_thread` (boot classloader context), so
`org.velta.InAppBrowser` is resolved once and cached as a global ref in
`setApplicationContext` (runs on a Java thread from `MainActivity.onCreate`).
System classes (`android/net/Uri` etc.) work from anywhere. Desktop keeps its
system-browser convention — `open_in_app_browser` is `#[cfg(target_os =
"android")]` and errors elsewhere.

---

## 6. Development conventions

### 6.1 Rust

- The core crate is `#![forbid(unsafe_code)]` and enables a long list of lints in
  `core/src/lib.rs`. Treat them as authoritative.
- `cargo clippy --workspace --all-targets --all-features -D warnings` is the CI
  standard.
- `cargo fmt` is the standard formatter; no custom `rustfmt.toml` exists.
- `cargo deny` is enforced via `core/deny.toml`.
- Dependencies are mostly pinned in `Cargo.lock`. Run `cargo update --dry-run`
  before accepting dependency changes.
- Tests use `tempfile`, `testdir`, and the `pretty_assertions` crate.

### 6.2 JavaScript / Frontend

- ES modules, no transpiler, no npm dependencies in the frontend.
- Components are custom elements built with Elena.
- SVG icons are inline strings; no icon library.
- CSS is a single hand-written file (`app/css/main.css`).
- The service worker cache version is a hard-coded constant in `app/sw.js`.
- **Modal async flows: settle BEFORE close.** `showModal`'s `close()` fires
  `onClose` synchronously, and `onClose` handlers typically resolve the flow's
  promise with null/`false`. If the flow calls `close()` first, the close-path
  settlement wins the `settled` race and the real result is silently dropped
  (this swallowed every successful QR scan once — the reject toasts worked,
  successes vanished). Always `finish(result); close();` — never the reverse.
- **Never open the Android soft keyboard over the camera.** Focusing an input
  raises the keyboard; any scan flow must `blur()` inputs while scanning and
  focus back only when returning to paste mode (`qr-scan.js` gates its initial
  `focus()` on the camera being unavailable).
- **CSS `display` beats the `hidden` attribute.** An element with both a
  class rule `display: flex|block|…` and the `hidden` attribute stays visible
  (author styles always win over the UA rule). Add an explicit
  `.foo[hidden] { display: none; }` whenever a styled container is toggled
  via `hidden` (bit us on the splash's action/form panes).

### 6.3 Python

- `black` and `ruff` with `line-length = 120`.
- `isort` profile set to `black`.
- Both `core/python` and `core/deltachat-rpc-client` use `pyproject.toml` and
  `setuptools`.

### 6.4 Visual design
- **No pure black or pure white.** Opaque text and surface colors stay in the
  soft families: whites `#f2f2f5`/`#f4f4f4`, blacks `#0b0b10`–`#1c1c26`
  (`avatar.js` states the rule for fingerprint tiles; keep it everywhere).
- **WCAG AA contrast (≥ 4.5:1)** for every text/background pair. Measure with
  the WCAG relative-luminance formula and composite translucent layers over
  their real bubble color first — e.g. reply quotes sit on
  `--bg-reply` over `--bg-bubble-out`, not on a plain background. The
  `.msg-quote` palette block in `app/css/main.css` documents the current
  per-theme/per-side choices (5.2–7.0 : 1). Generic accent/dim tokens often
  fail on colored bubbles (accent on `--bg-bubble-out` measures 2.58 : 1), so
  always measure the actual combination.
- **Identity avatars (user contacts)** always render the color matrix as the
  background — never a solid color. The matrix uses equal-height rows
  (3 squares / 2 rects / 2 rects / 3 squares), deterministic per-fingerprint
  colors, and never places similar hues on neighboring cells (see
  `colorForCell` in `avatar.js`). The fingerprint glyph sits on a soft-black
  badge (`#1c1c1c`) in soft white (`#f4f4f4`); a contact's photo replaces the
  glyph as a rounded square padded inside the matrix with a thin dark ring.
  Group/channel avatars are exempt (solid color + photo/initials).


---

## 7. Testing strategy

### 7.1 Rust core

- Unit and integration tests are embedded in `core/src/` and run with `cargo test`.
- Fixtures live in `core/test-data/`.
- Some tests are marked `#[ignore]` because they are slow or require external
  services; run them with `cargo test -- --ignored`.
- Fuzzing lives in `core/fuzz/` and uses `cargo-bolero`.
- Benchmarks live in `core/benches/`.
- Online/live tests require a test chatmail server; set `CHATMAIL_DOMAIN` for
  the Python RPC tests.

### 7.2 Frontend

Regression suites (Node's built-in test runner, no dependencies):

```bash
node --test tests/rpc-account-isolation.test.mjs \
             tests/chat-account-isolation.test.mjs \
             tests/app-account-isolation.test.mjs \
             tests/rpc-event-poll.test.mjs \
             tests/chat-msg-update-hardening.test.mjs
```

These cover the account-isolation contract: stale account results (A→B→A),
entry-account-pinned RPCs, view lifetime across close/reopen, per-account
drafts, popup settlement, attachment flows (the image preview modal is
settled by clicking its Send button in the stub DOM), and the event
long-poll contract: expired `get_next_event` requests stay registered so
their late responses are dispatched (never dropped) and dispatched exactly
once, with account attribution still enforced. The hardening suite pins the
event-storm defenses: duplicate message updates take the changed path at
most once (no repeated `onItemHeightDidChange` for unmounted rows), row
signatures survive unmounted updates, and `msgs-changed` bursts collapse
into one tail refetch per gap. Run them after touching `rpc-core.js`,
`app.js`, `chat-view.js` or `ui.js`.

Beyond that, the primary verification path is manual:

1. Open `app/index.html` in a browser. Force demo mode with
   `localStorage["velta-mock"] = "1"` (or the drawer's "Enter mock mode"
   toggle) to verify UI behavior without a backend; the mock ships demo chats,
   media, and a 2400-message chat for scroller testing.
2. Run a real backend (`deltachat-rpc-server`, the Tauri app, or the Android
   service) and confirm the transport switches from mock to real.
3. Use `app/diag.html` to diagnose WebSocket/HTTP connectivity to the service.

For end-to-end verification against a **real core** (message delivery,
deletion requests, SecureJoin), the setup used during development is:

1. Serve `app/` from any static server with `Cache-Control: no-store`
   (avoids stale module caching in the browser). The ready-made option is
   `python tools/serve-dev.py [port]` (default port 8747) — it serves `app/`
   with `Cache-Control: no-store`. Plain `python -m http.server` sends no
   cache headers, and Chromium will then keep serving heuristically-fresh
   modules for hours without revalidating them.
2. Spawn `deltachat-backend/windows-x86_64/deltachat-rpc-server.exe` with
   `DC_ACCOUNTS_PATH` pointed at an isolated accounts directory, and bridge
   its stdio JSON-RPC to a WebSocket server on `ws://127.0.0.1:20808` — the
   frontend then connects to it automatically as the "local core (service)"
   backend. A ready-made bridge lives in the local `test-rig/` workspace
   folder (not committed).
3. Create two throwaway chatmail accounts (`set_config_from_qr` with
   `dcaccount:https://<relay>/new`), SecureJoin them to each other, and drive
   one side via raw RPC while testing the UI on the other.

Relays rate-limit aggressive sending (HTTP 4.7.1 "too much mail"); pace
test traffic accordingly.

### 7.3 Python bindings

- `core/python` uses CFFI and pytest.
- `core/deltachat-rpc-client` uses pytest against a spawned
  `deltachat-rpc-server`.
- Helper scripts: `core/scripts/run-python-test.sh`, `run-rpc-test.sh`,
  `make-python-testenv.sh`, `make-rpc-testenv.sh`.

---

## 8. Security considerations

- **Encryption is handled by the core.** The frontend must never touch private
  keys or plaintext mail credentials; it only speaks JSON-RPC to the core.
- **Loopback-only service.** The Android service bridge binds to `127.0.0.1:20808`
  and `127.0.0.1:20809`. Do not expose these ports to other interfaces.
- **CSP.** The Tauri `tauri.conf.json` and `tauri.android.conf.json` set a
  restrictive CSP rooted in `default-src 'self'` with no `unsafe-inline` or
  `unsafe-eval` for scripts (inline scripts are blocked — that is relied on,
  e.g. by `boot-net.js`); `img-src`/`media-src` additionally allow the
  `blobfile:`/`webxdc:` custom-scheme origins and the loopback media server.
  Keep it tight when adding new frontend capabilities, and update **both**
  conf files together.
- **Webxdc sandbox is opaque-origin.** `webxdc-manager.js` deliberately omits
  `allow-same-origin` from the iframe sandbox: every mini-app document gets a
  unique opaque origin and can reach neither the host page nor other apps'
  data. The shim's postMessage bridge works unchanged (`webxdc_serve`
  answers with `Access-Control-Allow-Origin: *`), and `webxdc-shim.js`
  shadows `localStorage`/`sessionStorage` with an in-memory store because
  real storage throws in opaque origins. Do not re-add `allow-same-origin`
  — all webxdc apps share the `webxdc.localhost` origin, so same-origin
  would let a malicious app read every other app's blobs.
- **PWA protocol handler.** `manifest.webmanifest` registers `web+dcaccount` as a
  protocol handler. Validate incoming `?qr=` parameters before passing them to
  the core.
- **Invite links.** `app/js/invites.js` parses invite links, mirrors custom hosts onto
  the canonical `https://i.delta.chat/#…` scheme the core accepts, and renders them as
  invite cards. Only links whose host is in the domain registry (drawer → "Invite link
  domains"; built-ins mirror the AndroidManifest intent filters) are treated as invites.
- **Trusted binaries.** The prebuilt `deltachat-backend/` binaries are static
  except for system libraries. If you rebuild them, prefer vendored OpenSSL and
  SQLite to minimize external runtime dependencies.
- **No unsafe code in the core.** The `deltachat` crate forbids `unsafe`; keep
  it that way.

---

## 9. Deployment and runtime architecture

### 9.1 PWA served statically

- Serve the contents of `app/` over HTTPS.
- The browser will install the service worker and cache the app shell.
- If `deltachat-rpc-server` or the Android service is running on the same
  device, the app connects over loopback WebSocket/HTTP; otherwise it falls
  back to the mock core.
- **Direction (since 1.3.29):** the PWA's target deployment is a *remote*
  core service reached over WSS/TLS — `transport.js` currently hardwires the
  loopback endpoints (`ws://127.0.0.1:20808`, `http://127.0.0.1:20809`), and
  a remote transport will replace them. Note the CSP implication before
  adding origins: a meta CSP in `index.html` is still missing, so outside
  the Tauri shell the only XSS layer is the frontend's escape-first
  rendering.

### 9.2 Tauri desktop/Android app

- The Tauri Rust layer embeds `deltachat-jsonrpc` as a library and exposes two
  commands: `invoke("rpc", { request })` to call the core, and `emit("velta-rpc")`
  to push core events to the WebView.
- Account data lives in the platform app-data directory:
  - Windows: `%APPDATA%/org.deltaweb.app/accounts`
  - Android: app-private storage.
- **Background sync (since 1.3.30, Android main APK).** `CoreService.kt` is a
  `remoteMessaging` foreground service started from `MainActivity.onCreate`;
  it keeps the process — and the in-process core — alive after the app is
  backgrounded. While the UI is hidden, Rust's `start_bg_event_poller`
  (lib.rs) drains `get_next_event_batch` itself (ids prefixed `bg-`, routed
  via `RpcState.bg_pending` like the `wxdc-` round-trips) and posts native
  notifications for IncomingMsg events. The frontend reports visibility via
  `set_ui_visible`; events the poller consumed never reached the WebView, so
  the JS `visibilitychange` handler refetches the chat list and open chat on
  resume. Keep the poller gated on `UI_VISIBLE` — ungated it would steal
  events from the frontend's own polling.
  Notification titles: `bg_notify_incoming` defaults the title to "Velta" and
  replaces it with the chat name via `get_basic_chat_info` — the RPC surface
  has NO `get_chat` method, and a wrong method name here fails silently
  (`if let Ok`), leaving every push titled "Velta" (1.4.2 regression, fixed
  1.4.3 after a user report).

### 9.3 Android background service

- The APK has no UI; it starts a foreground service, links `librpc_core.so`,
  and optionally serves the PWA from `assets/pwa/` on `http://127.0.0.1:20809`.
- The WebSocket bridge is on `ws://127.0.0.1:20808` and supports multiple
  concurrent clients.
- Boot receiver restarts the service after reboot.

---

## 10. Quick reference for common tasks

| Task | Command |
|------|---------|
| Run core tests | `wsl -e bash -lc "cd /mnt/c/Users/pave/Velta/velta/core && cargo nextest run --workspace --locked"` (plain `cargo test` flakes on time-shift tests — see `COREUPDATE.md` §4) |
| Run core lints | `cd core && scripts/clippy.sh && scripts/deny.sh` |
| Build core RPC server | `cd core && cargo build -p deltachat-rpc-server --release` |
| Run Tauri dev | `cd velta-app && cargo tauri dev` |
| Serve PWA locally | `cd app && python -m http.server 8080` |
| Diagnose service | Open `http://localhost:8080/diag.html` |
| Run Python CFFI tests | `cd core/python && pytest` |
| Run Python RPC tests | `cd core/deltachat-rpc-client && pytest` |
| Upgrade the core | Follow `COREUPDATE.md` |

---

## 11. Notes for agents

Do-not-regress notes for the event-storm hardening (added 1.3.23; the
failure mode was a core event storm rendering as endless chat-history
re-renders, `[virtual-scroller] The item is no longer rendered onscreen
(onItemHeightDidChange)` console spam, and a relay-status feedback loop):

- `rpc-core.js` `_onLine`: the event-poll `onLate` hook must run only for
  entries the backstop already rejected (`entry.settled`). Running it for a
  live entry too dispatches every single core event exactly twice — the
  doubled `onIncoming` lines 1-5 ms apart in `velta.log` were this.
- `chat-view.js` `onMsgUpdated`: call `onItemHeightDidChange` only when the
  row is mounted, and for unmounted rows *set* the new row signature instead
  of deleting it — deleting it made every duplicate event retake the full
  changed path (and re-notify the scroller for an off-screen item) forever.
- `chat-view.js` `_renderItem` seeds `_rowSigCache` at build time; do not
  remove, or the first duplicate update silently rebuilds mounted rows.
- `chat-view.js` `onMsgsChanged` coalesces refetch bursts
  (`tailRefetchGapMs`); `app.js` `refreshRelayStatus` coalesces
  connectivity-driven polls (its own `get_connectivity` RPCs emit further
  `ConnectivityChanged` events — the unguarded handler multiplied storms).
  Tests shrink both via their instance knobs, not by deleting the gates.
- `chat-view.js` `onMsgsChanged` also self-heals delivery-state ticks: the
  tail refetch rebuilds rows whose `state` changed, not only
  `downloadState`/`viewtype`. Tick state otherwise rides only on
  `MsgDelivered`/`MsgRead` events — a dropped event used to leave a sending
  spinner stuck for hours (fixed 1.4.3). Keep `state` in that condition.
- Core-side: a mail the core fetches and ignores (`receive_imf.rs` ignore
  path) must still be marked seen on the server, or IMAP idle re-fetches it
  forever — one looping mail stalled an inbox with events every ~2 s. Check
  COREUPDATE.md §7 on every core upgrade.

- Boot error safety net (since 1.3.26): `app/index.html` loads
  `js/boot-net.js` before every other script — it routes
  `error`/`unhandledrejection` into the Diagnostics sink once app.js is
  alive, and into the static `#boot-error` banner before that (the CSP
  forbids inline scripts, so the net is an external file). `boot()` is
  stage-isolated: the drawer + menu bind first and set `uiLive`;
  ChatView/chat-list/bind-ui failures are logged and boot continues instead
  of skipping the remaining stages. `openChat` returns early when the
  ChatView stage failed, and boot's outer catch shows the splash when
  `!uiLive`. Keep these guards when touching boot.
- Audio calls (since 1.3.26, `calls.js`): the core does encrypted call
  signaling (place/accept/end ride as messages; `place_call_info` is the
  caller's SDP offer, `accept_call_info` the answer — raw SDP, non-trickle
  ICE) and the WebView does the media (`RTCPeerConnection` + `getUserMedia`,
  ICE servers from the core's `ice_servers()`). Events map to
  `incoming-call` / `outgoing-call-accepted` / `incoming-call-accepted`
  (`fromThisDevice: false` = another device accepted — stand down) /
  `call-ended`. The WebRTC/DOM adapter is injected into `CallManager` so
  `tests/call-state-machine.test.mjs` runs headless; keep it injected.
  Mic grants: desktop uses the `--use-fake-ui-for-media-stream` browser arg
  (wry denies permission requests by default — only clipboard is allowed);
  Android needs `RECORD_AUDIO` in the gen manifest, granted by wry's
  `RustWebChromeClient`. Video calls are not offered.
- Webxdc mini-apps (since 1.3.28, `webxdc-manager.js` + the `webxdc://`
  protocol handler in lib.rs): the handler serves `<account>/<msg>/<path>`
  blobs via `webxdc_rpc` round-trips (ids prefixed "wxdc-" are routed by the
  response forwarders into `wxdc_pending` — NOT emitted to the WebView) and
  injects `webxdc-shim.js` (include_str!) into index.html. The shim defines
  `window.webxdc` and talks to the host over postMessage; the host relays to
  `get_webxdc_status_updates` / `send_webxdc_status_update`, tracking
  per-instance serials. Realtime channels and `sendToChat` are not wired.
  CSP: `frame-src` + `img-src` gained the `webxdc.localhost` origins — keep
  them when editing the CSP. Bot messages render command chips
  (`extractBotCommands` in markdown.js, chips fill the composer); on Android
  message links are routed to `plugin:opener|open_url` (wry drops
  target=_blank).

- Forwarded-message label + bubble polish (since 1.3.31): the forward label
  announces the content type ("Forwarded a picture / video / an audio / a
  message", `FWD_NOUNS` in chat-view.js), not the original sender name; the
  label uses the meta-dim colors (`--text-meta-in` / out override) because
  accent blue was unreadable on the outgoing bubble. All three media blocks
  (`.msg-image`, `.msg-video`, `.msg-audio`) use a positive top margin — a
  negative one collapsed into the sender/quote line above. The relays modal's
  "all your devices run at least 2.47.0" warning was removed as outdated
  (RELAYS_WARNING deleted; CORE-CAPABILITIES.MD records the decision).

- Reading/history polish (since 1.3.32): the virtual scroller prerenders 3×
  the viewport (`getPrerenderMarginRatio: () => 3` in chat-view's
  `_createScroller`; default 1 ≈ 10 messages) for smoother fast-scroll
  reach-back — rows are signature-cached, so the cost is DOM size only.
  `.qr-box` is 40% larger (308px box / 280px svg). `VeltaAvatar` declares an
  `addr` field default — the last undeclared Elena prop, so the "Prop has no
  default" console-warning class is extinct; keep every `static props` entry
  backed by a field or a constructor install, and keep the default
  STRING-typed, never `null`: `typeof null` is `"object"`, which made Elena
  JSON-parse every attribute value (VeltaChatItem logged
  "Invalid JSON: c49" for the string ids the pick/forward lists use).
- Modal/button conventions (since 1.3.35): never use native `prompt()` —
  group creation asks via a `showModal` input (`askGroupName` in app.js).
  When building a modal foot from elements, append the buttons via a
  `DocumentFragment` (direct children of `.modal-foot` inherit its one-row
  right-aligned flex); a wrapper div left-aligns them outside the flex.
  `.btn-primary` defaults to a full-width onboarding bar — set
  `width: auto` when it shares a foot with other buttons. `.modal-foot`
  side padding (18px) matches `.modal-body` so buttons align with body
  content — keep them equal if either changes. `markRead` marks ALL fresh
  messages seen (the old 50-id slice left residual unread after opening a
  chat with many fresh messages — badge never cleared); open = read-all is
  the upstream Delta Chat behavior.

- Bot chips + send-spinner fixes (since 1.3.33): bot command chips were
  dead-on-arrival — gated on `m.isBot`, a field nothing produced. The bot
  flag lives on the sender contact (core `ContactObject.isBot`, camelCase):
  `_mapContact` maps it as `bot`, and chat-view reads `m.fromContact?.bot`
  on both the render and click paths (mock's `_decorate` already passed the
  raw contact through, so demo mode works for free). The outgoing pending
  spinner had a race: a fast relay's MsgDelivered could arrive before the
  sent row was inserted, chat-view dropped the msg-state event for the
  unknown row, and the spinner stuck spinning. rpc-core now records the
  latest terminal state per msgId (`_msgStateHints`, cleared on account
  change) and `sendMessage` reconciles the fresh row against it before
  emitting `msg-sent`. The spinner still runs for the real SMTP round-trip
  by design — that part is honest, not a bug.

- Frame theming + isolated HTML viewer (since 1.3.34): the HTML viewer and
  webxdc iframes are themed via CSS `color-scheme` — but the iframe
  element's scheme only paints the CANVAS; the frame's scrollbar follows the
  inner document's own color-scheme, so it must be injected: the HTML viewer
  fetches the attachment and puts a `<style>html{color-scheme:…}</style>`
  into the srcdoc document; webxdc frames receive `?velta-theme=` on their
  URL and webxdc-shim.js applies it to `documentElement.style.colorScheme`.
  Do not navigate the sandboxed iframe to a custom-protocol URL if srcdoc
  works — WebView2 runs Tauri's init scripts in opaque-origin frames too,
  and they throw `Cannot read properties of undefined (reading 'plugins')`
  (cosmetic, but confusing). Device chats (`kind === "device"`) hide the
  composer (read-only system posts); `.msg-webxdc` cards carry a Start chip
  and a `--bg-hover` surface. README's "Privacy" section states zero
  analytics/telemetry — verified against the codebase 2026-09-15 (only
  loopback fetches; relays are the messaging; the Windows WebView2 install
  bootstrap is the sole documented exception). Keep that true.

`COREUPDATE.md` is the core-upgrade test plan; consult it before merging an
upstream core or swapping `deltachat-rpc-server` binaries. Release-by-release
core capabilities and their Velta integration notes: `CORE-CAPABILITIES.MD`.

- Core 2.60.0 relay removal (since 1.3.24): the Remove button goes through
  `rpc-core.js` `deleteTransport` → core `delete_transport` — removal is
  immediate, the core refuses only the *last* relay and re-elects the sending
  transport, and informs contacts via keyupdate messages.
  `set_transport_unpublished` no longer exists in the core; never
  reintroduce it. The `transports-modified` listener in `app.js` (relay
  status line + any open Relays modal) must stay — it is the only signal for
  relay changes synced from another device — and `refreshRelayStatus` keeps
  its coalescing because transports-modified arrives in bursts together with
  connectivity-changed.
- Build environment: run core `cargo` commands (tests, sidecar release
  builds) in WSL — native Windows cargo fails in `openssl-sys` (SQLCipher
  bundled build) because the MSYS perl lacks `Locale::Maketext::Simple`.
  The Windows sidecar exe itself is built by `build-windows.yml` on tag
  push, so local stale binaries in `velta-app/src-tauri/binaries/` are
  refreshed only at release time.

- The `core/` directory is large and self-contained. If your task only touches
  Velta's frontend or wrappers, avoid changing files under `core/` unless you
  are explicitly fixing or extending the core itself.
- `velta-app/src-tauri` has full Rust sources plus a `gen/android` project
  generated by `cargo tauri android` — regenerated files can be large; edit
  `src/` and `tauri.conf.json` rather than `gen/` where possible.
- `velta-core-service/` is a working foreground-service APK but is secondary to
  the Tauri app; check `velta-core-service/README.md` before editing it.
- The PWA has no build pipeline. All changes to `app/` are immediately testable
  by refreshing the browser or bumping the service-worker cache in `app/sw.js`.
- Version bumps touch `velta-app/src-tauri/tauri.conf.json`, the
  `velta-app` package in `velta-app/src-tauri/Cargo.toml` (+`Cargo.lock`),
  and the `CACHE` constant in `app/sw.js`; each release commit notes both.
- README convention (since 1.3.26): every `##` section below "Screenshots"
  is wrapped in `<details><summary>Title</summary>…</details>` so the front
  page stays short — keep the wrapper when adding sections, and keep the
  blank line after `</summary>` so the content still renders as markdown.
- Releases: `.github/workflows/release.yml` (v* tag push or manual dispatch)
  calls the two reusable build workflows and publishes a GitHub release
  `v<version>` with `Velta-<version>-<abi>.apk` (signed with the persistent
  keystore secrets) and `Velta_<version>_x64-setup.exe`; the version comes
  from `tauri.conf.json`. Tag pushes do not run the build workflows directly
  — release.yml is the single tag→release path. The keystore and its password
  live in `signing/` (gitignored) and in the four `ANDROID_KEY*` repo
  secrets; losing both means installed APKs can never be updated again.
- When modifying the JSON-RPC API surface, remember that the PWA
  (`app/js/rpc-core.js`), the Python RPC client, and any external consumers must
  stay compatible.

- Overlay/BACK conventions (since 1.3.36): every fullscreen overlay (HTML
  attachment viewer, webxdc, in-app browser) pushes one `{velta:…}` history
  entry on open; WryActivity's OnBackPressedCallback calls `mWebView.goBack()`
  when it can, so the pop pops the entry and a `popstate` listener tears the
  overlay down — app.js's own popstate handler treats a revealed
  `{velta:"chat"}` state as "keep the chat". Close buttons and programmatic
  closes must consume the entry via `history.back()` (never leave stale
  entries), and reopening an already-open overlay must REPLACE its entry —
  `history.back()` is async, so back-then-push races and loses the entry.
  Message ids the chat view must stay NUMERIC: `_resendTail`/`onMsgsChanged`
  compare ids with `>` — string ids silently drop every message from the
  "append only new" filter (local-chat.js learned this the hard way; its ids
  are `1e9 + seq`).

- Local chat architecture (since 1.3.38): P2P peers are rendered as regular
  chats by `app/js/local-chat.js`, a Proxy AROUND the core object — getChat
  List/getChat/getMessages/sendMessage/markRead are intercepted for
  `p2p:<peerId>` string chat ids, everything else passes through untouched.
  Do not special-case p2p ids inside chat-view.js; add adapter methods
  instead. Media goes over FileBegin/FileChunk/FileEnd frames (base64, 96 KB
  raw per frame, 256 MB cap) in p2p.rs and lands in
  `<accounts>/p2p-blobs/<nodeId>/` — that directory MUST stay under the
  accounts dir because blobfile/media-server refuse paths outside it, and
  that check is the sandbox: peer-supplied file names are sanitized
  (basename only, safe chars) before they ever touch the filesystem. Transfer
  and queue states ARE rendered (since 1.4.1): `file-progress` events drive a
  bubble progress bar (2% steps); a `done` event clears it for the file card,
  and a `failed` event (session died mid-send) renders a Retry card —
  `lcRetryTransfer` re-sends the stored blobs copy from byte zero (NO resume;
  the engine discards bad partials). Media picked while the peer is offline
  parks in the composer queue chip (`#lc-queue-chip`, popup: send-now/remove)
  and auto-flushes oldest-first on the peer's `presence` online transition.
  Offline TEXTS queue inside the engine: `p2p_send` returns `{id, queued}`,
  the bubble shows the `pending` clock (ticksSvg), the reconnect flush emits
  a `msg-state` event (queued → sent) and the peer's `ack` completes read.
  `send_file` still bails when the engine considers the peer offline — the
  frontend queues proactively on its own `online === false` before calling.
  Beacons refresh a paired peer's stored addresses (DHCP/roam heals the dial
  book within one beacon interval); tests in
  `tests/local-chat-transfer-progress.test.mjs` pin the event contract.
  Failed texts (since 1.4.2) render the same Retry card as failed transfers:
  mapMsg maps `failed` to state "failed" and the adapter's resendMessage
  re-sends the same text/quote as a FRESH message (swap, not append; the
  failed bubble is restored when the engine rejects the retry — identical
  contract to lcRetryTransfer). Only failed msgs match; pending/sent ones
  fall through to the real core.

- Interface scale + theme (since 1.4.2): MainActivity.kt pins the WebView's
  `textZoom = 100` (bounded retry until the Tauri runtime creates the
  WebView) — the system font scale otherwise applies text-only zoom that
  inflates text out of the px-sized boxes (broken layout at the largest
  scaling factor; reporter's viewport was 320px wide). Scaling is owned by
  the app instead: drawer spoilers (ui.js) with radios — "Interface scale"
  (zoom on <html>, persisted `velta-ui-scale`, applied pre-paint by the
  inline script in index.html <head>) and "Theme" (auto/dark/light; auto
  follows `prefers-color-scheme` live via matchMedia and is the DEFAULT for
  fresh installs — `dw-theme` holds the setting). Both apply in place:
  never rebuildDrawer() on a radio change, it would close the drawer.
  `text-size-adjust: 100%` on html neutralizes font boosting in browsers.

- In-app browser (since 1.3.38): Android message links open
  `inapp-browser.js`'s overlay (bar: close / fetched title + domain /
  open-external) over a sandboxed iframe; the title comes from the
  `fetch_page_title` command (ureq, 5 s timeout, 256 KB cap) because a
  cross-origin iframe's title is unreadable. `frame-src` in BOTH
  tauri.conf.json and tauri.android.conf.json carries `https:` for this —
  sites that forbid framing (X-Frame-Options) still show a blank frame; the
  external-open button is the escape hatch. The old per-chat special case is
  gone: the handler lives in chat-view's row binding, so local and relay
  chats behave identically.
