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
│   └── sw.js                 # vestigial: boot unregisters all service workers (see §9.1)
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
├── docs/agents/              # per-subsystem agent notes (webxdc, relays,
│                              p2p/local chat, android-shell, media,
│                              onboarding) — referenced from §5/§11
└── tools/                    # icon generation, WSL APK build/sign helpers,
                              serve-dev.py (no-cache static server for app/)
```

Not tracked (local runtime/build artifacts): `accounts/` (local core account
databases), `*.apk` builds, `signing/*.keystore`.

> **Rebranding note:** this checkout predates the Velta rename, so older docs,
> scripts and muscle memory may reference pre-rebrand paths. The Tauri shell
> lived at `delta-web-app/src-tauri/` — that directory is GONE; the shell is
> `velta-app/src-tauri/` (this document already uses only the current names).
> Two pre-rebrand identifiers also linger on machines that ran old desktop
> builds: `%LOCALAPPDATA%/chat.delta.desktop.tauri` and `deltachat-tauri` are
> dead leftovers — current builds use `org.velta` (see §9.2). The WSL build
> sandbox `~/velta-android-build/velta-app/` (workspace scripts in the parent
> directory) was migrated from `delta-web-app/` to the current name; because
> cargo fingerprints embed absolute paths, the first build after the rename
> recompiles from scratch.

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

The service worker is dead by design: boot unregisters every registration
(app.js, near the PWA comment — cache-first SWs kept serving stale JS across
upgrades). `app/sw.js` is vestigial; don't rely on it or re-register one.

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
  events to UI events, and exposes the same API surface as `mock-core.js`:
  multi-account (`getAllAccounts`/`switchAccount`/`addAccountWithQr`), the
  relay surface (see docs/agents/relays.md), second-device backup transfer
  (`provideBackup`/`getBackupQr`/`addAccountWithBackup`/`importBackup`),
  vCard (`parseVcard`/`importVcard`/`makeVcard`), `getMessageHtml` (original
  body behind "Show Full Message…"), `createQrSvg`. Wire types are
  normalized here (drawer ids are always strings; `switchAccount` coerces to
  u32). KEEP the **account-isolation contract**: `account-changing` fires
  synchronously at the start of every account transition (the app tears down
  chat/popups/drawer/search), `account-changed` fires in a `finally` after
  selection succeeds or fails; every multi-step RPC captures its entry
  accountId and drops cache writes/UI events/async decoration when the epoch
  no longer matches; foreign or unattributed events (`contextId`) never
  mutate state; ChatView sessions are invalidated by `close()` and the
  epoch; unsent text/replies are drafts keyed by (account, chat);
  `closeAllPopups()` settles confirmations (dismissal = cancel). Pinned by
  the tests in §7.2.
- **Event long-poll contract** (rpc-core): the backend parks `get_next_event`
  until an event exists and hands each event to exactly one waiter; polls
  use a dedicated 240 s backstop (`eventPollTimeoutMs`), and an expired
  poll's entry stays registered so its late response is dispatched, not
  dropped. Don't replace it with a normal `_call`. (Pinned by
  `tests/rpc-event-poll.test.mjs`.)
- **Mid-session auto-reconnect** (1.4.11, app.js `velta-core-disconnected`):
  retry `core.reconnect()` forever with 1 s doubling backoff capped at 15 s,
  then re-fire `velta-core-status` connected — `transport.reconnect()` alone
  does NOT set the status pill — and refresh the chat list. While down, the
  rpc-core poll loop ramps delay 250 ms per consecutive failure (cap 5 s)
  and logs the failure on the first and every 20th attempt only.
- `app.js` owns the chat list, navigation, modals, the diagnostics chat and
  the PWA shell, plus a DOM-budget watchdog. KEEP: boot is stage-isolated —
  drawer + menu bind first and set `uiLive`; later-stage failures log and
  boot continues; `openChat` returns early when the ChatView stage failed;
  the outer catch shows the splash when `!uiLive`; `js/boot-net.js` loads
  before every other script (CSP forbids inline scripts) routing
  errors/unhandledrejection into the Diagnostics sink once app.js is alive,
  into the static `#boot-error` banner before that. Subsystem notes:
  docs/agents/relays.md (relay line/detail/manager), onboarding (splash,
  second device).
- `app/js/chat-view.js` owns the conversation history (virtualized via
  virtual-scroller), composer, selection mode and the delete dialog. KEEP:
  rows must NOT get `content-visibility` (the scroller measures mounted rows
  itself; collapsing desyncs its height cache — scroll jumps on remount);
  day chips render inside the first message row of each day (`dayFirst`) —
  separator items broke the scroller's prepend diff; `_loadOlder` prepends
  stay pure message prefixes. Bubbles use `contain: layout style` (not
  paint — the reply pill overflows); `.chat-item` cards use full
  `contain: layout paint style`. The rendered-row LRU (`_rowCache`) survives
  `close()`; `open()` clears it when the account changed.
- **Message editing** (1.4.20): own text messages edit via core
  `send_edit_request` (rpc-core `editMessage` → refetch → `msg-updated`).
  KEEP: `onMsgsChanged`'s in-place compare must include
  `item.msg.text !== m.text` — without it, edits arriving from the other
  device never re-render (only downloadState/viewtype/state were compared).
  Menu guards mirror the core's (own + plain text + non-empty, not P2P —
  `local-chat`'s proxy would fall through to the wrong id space).
- **Long-press guard** (1.4.20): the row's 500 ms context-menu timer cancels
  on `touchcancel` AND on multi-touch (`touches.length > 1`) — the WebView
  claims two-finger gestures and answers with `touchcancel`, not `touchmove`,
  which previously left the timer alive (menu opened mid-swipe).
- **Read ticks** (1.4.20): the delivered/read double-check is Delta Chat
  desktop's fill-based SVG in a 3:2 viewBox (`TICK2`, components.js);
  `.ci-last .ci-ticks` was retuned to 17×12 for the aspect. The single
  "sent" check (`TICK1`) and the selection checkbox (`ICO.check`) are
  unchanged stroke icons.
- `app/js/components.js` defines the Elena custom elements
  (`<velta-avatar>`, `<velta-chat-item>`, `<velta-chat-head>`,
  `<velta-video>`). KEEP: the verified rosette reads
  `chat.contact.verified` (the contact is the real source; chat-list rows
  never hydrate contacts — one RPC per row) and shows in header/profile
  only; presence maps core `lastSeen: 0` to `null` = unknown (no subtitle,
  no "last seen just now" — never a `Date.now()` fallback, fixed 1.4.5).
- `app/js/avatar.js` — fingerprint color-matrix identity tiles, delivered
  as percent-encoded SVG data-URL CSS backgrounds (`avatarBackgroundUrl`,
  cached per fingerprint — zero child nodes); group avatars stay solid
  color; a contact's photo rides inside the matrix tile; photo avatars
  shimmer via the img's own background until `load` (`.loaded` removes it —
  Elena does not reliably call `updated()` on first render, so bind from
  `updated()` AND once via rAF from `connectedCallback`).
- **Theming contract**: `THEME_LABELS` (ui.js) drives the picker;
  `applyTheme` (app.js) sets `html[data-theme]` + the theme-color meta.
  Themes: auto (system), dark, light, brutal (1.4.6 — explicit only, never
  matched by Auto). A theme is a token block in main.css plus component
  overrides appended AFTER the base rules (brutal re-overrides the 1.4.3
  quote palettes — keep it last). Every new theme value lands in
  `THEME_LABELS` and the theme-color map together.
- **List action bar + side views** (`.list-bar`, 1.4.7+): buttons switch
  what `#chat-list` shows via `setListView` over {chats, contacts, calls,
  qr, search, new}; `renderChatList` early-returns unless the view is
  "chats" (keep that gate — refresh storms clobber the other views).
  Contacts come from `core.getContacts` through a virtual scroller
  (`sideScroller`, stopped by `stopSideScroller` on every view switch);
  Calls read the LOCAL call log (localStorage `velta-call-log`, capped 30 —
  the core has no call-log API); QR renders `inviteQrProvider(null)`. The
  header search button and `#btn-new-chat` are view toggles
  (`syncHeaderButtons()` from `setListView` — keep that call). Button
  visibility is user-configurable (drawer → Bottom bar buttons, localStorage
  `velta-bar-hidden`); `applyBarVisibility` adds `.bar-bare` when all four
  view buttons are hidden; Menu and `#btn-new-chat` are always visible. The
  old `.fab`/`.sidebar-foot` and the sidebar-head Menu button are gone —
  do not resurrect them.
- **Drawer contract** (ui.js `buildDrawer`): no close button, no offset
  shadow (slides over the sidebar's own edge; a right border separates).
  Stops above the list bar (`inset` bottom = `var(--list-bar-h)`).
  open()/close() dispatch a `velta-drawer` document event (the bar Menu
  button listens to flip hamburger↔cross and to close instead of re-open).
  Width `clamp(300px, 33vw, 420px)`, full width on mobile. While open, a
  capture-phase document `pointerdown` listener closes it on outside taps;
  the transparent overlay swallows the click.
- **Header heights** are pinned by `--head-h` (56px): `.sidebar-head` and
  `.chat-head` are border-box
  `height: calc(var(--head-h) + env(safe-area-inset-top))`. Change the var,
  not the paddings.
- **History loading strip** (`#chat-load-bar`): 6px blue gradient sweep
  pinned under the chat header; turned on by BOTH `chat-view.open()` and
  `_loadOlder()` (paging is history loading too); `_loadBar()` holds a
  150 ms minimum on-time and a new on cancels a pending off; sits at
  `top: calc(var(--head-h) + env(safe-area-inset-top))`.
- **Times are 24-hour**: `formatTime` (mock-core.js) forces `hour12: false`
  and is the single timestamp source for chat rows, list rows and call
  lists — don't reintroduce locale defaults (rendered `03:21 AM` on en-US).
- All `:hover` styling lives inside
  `@media (hover: hover) and (pointer: fine)` — touch devices report
  `hover: none` and hover states stick after taps. `:active` press feedback
  and non-hover states (`.relay-detail.pull-open`) stay reachable on touch.
- `app/js/diagnostics.js` is the in-app diagnostics store ("Velta
  Diagnostics" chat): console-style rows (shared `diagnosticRow()` helper),
  identical consecutive entries collapsed into one counted row — prefer
  appending here over toasting for repeatable background errors.
- `app/js/media.js` resolves local paths to WebView-safe media URLs:
  blobfile probe → loopback HTTP → asset protocol, with one-shot error
  fallbacks per element. Details and the WebView2 media quirk:
  docs/agents/media.md.
- `app/js/poster.js` — lazy WebP poster extraction + disk cache.
- `app/js/ui.js` — drawer, modals, context menus, toasts, update banner,
  delete-confirmation dialog. The drawer head shows the avatar (self
  profile sheet via `onProfile`), display name, Edit profile and Switch
  account (`.acct-pop` dropdown, current checked). `.qr-box` carries no
  background/border of its own — the core's QR SVG is self-contained.
- `app/js/mock-core.js` — self-contained demo backend when no real core is
  reachable (`localStorage["velta-mock"] = "1"` forces it). Implements the
  same contract surface as the real core, including
  `accountId`/`accountEpoch` (undefined values made `a?.x === a.x` guards
  pass on null and crashed demo mode), with no-op demos for vCard and
  backup transfer.

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

### 5.4 Local chat, serverless P2P (`velta-app/src-tauri/src/p2p.rs` + `app/js/p2p.js` + `app/js/local-chat.js`)

A core-independent 1:1 end-to-end-encrypted transport between paired
devices on the same network (iroh QUIC, relay-less, optional mDNS
discovery). Pairing tickets, offline queues, media chunking, the
`local-chat.js` Proxy adapter and its test pins are documented in
docs/agents/p2p.md. KEEP: local chat is disabled by default — a fresh
install must not open QUIC sockets or broadcast LAN beacons unasked.

### 5.5 In-app browser (Android)

Message links open without leaving the app: Custom Tab (the user's default
browser first, then any visible CustomTabsService provider) → native
second-WebView overlay → JS iframe fallback. The full chain, its JNI and
launch-context gotchas and the `<queries>` requirements are documented in
docs/agents/android-shell.md.

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
- `app/vendor/` files carry local fixes for upstream bugs (the zoom
  normalization in `virtual-scroller.js` is a patch, not upstream code).
  Read `VENDORISSUES.MD` before upgrading or re-vendoring any of them, and
  re-apply the local patches afterwards.
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
  always measure the actual combination. Bubble-internal `.btn-text`
  actions ("Show Full Message…", transfer Retry) are scoped per surface in
  main.css: `.msg-row.out` uses `--text-meta-out`, light incoming a darkened
  `#1a68b8`, brutal incoming `--accent-2` — raw accent fails on all three
  (3.0/2.85/1.67 plus 4.19 on brutal incoming). Keep new inline buttons on
  those scoped rules, not bare `.btn-text` inside a bubble.
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

Known-broken (pre-existing, noted 2026-09-19): `app-account-isolation`,
`chat-account-isolation` and `chat-msg-update-hardening` all fail with
`document/window.addEventListener is not a function` — their DOM stubs don't
implement `addEventListener`. The `rpc-*`, `call-state-machine` and
`local-chat-transfer-progress` suites are healthy; verify rpc-core/app.js
changes against those until the stubs grow the method.

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
  The browser/PWA path (no Tauri header) carries the same policy as a meta
  tag in `app/index.html` (1.4.11) — Tauri-only scheme tokens (`ipc:`, `asset:`, …)
  are inert there and kept so the copies stay byte-identical. `diag.html`
  has its own looser dev policy (`unsafe-inline` for its single inline
  script). Keep it tight when adding new frontend capabilities, and update
  **all three** places together: both conf files and the meta tag.
  - `connect-src` is loopback-only again (1.4.16): the github hosts that the
    update banner briefly added were removed — the version check runs
    shell-side (`get_latest_version` ureq command in lib.rs), and shell HTTP
    is not CSP-bound, so the renderer has NO GitHub reach. Do not re-add
    github hosts for it: release downloads 302 to a randomized CDN URL, so
    CSP path pinning can never scope them (CSP paths are not a security
    boundary), and the cross-origin page fetch fails on CORS regardless
    (GitHub's CDN sends no ACAO headers — that is what silently killed the
    banner in 1.4.14/1.4.15).
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
- The service worker is unregistered at boot (stale-JS-upgrade incidents —
  see §4.2); `sw.js` is vestigial and nothing caches the app shell in a
  plain browser.
- If `deltachat-rpc-server` or the Android service is running on the same
  device, the app connects over loopback WebSocket/HTTP; otherwise it falls
  back to the mock core.
- **Direction (since 1.3.29):** the PWA's target deployment is a *remote*
  core service reached over WSS/TLS — `transport.js` currently hardwires the
  loopback endpoints (`ws://127.0.0.1:20808`, `http://127.0.0.1:20809`), and
  a remote transport will replace them. CSP implication when adding
  origins: the meta CSP in `index.html` must learn every new origin
  alongside the Tauri conf copies (§8).

### 9.2 Tauri desktop/Android app

- The Tauri Rust layer embeds `deltachat-jsonrpc` as a library and exposes two
  commands: `invoke("rpc", { request })` to call the core, and `emit("velta-rpc")`
  to push core events to the WebView.
- Account data lives in the platform app-data directory:
  - Windows: `%LOCALAPPDATA%/org.velta/accounts` (identifier `org.velta`;
    pre-rebrand desktop builds left `%LOCALAPPDATA%/chat.delta.desktop.tauri`
    and `%LOCALAPPDATA%/deltachat-tauri` behind — dead, do not use)
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

## 11. Notes for agents (operational rules)

Per-subsystem narratives live in `docs/agents/*.md` (webxdc, relays,
onboarding, p2p/local chat, android-shell, media) — read the relevant one
before touching that subsystem. The entries below are cross-cutting
do-not-regress rules; dates mark when the lesson was learned.

- **Event-storm hardening (1.3.23)** — the failure was a core event storm
  re-rendering chat history endlessly. KEEP: rpc-core `_onLine` runs the
  late-response hook only for entries the 240 s backstop already rejected
  (running it for live entries doubles every event); chat-view
  `onMsgUpdated` calls `onItemHeightDidChange` only for mounted rows and
  SETS the new row signature for unmounted ones (deleting it made every
  duplicate event retake the full changed path); `_renderItem` seeds
  `_rowSigCache` at build time (removing it makes the first duplicate
  update rebuild mounted rows); `onMsgsChanged` coalesces refetch bursts
  (`tailRefetchGapMs`) and self-heals delivery-state ticks (keep `state`
  in the condition — a dropped event left a sending spinner stuck for
  hours); `refreshRelayStatus` coalesces connectivity-driven polls. Tests
  shrink these via instance knobs, never by deleting the gates.
- **Boot error net (1.3.26+)** — `js/boot-net.js` loads before every other
  script and routes errors into the Diagnostics sink once app.js is alive,
  `#boot-error` before that; `boot()` is stage-isolated (`uiLive` — see
  §5.1 app.js bullet).
- **Audio calls (1.3.26+, calls.js)** — the core does encrypted call
  signaling (place/accept/end ride as messages; `place_call_info` is the
  caller's SDP offer, `accept_call_info` the answer — raw SDP, non-trickle
  ICE) and the WebView does media (RTCPeerConnection + getUserMedia, ICE
  from the core's `ice_servers()`); events map to incoming-call /
  outgoing-call-accepted / incoming-call-accepted (`fromThisDevice: false`
  = another device accepted — stand down) / call-ended. The WebRTC/DOM
  adapter is injected into CallManager so
  `tests/call-state-machine.test.mjs` runs headless — keep it injected.
  Desktop mic grant needs `--use-fake-ui-for-media-stream` (wry denies
  permission requests by default — only clipboard is allowed); Android
  needs RECORD_AUDIO in the gen manifest, granted by wry's
  RustWebChromeClient. Video calls are not offered.
- **Modal async flows (1.3.35)** — settle BEFORE close: `showModal`'s
  `onClose` resolves the flow's promise with null, so `close()`-first
  silently drops results (it swallowed every successful QR scan once).
  Always `finish(result); close();` — never the reverse.
- **Never open the Android soft keyboard over the camera** — any scan flow
  must `blur()` inputs while scanning and refocus only when returning to
  paste mode (`qr-scan.js` gates its initial `focus()` on the camera being
  unavailable).
- **CSS `display` beats the `hidden` attribute** — a styled element with
  `hidden` stays visible; add explicit `.foo[hidden] { display: none }`
  when toggling a styled container via `hidden` (bit the splash panes).
- **Never use native `prompt()`** — group creation asks via a `showModal`
  input (`askGroupName`).
- **Elena prop defaults** — keep every `static props` entry backed by a
  field or a constructor install, and keep defaults STRING-typed, never
  `null`: `typeof null === "object"` made Elena JSON-parse every attribute
  value (`VeltaChatItem` logged "Invalid JSON: c49" for string ids).
- **Message ids are numbers** — `_resendTail`/`onMsgsChanged` compare ids
  with `>`; string ids silently drop messages from the append-only filter.
- **Overlay/BACK conventions (1.3.36+)** — every fullscreen overlay (HTML
  viewer, webxdc, in-app browser, image lightbox) pushes ONE `{velta:…}`
  history entry on open; WryActivity's OnBackPressedCallback calls
  `mWebView.goBack()` when it can, so BACK pops the entry and a `popstate`
  listener tears the overlay down (app.js treats a revealed
  `{velta:"chat"}` as keep-the-chat). Close buttons and programmatic
  closes consume the entry via `history.back()`; reopening an already-open
  overlay REPLACES its entry (back-then-push races and loses it).
- **Update banner (1.4.14+, shell-side since 1.4.16)** — boot fires
  `checkForUpdate()` (ui.js, fire-and-forget); the latest version comes
  from the shell command `get_latest_version` (lib.rs, ureq, hardcoded
  version.txt URL, 5 s timeout) because the renderer's cross-origin fetch
  is CORS-blocked by GitHub's CDN — do not move it back into the page and
  do not re-add github CSP hosts (§8). Newer remote → drawer-bottom banner
  with Download APK (`plugin:opener|open_url`) + `.update` pulse on
  `#bar-menu` (box-shadow animation, no layout shift; disabled under
  `prefers-reduced-motion`). No banner when versions match, offline, or
  empty response (pre-1.4.14 releases carry no version.txt).
- **Interface scale + theme (1.4.2+)** — `MainActivity` pins the WebView's
  `textZoom = 100` (system font scale otherwise applies text-only zoom
  that inflates text out of the px-sized boxes); scaling is app-owned via
  drawer radios (zoom on `<html>`, `velta-ui-scale`, applied pre-paint by
  the external `js/ui-scale.js` — the CSP forbids inline scripts). Root
  zoom multiplies viewport units but not percentages: the shell stays
  percentage-based (`100dvh` pushed the list bar off-screen, 1.4.14), the
  vendored virtual-scroller carries the `__vsZoom` rect normalization
  patch, and `applyUiScale` dispatches `resize` so the scroller re-measures
  (1.4.14). `text-size-adjust: 100%` on html neutralizes font boosting.
  Theme radios (auto/dark/light; auto is the default for fresh installs)
  and scale radios apply in place — never `rebuildDrawer()` on a radio
  change, it would close the drawer. Keyboard vs header: see
  docs/agents/android-shell.md (1.4.17).
- **Build environment** — core cargo commands run in WSL (native Windows
  cargo fails in openssl-sys: MSYS perl lacks
  `Locale::Maketext::Simple`); the Windows sidecar exe is built by
  `build-windows.yml` on tag push, so stale local binaries in
  `velta-app/src-tauri/binaries/` refresh only at release. Never build the
  Android APK with that directory present (Tauri bundles it verbatim:
  +22 MB of Windows PE in every APK); `tools/wsl-android-build*.sh` delete
  it as a guard.
- **Scope guards** — `core/` is a large vendored upstream copy: avoid
  changing it unless the task is fixing/extending the core itself.
  `velta-app/src-tauri/gen/android` is generated EXCEPT the hand-maintained
  `AndroidManifest.xml`, Kotlin sources and
  `res/xml/network_security_config.xml` — edit those by hand, regenerate
  the rest. `velta-core-service/` is secondary — read its README first.
- **Version bumps** touch `velta-app/src-tauri/tauri.conf.json`, the
  `velta-app` package in `velta-app/src-tauri/Cargo.toml` (+`Cargo.lock`)
  and the `CACHE` constant in `app/sw.js`; each release commit notes both.
  (The service worker is unregistered at boot — the CACHE bump is release
  bookkeeping.)
- **README convention** — every `##` section below "Screenshots" is wrapped
  in `<details><summary>…</summary>` with a blank line after `</summary>`,
  so the front page stays short.
- **Releases** — `release.yml` is the single tag→release path (`v*` tag
  push or manual dispatch; branch pushes build nothing — do not re-add
  `push:` triggers to the reusable workflows, and no per-job
  `concurrency` blocks: inside a reusable-workflow call `github.job` is
  empty at group-evaluation time, so android and windows collapse into one
  group and cancel each other — that killed the 1.4.6–1.4.8 releases). It
  publishes `Velta-<version>-<abi>.apk`, `version.txt` (the update-banner
  feed), `Velta_<version>_x64-setup.exe` and `latest.json` (the Windows
  self-update manifest — must stay the last-uploaded asset), writes
  `changelog.md` from commit subjects, and the notify job posts to
  `ntfy.gluek.info/velta_changelog`. The keystore lives in `signing/`
  (gitignored) and the four `ANDROID_KEY*` repo secrets — losing both
  means installed APKs can never be updated again.
  `build-windows-cross.yml` is manual-dispatch only.
- **Windows self-update** — the desktop banner button drives
  `tauri-plugin-updater`: it fetches `latest.json`, verifies the minisign
  signature, runs the NSIS installer and relaunches (`tauri-plugin-process`).
  The updater keypair lives in `signing/velta-updater.key` + password file
  (gitignored) and the `TAURI_SIGNING_PRIVATE_KEY*` repo secrets — losing
  them kills the updater for every future release. Only installer installs
  self-update; a bare copied `velta-app.exe` does not.
- **JSON-RPC compatibility** — when changing the RPC surface, the PWA
  (`rpc-core.js`), the Python RPC client and any external consumers must
  stay compatible.
- **Core 2.60 relay removal** — relay removal is immediate (the core
  refuses only the last relay and re-elects sending, informing contacts
  via keyupdate); `set_transport_unpublished` no longer exists — never
  reintroduce it. Check COREUPDATE.md §7 on every core upgrade (example:
  mails the core fetches and ignores must still be marked seen on the
  server, or IMAP idle re-fetches them forever).
- **Privacy** — zero analytics/telemetry (verified against the codebase
  2026-09-15; the only documented exception is the Windows WebView2
  install bootstrap). Keep it true.
- **Frame theming (1.3.34)** — the HTML viewer and webxdc iframes are
  themed via `color-scheme`, injected per frame (srcdoc `<style>` /
  `?velta-theme=` + `documentElement.style.colorScheme`) because the
  iframe element's scheme only paints the canvas. Device chats
  (`kind === "device"`) hide the composer.
