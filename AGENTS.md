# Velta — Agent Guide

This document is written for AI coding agents that need to work on the Velta
project. Read it first. It describes the repository layout, technology stack,
build/test commands, and conventions as they actually exist in this checkout.

> **Scope note:** This repository is a Velta-specific workspace layered around a
> copy of the upstream [Delta Chat core](https://github.com/chatmail/core)
> (version `2.62.0`). The `core/` directory is effectively a vendored copy of
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
- **Standalone browser** (work in progress) — the PWA can be served from a
  static host and falls back to a mock core for demo/development. This is
  not a supported release target.

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
│   │   ├── invites.js        # invite-link registry (mirror domains), parsing, short-link expansion, invite cards, settings modal
│   │   ├── local-chat.js     # local chat core adapter: Proxy interceptor for p2p:<peerId> chats, media transfers/progress, offline queue + auto-flush (see 5.4 / conventions)
│   │   ├── markdown.js       # escape-first message markdown: bold/italic/underline, links, lists + bot command extraction
│   │   ├── media.js          # media URL helpers: blobfile:// protocol (boot-probed) → loopback server → asset protocol + per-element fallback
│   │   ├── p2p.js            # Local chat UI: drawer toggle, list card, pairing, legacy 1:1 modal (Tauri only)
│   │   ├── read-markers.js   # manual "read up to here" markers per (account, chat), localStorage-only
│   │   ├── qr-scan.js        # code acquisition: paste or camera scan (native BarcodeDetector probed with a 2s timeout, vendored jsQR fallback — many Android WebViews ship no Shape Detection API or one whose detect() hangs)
│   │   ├── format.js         # pure time/size/pageBounds helpers shared by prod modules (mock-core re-exports them)
│   │   ├── mock-core.js      # in-memory demo core implementing the JSON-RPC surface (NOT in the prod import graph: transport imports it dynamically)
│   │   ├── rpc-core.js       # JsonRpcCore wrapper over transports + event mapping
│   │   ├── transport.js      # backend auto-detection (Tauri, WebSocket, HTTP, mock)
│   │   ├── webxdc-manager.js # webxdc host: opaque-origin sandboxed app overlay, shim postMessage relay, per-instance serials
│   │   └── ui.js             # drawer, modals, context menus, toasts
│   ├── vendor/               # third-party frontend libraries
│   │   ├── elena.js          # lightweight web-components library
│   │   └── virtual-scroller.js
│   ├── diag.html             # connection diagnostics page for the service bridge
│   ├── index.html            # main app shell
│   └── manifest.webmanifest  # PWA manifest (name: "Velta")
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
│   ├── Cargo.toml            # workspace manifest, version 2.62.0
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
│                              onboarding, security-triage) — referenced from §5/§11
└── tools/                    # icon generation, WSL APK build/sign helpers,
                              serve-dev.py (no-cache static server for app/)
```

Not tracked (local runtime/build artifacts): `accounts/` (local core account
databases), `*.apk` builds, `signing/*.keystore`.

### 2.1 Disk cleanup — safe-to-delete folders (10 GB+ rule)

Any folder below can hit tens of GB. When a folder in this table exceeds
**10 GB**, deleting it is always safe; it is fully regenerated by the next
build (cost: a cold rebuild):

| Folder | Typical size | Regenerated by |
|--------|--------------|----------------|
| `velta-app/src-tauri/target/` | 20–45 GB | `cargo tauri dev` / `cargo tauri build` in `velta-app/src-tauri/` |
| `core/target/` | 10–25 GB | any `cargo build`/`test` in `core/` (WSL) |
| `velta-core-service/rust/target/` | ~3 GB | `cargo build` in `velta-core-service/rust/` |
| `core/target-win/` | ~2 GB | sidecar build (§4.3.3 recipe, `CARGO_TARGET_DIR=target-win`) |
| `core/target-android/` | ~0.6 GB | android cross builds (§4.3.3) |

Measured 2026-09-26: the whole Velta tree held ~43 GB of target dirs; deleting
all five reclaimed 51 GB on C: (Windows `AppData/Local/Temp` gave ~4 more) and
the next local APK build succeeded from scratch.

Never delete for space: `velta-app/src-tauri/binaries/` (Windows sidecar,
see §4.3), `deltachat-backend/` (prebuilt RPC servers), `core/test-data/`
(test fixtures), `signing/` (keystore).

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
core unless a real backend is reachable. That also makes it the fastest
renderer smoke test: serve `app/` over plain http, and full UI flows are
drivable in demo mode (no Tauri build needed). The standalone PWA product
(a static host talking to a remote core) is work in progress; demo mode
here is only the UI smoke test. **KEEP:** every new
`rpc-core.js` method needs a `mock-core.js` counterpart or demo mode throws
"not a function" the moment the UI touches it. Demo honesty (1.4.52, #53;
MDN arrival added 1.4.53, #59): MockCore never *invents* read receipts —
own messages rest at `delivered` (1:1 fixture history reads as `read`), the
double tick needs an MDN, and a 1:1 peer returns one a few seconds after a
send (groups never do) — and `sendMessage`/`resendMessage` emit
`send-activity` like the real core so the relay line dashes and detail-chip
envelope work in the demo (demo *mode* itself still suppresses both marks:
no relay configured, nothing sends through one).

The service worker is dead by design: boot unregisters every registration
(app.js, near the PWA comment — cache-first SWs kept serving stale JS across
upgrades). `app/sw.js` shipped dead weight for years and was deleted (#48);
don't re-register one. Startup script loads (#48): `ui-scale.js` and
`boot-net.js` stay parser-blocking on purpose (pre-paint scale, early error
banner); `vendor/virtual-scroller.js` is `defer` — module scripts run after
deferred scripts, so the global class exists before `new VirtualScroller`.
`mock-core.js` must stay out of the prod import graph: transport dynamic-
imports the demo core, and prod modules take the shared helpers from
`format.js` (mock-core re-exports them for demo mode and tests).

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

KEEP (asset staleness trap): the debug exe embeds `app/` at compile time via
`generate_context!`, and neither `touch tauri.conf.json` nor
`touch src/lib.rs` reliably re-embeds changed renderer assets — after
editing `app/`, force the rebuild with `cargo clean -p velta-app` before
`cargo tauri build --debug --no-bundle`, then relaunch. Verify from the
running app with `fetch('js/mock-core.js', {cache:'reload'})` (paths are
relative to the `tauri.localhost` root — `fetch('mock-core.js')` 404s and
fakes a "stale build" verdict). The running exe serves `http://tauri.localhost`
embedded assets only — a leftover static dev server on the devUrl port
(1430) is NEVER consulted by current binaries; a stale module + fresh bytes
confusion means the page is loading embedded assets, not your server.

Desktop `cargo check`/`build` of this crate runs **natively on Windows only** —
the WSL sandbox lacks the GTK/gobject dev libraries (pkg-config `gobject-2.0`
failure); see §11 "Build environment".

**Never build the Android APK with `velta-app/src-tauri/binaries/` present.**
That directory holds the Windows sidecar staged for the desktop installer
(README "Build locally"); `tauri.conf.json` lists it under `bundle.resources`,
and Tauri packages resources verbatim into every target — including the APK's
`assets/` (+22 MB of useless Windows PE; 68 MB APK instead of ~45 MB). The
`tools/wsl-android-build*.sh` scripts delete the directory as a guard; if you
build by hand, remove it first.

**Capabilities need explicit `platforms` scoping.** A capabilities file
without a `platforms` field applies to ALL platforms, and tauri-build
validates each capability's permissions against the plugin manifests of the
target being built — `updater:default`/`process:allow-restart` live in
desktop-only dependency crates, so the Android build died with
"Permission updater:default not found" (cost the first v1.4.20 release run).
**fs plugin access is scope-gated (V-07/#65):** the capability files carry
`fs:default` + `fs:allow-read-file`/`fs:allow-write-file` +
`fs:scope-applocaldata-recursive` — NO `fs:read-all`/`fs:write-all`. The
only arbitrary-path reads are user dialog picks; the renderer must call
`allow_picked_path` (lib.rs) right after a pick to add that path to the
plugin's runtime scope (`tauri_plugin_fs::FsExt`). Writes go exclusively to
`resolve_upload_path` targets under `AppLocalData/uploads/`, whose filename
argument is reduced to its final component (traversal guard). New file
flows must follow this pattern — do not re-add `*-all` permissions.
Rule: desktop-only permissions stay in a file pinned to
`"platforms": ["linux", "macOS", "windows"]` (`capabilities/default.json`),
mobile-only ones in `mobile.json` (`android`/`iOS`); shared ones may repeat
in both.

**Every capability also needs `windows` targeting.** The runtime matches a
capability against a webview label; a file without `windows` matches NONE.
Mobile rode on `default.json`'s implicit-everywhere `windows: ["main"]` until
the platforms pinning above removed it from Android — `mobile.json` then
matched no webview, every plugin command was denied ("Command
plugin:event|listen not allowed by ACL"), core init failed and the app fell
back to demo mode with no accounts (broke 1.4.21–1.4.22, fixed 67d2e0e /
v1.4.23). `mobile.json` now carries `"windows": ["main"]`. Diagnose runtime
ACL denials from the BUILD output, not the sources: read the resolved
`capabilities.json` under `target/<target>/release/build/velta-app-*/out/`
and check identifier + platforms + windows for the platform you build.

Related dead code (1.4.23 audit): `transport.js` probes
`window.VeltaBridge` for an "android-webview" transport that nothing
injects — Android has always bootstrapped through the `tauri` transport
(`event.listen` in its `setReceiver` is the first thing an ACL break
kills). Remove or wire the probe deliberately before trusting it.

**A stale desktop debug app blocks local builds.** `velta-app.exe` left
running (with its `deltachat-rpc-server.exe` sidecar) makes tauri-build fail
with "os error 32 ... used by another process" — kill both before
`cargo check`/`tauri build`.

Note: `velta-app/src-tauri/Cargo.toml` currently pins the core via git. For
local development against the bundled `core/`, uncomment the `path` dependency.

### 4.3.1 Rebuilding the Windows sidecar from the vendored core

`cargo build -p deltachat-rpc-server --release` in `core/` builds vendored
OpenSSL (rusqlite `bundled-sqlcipher-vendored-openssl` +
async-native-tls/vendored). On a stock Windows toolchain this fails twice —
both failures were hit and cost a 13-minute dead build; never repeat them:

- **Perl must be Strawberry Perl (or another full Windows perl).** Git Bash's
  bundled perl is missing core modules — OpenSSL's Configure aborts with
  `Can't locate Locale/Maketext::Simple.pm in @INC` (via `Params/Check.pm` →
  `IPC/Cmd.pm`). A portable Strawberry zip extracted to `tools/` and put
  first on `PATH` works; no installer or admin needed. The verified
  toolchain is now vendored locally (both gitignored): `tools/strawberry-perl/`
  (5.32.1.1 portable, `Locale::Maketext::Simple` confirmed present) and
  `tools/nasm/` (2.16.03). Build with
  `$env:PATH = "<repo>\tools\strawberry-perl\perl\bin;<repo>\tools\strawberry-perl\c\bin;<repo>\tools\nasm;$env:PATH"`.
  Re-extract after a checkout on a fresh machine — download the
  5.32.1.1 64bit-portable zip (the 5.38.x portable URL 404s) and the NASM
  win64 zip. See `docs/agents/release-ci.md` for the full recipe and
  incident notes.
- **NASM is needed for asm builds.** Without it, set `OPENSSL_NO_ASM=1`
  (builds fine, skips hand-tuned assembly).

Then copy `core/target/release/deltachat-rpc-server.exe` to
`velta-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe`
*and* `velta-app/src-tauri/binaries/deltachat-rpc-server.exe`, and verify the
swap by piping a `get_system_info` JSON-RPC request into the exe's stdin —
it must report the vendored core's version (v2.62.0 since 1.4.33; the
previous prebuilt was silently v2.59.0, which the drawer footer exposed).
`.github/workflows/build-windows.yml` does the same via
chocolatey-installed StrawberryPerl + NASM.

### 4.3.2 macOS build (test build, ad-hoc signed)

- `tauri.macos.conf.json` swaps the Windows `bundle.resources` sidecar for
  `bundle.externalBin: binaries/deltachat-rpc-server` — Tauri resolves
  `binaries/deltachat-rpc-server-<target-triple>` (or
  `-universal-apple-darwin`) at BUILD time, even for `cargo check`, and
  ships it as `Contents/MacOS/deltachat-rpc-server`. `find_sidecar` looks
  the name up per platform (`SIDECAR_NAME`). KEEP the Windows sidecar out
  of the macOS bundle and vice versa.
- `tauri-winrt-notification` MUST stay under `[target.'cfg(windows)']` —
  under the old `not(android/ios)` gate it dragged the `windows` crates
  into macOS builds, which do not compile there.
- Desktop log dir: Windows keeps `%LOCALAPPDATA%\Velta\logs`; macOS/Linux
  use `app_log_dir()` (`~/Library/Logs/org.velta`) — there is no
  LOCALAPPDATA, and the relative fallback resolved to an unwritable `/`.
- `Info.plist` (merged by tauri-build) carries the microphone/camera usage
  strings; `Entitlements.plist` grants audio-input/camera under the
  hardened runtime. A new capability that touches a TCC-protected resource
  needs both.
- Signing: `signingIdentity: "-"` (ad-hoc), no notarization — users clear
  the quarantine once (README "Install", release notes). Setting the
  `APPLE_*` secrets (Developer ID + notarytool) in `build-macos.yml` is the
  upgrade path; the env identity overrides the config.
- Updater: `latest.json` carries `darwin-aarch64` + `darwin-x86_64`, both
  pointing at the one universal `Velta_<version>_universal.app.tar.gz`.

### 4.3.3 Local Android APK builds (WSL)

`build-velta-android-wsl.sh` (workspace script in the PARENT directory,
`C:/Users/pave/Velta/`) copies the tree to `~/velta-android-build` and builds
a debug universal aarch64 APK via `cargo tauri android build`; it prints the
APK path at the end. Needs the WSL JDK/SDK/NDK paths baked into the script
and **~25 GB free on Windows C:** — the build lives inside the WSL
ext4.vhdx, which lives on C:. Check `df -h /c` before starting: WSL-side
`df` shows the vhdx's virtual size (1007G), never the Windows free space,
which is what actually limits the vhdx's growth.

Failure catalog (both hit on 2026-09-26; the fixes live in the script):

- **openssl-src `install_dev` → `make … Error 127`,
  `aarch64-linux-android-ranlib: not found`.** The NDK ships only
  `llvm-ranlib`/`llvm-ar` — no target-tripled wrappers, which is what
  openssl's install recipe invokes. The script exports `RANLIB`/`AR`
  pointing at `llvm-ranlib`/`llvm-ar` and prepends the NDK toolchain bin to
  PATH. Keep those exports when editing the script.
- **Disk full** (above): a gradle JVM fatal error mid-build plus
  `wsl -e` refusing to start (`CreateInstance E_FAIL`) both mean the vhdx
  could not grow. Free C: space first — deleting WSL-side files does NOT
  shrink the vhdx (sparse mode is refused by WSL over corruption risk), so
  the room must exist on C: before the build starts.

### 4.4 Android background service (`velta-core-service/`)

**Incoming-message notifications** have platform parity: Windows
`notify_incoming` renders a three-line toast (chat name / sender / text +
circular sender avatar) via `tauri-winrt-notification` directly — AUMID is
the config identifier, so toasts only resolve after one installer install
(`examples/win-toast.rs` is the manual visual check). The page requests a
toast when the window is minimized or unfocused, not only when
`document.hidden` is set — WebView2 leaves the page visible while the
window is minimized (`shouldNotifyIncoming` in `app/js/notify-policy.js`).
Android: see below.
**Incoming-message notifications (Android)** are posted only by
`bg_notify_incoming` (lib.rs) over JNI into
`gen/android/.../org/velta/Notifications.kt`: MessagingStyle conversation per
chat (group name title / sender line / plain text — never a "Group:" prefix),
sender avatar as the Person icon, chat avatar as largeIcon, follow-up
messages append to the same conversation. KEEP: the JNI signature there must
match `Notifications.show`; optional avatar paths pass as null JStrings
(`opt_jstring`); the fallback when the Kotlin side is unreachable is a plain
title/body notification. Receiver-type confusion against
`android.app.Notification.Builder` means the compat inner class did not
resolve — import `androidx.core.app.NotificationCompat.MessagingStyle`
explicitly.
**Notification taps open the chat (issue #20):** the contract is the link
`velta://chat?account=<id>&chat=<id>&t=<token>` (account 0/absent = current
profile). The token is a persistent 128-bit hex value in app-local data
(`chat-link-token`), returned by `chat_link_token`. Android:
`Notifications.show` takes that token as its last String argument (the JNI
signature must keep matching) and sets an explicit `ACTION_VIEW` content
intent with the link on `MainActivity`; tao turns VIEW data into
`RunEvent::Opened` on cold start (onCreate) and warm start (singleTask →
onNewIntent), and `run()` parks it for `get_initial_deeplink` + emits
`deeplink`. Windows: `notify_incoming` takes `accountId`/`chatId`, appends
the same token, and the toast's `on_activated` focuses the main window and
emits `deeplink` (in-process only — a toast clicked after the app quit just
launches it). Frontend: load `chat_link_token` before handling any link,
then `handleDeeplinkFromUrl` → `extractChatLink` → `openChatFromLink`
(switch account if needed, `getChat` check, `openChat`). A `velta://chat`
whose `t` does not match is ignored (issue #23), so a web page that fires
the scheme cannot switch account or open a chat. Pinned by
`tests/notification-deeplink.test.mjs`. macOS plugin notifications do not
carry the link. `chat_link_with_token` is `#[cfg(target_os = "windows")]`
because that is its only caller. The macOS and Windows release builds set
`RUSTFLAGS=-D warnings`, so an ungated helper is dead code on macOS and
fails the job (v1.4.44 never published). Gate a new helper with the same
`cfg` as the code that calls it. See docs/agents/release-ci.md.

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
  backup export (`exportBackup` -> core `export_backup`, directory +
  optional passphrase, progress on `imex-progress`), autorelay onboarding
  (`initTransports` -> core `init_transports`; the core probes its built-in
  relay pool and configures the fastest, then grows the profile to ~3
  transports from IMAP idle hooks — wired into the splash "Autopick the
  fastest relay" button),
  vCard (`parseVcard`/`importVcard`/`makeVcard`), `getMessageHtml` (original
  body behind "Show Full Message…"), `createQrSvg`. Chat fulltext
  search (`searchMessages` -> core `search_messages`; wired into the Search-in-chat modal), pinned messages (`pinMessage`/`getPinnedMessages`, core 2.59+ API). Wire types are
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
  into the static `#boot-error` banner before that. Startup RPC chain
  (#46): boot's retrying `getAccount` is THE account fetch — `refreshAccounts`
  takes it as `knownAccount` instead of issuing a second one; chat-list
  paint never awaits fingerprints (avatars render initials/plain color and
  re-render when `fingerprintFor` resolves). Subsystem notes:
  docs/agents/relays.md (relay line/detail/manager), onboarding (splash,
  second device). Chat-list **Delete chat** calls `deleteChat` → core
  `delete_chat` and the chat leaves the list (#34). `deleteMessages` only
  clears rows; the in-chat **Clear history** action feeds it `getMessageIds`
  (ids only, #47 — it never loads the full messages). A
  `p2p:` chat is forgotten with `removePeer` — do not send that string id
  to `delete_chat`. Pinned by `tests/rpc-account-isolation.test.mjs`.
- **Chat-list categories bar** (1.4.52, #57): `#chat-categories` chip row in
  `index.html` between the relay zone and `#chat-list` — All / People /
  Groups / Channels / Bots / System. `chatCategoryOf` and the swipe axis
  lock `swipeCategoryStep` are exported from `rpc-core.js` (NOT
  `components.js` — it extends `HTMLElement` and is not node-importable for
  tests); filtering runs via `visibleChats()` inside `renderChatList`
  (`state.chats` stays the unfiltered source). The People/Bots split reads
  contact bot flags from a LAZY `state.contactBots` map — one `getContacts`
  call fetched the first time a People/Bots chip is used, never at boot
  (#46 budget); unknown contacts count as people. Active chip persists in
  `localStorage["velta-chat-category"]`; `syncChatCategoryBar` hides the bar
  for every side view. Category VISIBILITY is user-configurable (#75):
  drawer → "Chat categories" (same details-checkboxes pattern as Bottom bar
  buttons) stores disabled cats in `localStorage["velta-cats-hidden"]`;
  "all" is always on, hidden cats drop their chips (`b.hidden`),
  a persisted active cat that gets disabled falls back to "all"
  (self-healing guard inside `syncChatCategoryBar`), and the swipe walks
  visible chips only (`!b.hidden` filter). Mobile-only swipe (left/right = next/previous chip)
  attaches only under `matchMedia("(pointer: coarse)")`, is axis-locked
  (48px + 1.4× horizontal dominance), swallows the gesture's follow-up click
  and no-ops past either end. KEEP: the bar code must live INSIDE the
  app.js slice that contains `renderChatList` — `tests/app-account-isolation`
  runs app.js as slices between marker comments, and module-level code in
  the relay-pull region (~line 620) is invisible to the harness. Pinned by
  `tests/categories-bar.test.mjs`.
- `app/js/chat-view.js` owns the conversation history (virtualized via
  virtual-scroller), composer, selection mode and the delete dialog, plus the pinned-message tray under the chat head (`_refreshPinnedBar`, fed by `pinned-changed` events AND — #69 — debounced re-checks on `msgs-changed`/`msgs-deleted`: the core's tombstone REPLACE clears a pin WITHOUT a `MessageUnpinned` event, and core `MsgDeleted` (explicit/remote/ephemeral deletions) maps to `msgs-deleted`+`msgs-changed` in rpc-core — unmapped, remote deletions never reached the UI at all). Composer send keys (1.4.52, #56): Enter sends while the `velta-send-enter` drawer setting is on (default); with it OFF, Ctrl/Cmd+Enter sends instead and plain Enter inserts a newline; Shift+Enter is always a newline and IME composition never sends. KEEP:
  rows must NOT get `content-visibility` (the scroller measures mounted rows
  itself; collapsing desyncs its height cache — scroll jumps on remount);
  day chips render inside the first message row of each day (`dayFirst`) —
  separator items broke the scroller's prepend diff; `_loadOlder` prepends
  stay pure message prefixes. Bubbles use `contain: layout style` (not
  paint — the reply pill overflows). Media blocks (.msg-image/.msg-video/
  .msg-audio) deliberately bleed −5px left/right past the bubble padding (edge-to-edge
  official-client look); it works only because the bubble has no paint
  containment — keep bubble padding (7px 10px 6px) and the −5px bleed in sync.
  Media box geometry is WIDTH-first (#27): `width:min(naturalpx, 480px,
  calc(min(cap, 45vh) × W/H))` + `aspect-ratio` — px terms ONLY, never a %
  inside min(): percentages inside the shrink-to-fit bubble participate in
  intrinsic sizing and collapse the box in Safari/WebKit (the macOS sliver
  bug; the probe showed Chromium collapsing too when the meta line doesn't
  rescue the bubble width). `max-width:100%` handles the narrow-bubble
  clamp; the reserve box equals the decoded box, so the decode never jumps.
  `.chat-item` cards use full
  `contain: layout paint style`. The rendered-row LRU (`_rowCache`) survives
  `close()`; `open()` clears it when the account changed.
- **Read tracking** (1.4.40, PR #17): opening a chat no longer marks it read.
  `open()` lands at the manual read marker (while unread remain), else the
  core's `get_first_unread_message_of_chat`, else the bottom — loading a
  window via `getMessages({aroundId})`; a window short of the tail sets
  `hasNewer` and pages down (`_loadNewer`), while `onIncoming`/
  `onMsgsChanged` skip appends and `appendOutgoing` jumps to the tail.
  KEEP (#43): the `msgs-changed` listener passes `fresh` only for an
  unknown scope (`chatId === 0` — live ticks, scope-less local-chat
  events); a known chat's event refetches the tail from the id cache the
  core layer already invalidated, never forcing a full id-list reload.
  Messages become seen only once on screen: `_checkSeen` takes the lowest
  visible row as a watermark and batches `markSeen` (core
  `markseen_msgs` for exactly those ids). KEEP: no seen-marking while
  `_settling` (open/jump positioning) or `document.hidden`; rows in the
  pending batch are flushed on `close()` only while the session is still
  current (never into another account); go-down = catch up (`markRead`).
  `markRead` is one `marknoticed_chat` call (#47) — core marks every fresh
  message noticed, clearing the badge without shipping the chat's id list
  (receipts for rows shown still go out via the per-visible-row `markSeen`). The "Unread messages" line and the marker ride inside
  their rows (`unreadFirst`/`readMarker` item flags, like `dayFirst`), and
  `_renderItem` rejects cached rows whose `_veltaFlags` differ. Local
  (P2P) chats keep open = read. The message menu does not set or clear
  markers (#38). A stored marker still wins at open, and the line's X still
  calls `clearReadMarker`. Pinned by `tests/read-tracking.test.mjs`.
- **Remembered scroll position** (issue #18, drawer setting "Remember
  scroll position in chats", localStorage `velta-remember-scroll`,
  default ON since #70 — unset or "1" = on, "0" = off): `close()` saves
  `{anchorId, dy}` (topmost visible row + its
  viewport offset) in the in-memory `_scrollAnchors` map, keyed like drafts
  by (account, chat), only when the chat is fully read AND the user
  genuinely scrolled off the bottom (`_userAway`: a scroll outside
  `_settling` within 1.5 s of wheel/touch/key/scrollbar input — settles and
  programmatic seeks never count); anything else deletes the chat's anchor.
  `open()` priority: marker > first unread > saved anchor > bottom; unread
  messages retire the anchor, a deleted anchor falls back to the tail, and
  the restore is a `getMessages({aroundId})` window + `_restoreScrollSettling`
  (relative dy correction on the settle timer). Tracked chats only. Setting
  off = old behaviour. Shared landing fix (both modes): the scroll handler
  holds `_loadOlder` while `_settling` (close() leaves scrollTop 0, and the
  prepend under the pin made reopen landings non-deterministic — the settle
  end pages instead), and the bottom settle's final re-assert is instant,
  not smooth. Pinned by `tests/scroll-restore.test.mjs`.
- **Saved copies jump back to the original message** (issue #19): core
  `originalMsgId` is mapped in `rpc-core.js`. A copy in Saved Messages gets
  a round chevron (`data-act="show-original"`, title “Show in chat”) hanging
  off the bubble. `_showOriginal` loads that message and either jumps inside
  the open chat or `onOpenChat`s the source chat and then jumps. Notes typed
  in Saved Messages have no `originalMsgId` and no button. Pinned by
  `tests/chat-msg-update-hardening.test.mjs`.
- **Read-only chats hide every reply affordance** (1.4.26): device chats and
  channels the member cannot post in get no hover-reply pill, no
  context-menu/selection Reply, no selection-quote chip — `app.js` derives
  `chatView.readOnly` from the chat kind plus the core's `can_send` check
  (the same check that hides the composer), ChatView applies a
  `chat-read-only` body class for DOM-rendered buttons and guards
  `_setReply`/`_setReplyFragment` as the backstop. Never gate these on
  `chat.kind === "channel"` alone — the rights check is the source of truth. The hidden composer also removes the
  bottom breathing room; restored by `body.chat-read-only .history-scroll` padding
  (NOT on `.history` itself — the virtual scroller inline-writes its own
  padding-bottom there every layout pass and would clobber the rule).
- **Attachments carry the pending reply** (1.4.26): `_takeQuote()` is the
  single consumer of the pending reply (`replyTo`/`replyFragment`) — full
  replies ride the core's `quotedMessageId`, fragment replies become
  `"> "` quote lines prefixed to the text/caption — and `_send`,
  `_sendPendingMedia` and `_sendAttachment`'s file/video paths all use it.
  Adding a new send path MUST call `_takeQuote()` too, or replies get
  silently dropped (the image path did, pre-1.4.26).
- **Pending attachment strip** (post-1.4.31, #5): no send-preview modal.
  Picked/pasted media shows in `#media-preview` (strip above the composer,
  official-client pattern); the caption IS the composer input, focused on
  attach; Send sends media+caption via `_sendPendingMedia`, X clears.
  Videos preview from `fileUrl` (bytes never enter RAM); images read into
  a Blob (paste/crop need it). `_setPendingMedia(kind, src, corePath,
  name)` — src is a Blob (object URL owned by us) or a URL string.
  Desktop picker files are COPIED into the accounts `uploads/` dir at
  pick time (`resolveAttachmentPath` — same as Android content-URIs):
  shell media commands scope paths to AppLocalData, and out-of-tree
  picked files broke the poster/send reads. Media does NOT ride drafts —
  `close()` drops it (official client does the same).
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
  which previously left the timer alive (menu opened mid-swipe). Any
  `touchmove` still cancels the timer.
- **Mobile swipes (#35)** — only when `(max-width: 820px)` and the pointer
  is not `(hover: hover) and (pointer: fine)`. Swipe right on a `.bubble`
  translates it up to 64px and, past 48px, calls `_setReply` (skipped when
  read-only, selecting, or in text-selection). Swipe left on `#history-scroll`
  translates `#main` with the finger; past 72px (or 28% of the width) it
  calls `onBack` (`closeChat`). `.swipe-back` on `.app` shows the sidebar
  while `.chat-open` would keep it `visibility: hidden`. A vertical move
  wins and stays a scroll. Reply-right and back-left do not run together
  (`_replySwipe` / `_backSwipe`). `close()` cancels a back drag so the
  column is not left translated. A committed swipe parks `#main` at
  `translateX(100%)` with no transition before `.chat-open` drops, then
  clears that inline transform on the next frame — otherwise the .22s
  close slide runs from `-100%` to `100%` across the list. Pinned by
  `tests/chat-msg-update-hardening.test.mjs`. Detail:
  docs/agents/android-shell.md.
- **Select text (#36)** — bubble text stays unselectable on touch (long-press
  belongs to the context menu; a native word selection used to steal half
  the gesture). **Select text** is on the touch message menu only
  (`_offerSelectText` hides it when `(hover: hover) and (pointer: fine)`
  matches). It calls
  `_enterBubbleTextSelection`: `.text-selecting` on that bubble's `.msg-text`,
  select-all so the native handles can shrink the span, and a
  `.msg-select-bar` (Reply, Copy, Close) inserted at the top of `.bubble`.
  Reply quotes the current span via `_setReplyFragment` (the existing `"> "`
  fragment, no core change; omitted when `readOnly`). Copy writes that span,
  not the whole message. Close, or a pointerdown outside the text and the
  bar, leaves the mode and notifies the virtual scroller — the bar changes
  row height. `_leaveTextSelection` calls `removeAllRanges` WHILE
  `.text-selecting` is still on, then sets `user-select: none` and clears
  again. Removing the class first leaves Android's selection handles on
  screen. Close does not `preventDefault` its pointerdown; Reply and Copy
  do, and they snapshot the span first. While the mode is open, long-press
  and `contextmenu` do not open the bubble menu (`_msgContextMenu` returns;
  the long-press timer is not armed). The floating `#sel-quote-chip` stays
  hidden so there is one Reply. Desktop mouse selection is unchanged and
  still uses the chip. The desktop menu does not offer Select text.
  Multi-touch still cancels the long-press timer (the guard above); it does
  not enter selection.
- **Send/receive ticks** (1.4.20, semantics updated post-1.4.36): the tick
  icons follow the core's MessageState — `OutPending` renders the spinning
  ring, `OutDelivered` (the RELAY accepted the message) renders the SINGLE
  stroke check (`TICK1`), `OutMdnRcvd` (the recipient's client confirmed
  seen) the double-check (`TICK2`, Delta Chat desktop's fill-based SVG in a
  3:2 viewBox; `.ci-last .ci-ticks` is retuned to 17×12 for the aspect), and
  `OutFailed` a bold red exclamation (squash-tolerant in the tick box — a
  circled icon would render as an ellipse there; the bubble additionally
  carries the reason badge + retry/remove). Chatmail is store-and-forward:
  pipeline visibility ENDS at the own relay's acceptance — "seen" comes only
  from the recipient's MDN. Never promise per-recipient-relay delivery; the
  message-info sheet phrases the pipeline in those terms
  (chat-view `_showInfo`). The selection checkbox (`ICO.check`) is separate.
  KEEP (read-receipt lifecycle, verified live 2026-10-02 against real
  accounts — full narrative in `docs/agents/read-receipts.md`): the ONLY
  MDN trigger is the peer's client running `markseen_msgs`, and Velta fires
  that only from the open-chat watermark — notification direct-replies and
  replies typed without an on-screen chat NEVER produce an MDN, so the
  sender's tick legitimately stays single. Both sides must open each other's
  chat; the flip then lands in ~20 s (relay round-trip). Self-talk/Saved
  messages never reach `OutMdnRcvd` (markseen ignores own messages). The
  CHAT-LIST row tick is `summaryStatus` of the LAST message only — older
  read messages in the chat never light the row up, and a single tick on the
  newest message is correct until the peer reads exactly that one. When a
  user reports "stuck ticks", check the raw core state first
  (`get_message`), then the PEER side (`state 10`/InFresh = never viewed).
- **Bot chip (post-1.4.36)** — incoming messages whose sender contact carries
  the core's `isBot` (`fromContact.bot`, mapped by rpc-core and the mock)
  render a small bordered "bot" tag in the meta row beside the timestamp.
  The desktop hover-reply pill sticks along the bubble's right edge for the
  whole bubble (issue #26), so the chip stays in the meta row.
  Sticker bubbles carry no meta row and go unmarked.
- **Context-menu Resend (post-1.4.36)** — own messages (non-P2P) offer
  Resend: core `resend_messages` flips the message back to OutPending and
  retransmits (recipients get a duplicate); the core rejects info/drafts/
  pending with an error, which toasts. `rpc-core.resendMessage` re-tracks
  the id in `_sendingIds` so the relay line spins during the re-send.
  P2P local chats keep their own retry paths (`_lcRetryTransfer`,
  the proxy's resendMessage).
- **Viewtype mapping is load-bearing** (rpc-core `_mapViewtype`): the
  renderer branches on the mapped string ("image", "sticker", …), so a
  collapse like `case "Sticker": return "image"` silently dead-branches the
  whole sticker UI (it did — stickers rendered as bubble-wrapped photos,
  fixed 1.4.20+). Same class of bug in `_mapChatListItem`'s summary emoji:
  Video was grouped under the File 📎 icon until split out (🎬). Audit mappings against `MessageViewtype` /
  `MessageState` in `core/deltachat-jsonrpc/src/api/types/message.rs` when
  touching them. Sticker rows: `bubble.sticker` drops the chrome
  (transparent bg must out-specificity `.msg-row.out .bubble` AND the
  brutal override — two rules); wrap bg `none` so transparent
  PNGs don't sit on the shimmer (cap + object-fit rules live in the
  Stickers bullet below).
- **Stickers** (1.4.20+): picker = ui.js `showStickerPicker` fed by core
  `misc_get_stickers` (rpc-core `getStickers`); received stickers are added
  by TAPPING the sticker in the chat (official-client behavior) — a
  confirm asks "Add this sticker to your sticker collection?" then rides
  `misc_save_sticker` — and the context menu's "Save sticker" remains as
  the direct path; sending rides `sendMessage {viewtype:"sticker", file}`.
  Collections are LOCAL per-account folders
  (`<account>/stickers/<collection>/`, core `misc_save_sticker` just
  copies the blob) — no device sync; they move only via backup/restore.
  Render rules: `bubble.sticker` drops the chrome (transparent bg must
  out-specificity `.msg-row.out .bubble` AND the brutal override — two
  rules); 175px cap (matches official Android DC's
  `media_bubble_sticker_dimens` 175dp square) — BOTH in the reserved box AND
  the decode `reveal()` (the photo's 450px cap made stickers render big and
  jump); sticker images are `object-fit: contain` (photo img uses `cover` to
  fill the reserved box — cover CROPS transparent PNGs). Sticker bubbles load
  the ORIGINAL file (no 720px thumbnail): animated stickers play in-chat like
  official Android, and stickers are small enough that the static-JPEG
  thumbnail buys nothing. Tap behavior: received sticker = add-to-collection
  prompt THEN lightbox; own sticker = lightbox UNCONDITIONALLY (no
  naturalWidth gate — the static thumbnail may still be decoding when tapped,
  which silently killed taps on Android). Composer trigger is
  `#btn-sticker` INSIDE `.composer-input-wrap` (right edge) — icon is the
  hand-drawn square-with-fold smiley (e888008; an svgrepo circle variant
  was tried and rejected by the user). P2P chats: no save/picker
  interplay. MockCore ships `mock:<emoji>` tile paths the picker renders
  as text — never feed those to fileUrl.
- **JSON-RPC `MessageData` casing (post-1.4.31, silent-kill class)**: the
  deployed sidecar binary deserializes `send_msg`'s MessageData in
  SNAKE_CASE (`viewtype`, `quoted_message_id`) while the vendored 2.61
  source carries `rename_all = "camelCase"` — serde IGNORES unknown
  fields, so camelCase forms vanish without an error: a sticker sent as
  `viewType: "Sticker"` became `None`+file → `Viewtype::File` → Image at
  prepare ("stickers send as images"; proven by probe: snakeCase and the
  deprecated `send_sticker` keep Sticker). rpc-core `sendMessage` now
  sends BOTH casings (`viewType`+`viewtype`, `quotedMessageId`+
  `quoted_message_id`) — each build reads its own, the other is ignored;
  works on either core. On the next core rebuild, re-probe with
  `send_msg` `{viewType:"Sticker"}` + `{viewtype:"Sticker"}` on a real
  binary and delete the snake twins if camelCase wins (probe script:
  temp `sticker-probe.mjs` pattern — real rpc-server, throwaway account
  on `d13.buro.dev`, `send_msg`/`send_sticker` to a probe group chat).
- `app/js/components.js` defines the Elena custom elements
  (`<velta-avatar>`, `<velta-chat-item>`, `<velta-chat-head>`,
  `<velta-video>`). KEEP: the chat-head subtitle (`cht-status`, `statusLine()`) renders
  `bot` for bot contacts and `online` / `last seen X ago` for users — the
  contact is the real source; chat-list rows never hydrate contacts (one RPC
  per row); presence maps core `lastSeen: 0` to `null` = unknown (no
  subtitle, no "last seen just now" — never a `Date.now()` fallback, fixed
  1.4.5). There is no verified rosette any more: core 2.61.0 stopped
  tracking contact verification.
- `app/js/avatar.js` — fingerprint color-matrix identity tiles, delivered
  as percent-encoded SVG data-URL CSS backgrounds (`avatarBackgroundUrl`,
  cached per fingerprint — zero child nodes); group avatars stay solid
  color; a contact's photo rides inside the matrix tile; photo avatars
  shimmer via the img's own background until `load` (`.loaded` removes it —
  Elena does not reliably call `updated()` on first render, so bind from
  `updated()` AND once via rAF from `connectedCallback`). The fingerprint
  itself is fetched once per `(accountId, contactId)` via `setFingerprintSource`
  (wired by app.js with `core.accountId`) and kept across account switches —
  contact ids are per-account, hence the composite key; entries never expire.
- **Profile sheet (`showChatInfo`) hydration contract**: the full contact
  (real avatar, bot flag, presence) is fetched whenever `chat.contact` is
  absent — group-opened profiles (`openContactProfile`) therefore pass NO
  partial contact stub, or hydration is blocked and the sheet keeps matrix
  initials with stale rows. Relay rows: 1:1 contact profiles show the
  contact's relay from their address (no per-contact relay list upstream);
  the self profile shows the account transports — one row, or a collapsed
  `Relays (n)` details list for several. GROUP/CHANNEL sheets show no relay
  rows at all: the account transports are identical on every group and
  relay management is account-scoped (the drawer's "Relays of this
  profile…" is the single entry point) — do not resurrect them there.
  "Chats in common" and the group member list live in the same
  collapsed-details pattern with a (n) count (members collapsed by
  default since 1.4.41). Member rows carry the member's RELAY DOMAIN as
  the subtitle with the full address in the tooltip (#72).
- **Theming contract**: `THEME_LABELS` (ui.js) drives the picker;
  `applyTheme` (app.js) sets `html[data-theme]` + the theme-color meta.
  Themes: auto (system), dark, light, brutal (1.4.6 — explicit only, never
  matched by Auto). A theme is a token block in main.css plus component
  overrides appended AFTER the base rules (brutal re-overrides the 1.4.3
  quote palettes — keep it last). Every new theme value lands in
  `THEME_LABELS` and the theme-color map together.
- **List action bar + side views** (`.list-bar`, 1.4.7+): buttons switch
  what `#chat-list` shows via `setListView` over {chats, contacts, calls,
  qr, search, new, archived}; `renderChatList` early-returns unless the view
  is "chats" (keep that gate — refresh storms clobber the other views).
  `archived` (issue #13, post-1.4.37) is the header box button next to the
  search button — hidden while `archivedCount` is 0 (piggybacked onto
  refreshChatList via `getChatList({ archived: true })`, list flag 0x01 =
  DC_GCL_ARCHIVED_ONLY — NOT 0x02, which is DC_GCL_NO_SPECIALS and
  silently returns the unarchived list, hiding every archived chat), and
  writing from an archived chat unarchives it
  (every chat-view send routes through `_sendArchivedAware`).
  Contacts come from `core.getContacts` through a virtual scroller
  (`sideScroller`, stopped by `stopSideScroller` on every view switch);
  Calls read the LOCAL call log (localStorage `velta-call-log`, capped 30 —
  the core has no call-log API); QR renders `inviteQrProvider(null)`. The
  header search button and `#btn-new-chat` are view toggles
  (`syncHeaderButtons()` from `setListView` — keep that call). Button
  visibility is user-configurable (drawer → Bottom bar buttons, localStorage
  `velta-bar-hidden`); `applyBarVisibility` adds `.bar-bare` when all four
  view buttons are hidden; Menu and `#btn-new-chat` are always visible. KEEP:
  boot lands on the chats view WITHOUT going through `setListView`, so the
  initial `.bar-btn.active` is painted directly in the bind-ui slice — don't
  rely on `setListView` to mark it.
  The old `.fab`/`.sidebar-foot` and the sidebar-head Menu button are gone —
  do not resurrect them.
- **Drawer contract** (ui.js `buildDrawer`): no close button, no offset
  shadow (slides over the sidebar's own edge; a right border separates).
  Stops above the list bar (`inset` bottom = `var(--list-bar-h)`).
  open()/close() dispatch a `velta-drawer` document event (the bar Menu
  button listens to flip hamburger↔cross and to close instead of re-open).
  Width `clamp(300px, 33vw, 420px)`, full width on mobile. While open, a
  capture-phase document `pointerdown` listener closes it on outside taps;
  the transparent overlay swallows the click. Toggle-spoiler pattern
  (`<details class="drawer-details">` + `.scale-opts` checkboxes): Bottom bar
  buttons (`data-bar-key`), Chat categories (#75, `data-cat-key`),
  Notifications (`data-notify-key`: master `velta-notify` + message-text
  `velta-notify-text`, both default on, "0" = off) and Image quality
  (`data-mq-value` radios, `velta-media-quality` "0"=Standard/"1"=Compact,
  mirrored to the core's per-account `media_quality` config — pushed from
  `rebuildDrawer` on boot/account switch; core `set_config` takes FLAT args
  `[accountId, key, value]`, NOT a nested [key,value] pair) follow it —
  add new toggles as args to `buildDrawer` + a change handler, never
  as one-off DOM queries outside ui.js. Notification gates are DESKTOP-ONLY:
  on Android the Rust background poller posts notifications while the page
  is frozen and cannot run the localStorage gate (known gap).
- **Header heights** are pinned by `--head-h` (56px): `.sidebar-head` and
  `.chat-head` are border-box
  `height: calc(var(--head-h) + env(safe-area-inset-top))`. Change the var,
  not the paddings.
- **History loading strip** (`#chat-load-bar`): 6px blue gradient sweep
  pinned under the chat header; turned on by `chat-view.open()`,
  `_loadOlder()`, `_loadNewer()` and `_jumpToLatest()` (paging is history
  loading too); `_loadBar()` holds a
  150 ms minimum on-time and a new on cancels a pending off; sits at
  `top: calc(var(--head-h) + env(safe-area-inset-top))`.
  ALSO driven by core connectivity: `refreshRelayStatusInner` (app.js)
  turns it on while `get_connectivity()` is WORKING (3000–3999) — the
  desktop client's "Updating…" (IMAP fetch or SMTP send; the core can't
  distinguish). It rides the relay-status coalescing (1.5 s gap guard —
  get_connectivity RPCs re-trigger ConnectivityChanged, an unguarded
  handler fed an event storm); piggyback there instead of adding
  listeners.
- **Failed sends** (post-1.4.31): red reason badge below the message
  content (`failReason()` parses the core error — LAST `Error: ` segment
  wins: "…5.3.4 Error: message file too big" → "Message file too big";
  a greedy `Error: (.+)$` regex grabs the WHOLE line, use `lastIndexOf`)
  + retry/remove buttons left of the bubble (`_syncFail` mirrors the
  template for live `MsgFailed` transitions; `m.error` rides
  `_rowSignature` so the refetch upgrades "Not sent" to the real text).
  Remove deletes FOR EVERYONE (`forAll: true`) — `state === "failed"`
  does NOT guarantee non-delivery (an oversized send can still reach the
  recipient), a local-only delete left the message alive on the other
  client. rpc-core `_mapMessage` carries `error: m.error || null`.
- **Times are 24-hour**: `formatTime` (format.js) forces `hour12: false`
  and is the single timestamp source for chat rows, list rows and call
  lists — don't reintroduce locale defaults (rendered `03:21 AM` on en-US).
- All `:hover` styling lives inside
  `@media (hover: hover) and (pointer: fine)` — touch devices report
  `hover: none` and hover states stick after taps. `:active` press feedback
  and non-hover states (`.relay-detail.pull-open`) stay reachable on touch.
- `app/js/diagnostics.js` is the in-app diagnostics store ("Velta
   Diagnostics" chat): console-style rows (shared `diagnosticRow()` helper),
   identical consecutive entries collapsed into one counted row, ring-capped
   at 120 rows (worst case ≈600 DOM nodes with the copy buttons; the DOM
   budget watchdog's report names the last row texts when the chat itself is
   the growth) — prefer
   appending here over toasting for repeatable background errors. The bar
   under the chat carries a pause/play button (freezes the live rendering;
   the store keeps recording, resuming re-renders to catch up), the recovery
   group "Restart: Core | UI" (`btn-restart-core` / `btn-reconnect-ui`, the
   only callers of `restartIo`/`reconnect` from the UI) and two switches:
   **Logging**
   (runtime gate on the shell log writer, `set_logging_enabled` /
   `LOG_ENABLED` in lib.rs; persisted in localStorage `velta-logging`,
   default OFF on both sides — V-09/#66: the log mirrors message content
   outside the account db, and the renderer pushes the persisted choice at
   boot so the shell never logs before that unless the user opted in — the
   Diagnostics chat itself keeps working when off, it never passes through
   `log()`) and **DevTools** (`set_devtools`: desktop opens/closes the
   WebView inspector, Android flips `WebView.setWebContentsDebuggingEnabled`
   via JNI for chrome://inspect; persisted in `velta-devtools`, applied at
   boot).
- `app/js/media.js` resolves local paths to WebView-safe media URLs:
  blobfile probe → loopback HTTP → asset protocol, with one-shot error
  fallbacks per element. Details and the WebView2 media quirk:
  docs/agents/media.md. `fileUrl(path, {thumb: true})` appends `?w=720` —
  BOTH the blobfile protocol and the loopback server answer with a cached
  720px JPEG thumbnail (sha1(path+mtime+size+w) key under
  `<app-data>/thumbs`, generated in lib.rs via the `image` crate, EXIF
  orientation applied); animated gif/webp, non-static formats, Range
  requests and every failure fall through to the original bytes, so the UI
  can never regress. Bubble images pass thumb:true; the lightbox never does.
- `app/js/link-preview.js` — OG preview card for the first link in a text
  message. Fetches shell-side (`fetch_link_preview`, lib.rs — same trust
  model as `expand_invite_link`: https-only, 5 s timeout, 256 KB page /
  512 KB image cap) and inlines og:image as a `data:` URL (CSP img-src has
  `data:` everywhere; remote hosts stay out). In-memory cache per URL;
  failed fetches cached as null. Never fetched: a registered invite URL
  (already an invite card) and any `deltachat.id` URL (short username
  links are invite cards; the rest of that host is the same service).
  Setting: drawer → “Link previews”
  (localStorage `velta-link-preview`, “1” = on, default off; the old “0”
  stays off. Turning previews on, globally or for one chat, confirms
  `LINK_PREVIEW_IP_WARNING` first — the fetch reveals this device’s IP,
  and someone in a private or group chat may own the site or be able to
  edit the page (issue #30). KEEP: the card slot is
  rendered empty (`data-lp`) and hydrates async — the hydration MUST call
  `notifyHeight()` after unhiding or the virtual scroller’s layout math
  goes stale (same contract as image decode). Cards never render in demo
  mode (no Tauri shell → no fetch command). Per-chat override: chat context
  menu → “Link previews: on/off” (localStorage `velta-link-preview-chats`,
  `{chatId: “on”|“off”}`, wins over the global drawer value). KEEP: bubble
  anchors (markdown links AND card links) are handled by the DELEGATED
  branch in the row click handler (`e.target.closest(`a[href]`)`) — the
  card's <a> is inserted async after row build, so per-anchor wiring
  never sees it. Desktop opens links via `openExternal()` =
  `plugin:opener|open_url` (system browser); Android keeps the in-app
  browser chain (see §5.5).
- **Native video frames replace posters (post-1.4.31)** — `poster.js` and
  the click-to-load `#active` state are GONE. `velta-video` renders a real
  `<video preload="metadata" src="...#t=0.1">` (no `controls` — Android WebView
  stacks its own large centered play button on controls videos; controls
  return only in the no-lightbox fallback via `v.controls = !videoLightboxOpener`): Chromium/WebView2
  paints frame 0 natively (the `#t` fragment forces the first-frame fetch),
  `loadedmetadata` shapes the host box to the true aspect (portrait
  videos must NOT hit the stale 200px min-width inside a styled box — it
  inflated the element past the clipped host and put the play button
  below center), `play`/`pause` toggle a centered `.velta-video-play`
  affordance, and taps route to the fullscreen lightbox
  (`setVideoLightboxOpener` — components.js must not import ui.js, cycle).
  The media-fallback chain (blobfile → media server, once) and the fail
  band stay. KEEP: heights must stay DEFINITE down the chain
  (`.msg-video[style]` → `velta-video` → `.velta-video-card` → `video`
  all `height: 100%`) or percentage resolution collapses to auto and the
  row height destabilizes (virtual-scroller unsafe).
  - Path resolution (still load-bearing): the core returns blob paths
  RELATIVE to the accounts root; `scoped_accounts_path` joins onto the
  AppLocalData root (accounts/ AND uploads/ are both under it), strips
  the `\\?\` canonical prefix before returning paths — convertFileSrc
  percent-encodes the prefix into asset.localhost URLs that 404.
  - The Rust commands `poster_cache_path`/`read_media_bytes`/`write_poster`
  are frontend-dead but still registered — remove in a lib.rs cleanup
  pass (verify the Android service doesn't call them first).
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

- **HTML mail/attachment viewer** (`_openHtmlOverlay`, chat-view.js;
  1.4.40 link fix): a sandboxed (`allow-scripts`, no `allow-same-origin`)
  srcdoc iframe — a plain link click would navigate the FRAME ITSELF and
  `target=_blank` dies in the sandbox/wry, so the overlay injects a
  capture-phase interceptor (`HTML_VIEW_LINK_JS`) that preventDefaults
  anchor clicks and postMessages the href to the parent, which routes it
  EXACTLY like chat bubble links (Android in-app browser chain / desktop
  opener plugin). The snippet's bytes are hash-whitelisted in `script-src`
  (§8) — the parent cannot reach into the opaque frame any other way.

- **Chat info actions** (1.4.41): the group/channel/1:1 sheet carries, in
  eligibility order — Edit group/channel (channels: only when the core's
  `can_send` grants it, the same rights source as the composer; groups
  keep it for every member), Add members (groups; shared multi-select
  `pickContactModal` → `addChatMembers` → `add_contact_to_chat`),
  Invite via link/QR (groups + channels; `showInvite(inviteQrProvider(
  chat.id))`), a Notifications row opening the timed mute dialog
  (`setChatMuted`: `{kind: "NotMuted"}` / `{kind: "Forever"}` /
  `{kind: "Until", duration: seconds}` — MuteDuration is an internally
  tagged enum on the wire (`#[serde(tag = "kind")]`); bare strings fail
  deserialization SILENTLY, which is exactly what broke the ⋮ menu's Mute
  (`setChatFlags({muted})`) until 1.4.51 — wire-shape regression tests in
  `tests/mute-wire-shape.test.mjs`), and a
  Disappearing messages row (`get/set_chat_ephemeral_timer`, seconds,
  official option list). Editors opened FROM the sheet replace its modal
  history entry, so every close path must `await modalHistorySettled()`
  and reopen the sheet — skipping that tears the sheet down with the
  dialog. The ⋮ chat menu carries Leave group/channel
  (`leaveGroup` → core `leave_group`) behind a danger confirmation; the
  left chat turns read-only in place (composer hidden, history stays).

- **Post-1.4.34 UI surface** — settings are checkbox rows in the drawer
  (`data-toggle` labels + change handlers in ui.js; Demo mode is the renamed
  mock toggle; Send on Enter is `velta-send-enter`, "0" = off, read by the
  composer keydown, which also guards `isComposing`; Remember scroll
  position in chats is `velta-remember-scroll`, "0" = off, default on
  (#70) — see
  "Remembered scroll position"). Profile flows live in
  one tabbed modal: `openProfileManagement()` (app.js) — Add profile (relay
  input + QR scan → `addAccountFromInvite`), Second device (provide-QR pane +
  receive hand-off), Export backup (`exportBackup` + `imex-progress`;
  desktop folder picker, fixed `exports/` dir on Android). Tabs lock
  (`.pm-tabs.locked`) while a flow runs. Modals are full-screen below 600px
  viewport (`.modal-compact` opts out — confirmations use it); on desktop
  they fill the chat-list pane (width mirrors .sidebar via clamp, height
  stops above the list bar; in-chat modals stay full-screen via
  `:has(.app.chat-open)` gating — phones stop above the bottom bar in list
  context). Modals ride a `{velta:'modal'}` history entry — Android BACK
  closes the top modal (lightbox pattern; replacement reuses the entry,
  `modalReplacing` guard). Toasts are `<details class=toast>` bars anchored
  above the composer/bottom bar: 3px shrinking timer bar (danger red for
  errToast) whose animationend dismisses, one-line ellipsis,
  overflow-gated expand chip (re-measured after `document.fonts.ready`),
  copy button in the open pane, close X in the summary. Clicking pauses
  the dismissal timer — expandable toasts via the native open/close toggle,
  one-liners by toggling pause/resume directly (they used to vanish
  mid-read). On the desktop
  two-pane layout the bar spans the ACTIVE context column only — the list
  pane in list context, the chat area above the composer with a chat open
  (`body:has(.app.chat-open)`: `#toasts` sits outside `#app`, a descendant
  selector can never match); phones keep the full-width bar. Bubbles cap at `min(480px, 90%)` (avatar rows −50px). Jump targets
  outside the loaded window (search hits, quotes, pinned bar) fetch older
  pages via `_jumpFetchAndScroll` (page cap `jumpMaxPages`) then
  `_scrollToItemSeek` — the scroller has no scroll-to-item API (a window
  opened mid-history reloads the tail first). Arrivals in local (P2P)
  chats mark-read through `markReadSoon` (400ms coalescing, flushed on
  close); other chats mark seen on screen (§5.1 "Read tracking").
- **Profile/chat info editing (post-1.4.35, merged editor per issue #16)** —
  the sheet's action row (`data-pa`) is context-shaped: ONE editor button
  opens `showEditProfile` (name + avatar + description in a single modal).
  Self = Edit profile (delegates to the drawer's `editProfileFlow`, which
  also applies `setSelfStatus` for config `selfstatus`); groups/channels =
  the same modal (`contactId: 0, kind: "group"` → `renameChat` = core
  `set_chat_name`, `setChatImage` = core `set_chat_profile_image`, null
  image clears, `setChatDescription` = core 2.62 `set_chat_description`);
  empty string clears a description. 1:1 keeps Send / Edit name (the local
  custom name) / Block, and a contact's bio stays read-only. Descriptions
  are applied only when changed (group edits inform members core-side).
  MockCore mirrors all the methods —
  `tests/description-edit.test.mjs` pins the wrapper arguments and the mock
  roundtrips. KEEP: call `modalHistorySettled()` before reopening the sheet
  after an editor that closed ITSELF (`showEditProfile` does): its close
  schedules `history.back()` and the late popstate tears the reopened sheet
  down (the reopen reuses the dying `{velta:'modal'}` entry). Opening
  `showChatInfo` while a modal is still up is race-free (showModal →
  closeAllPopups replaces it and skips the history consume) — prefer that
  shape. The self branch must also refresh the sheet stub from
  `state.account` before reopening (it carries the name captured at open
  time). The 1:1 Edit-name flow still closes-then-reopens without settling —
  same latent race, so far tolerated.

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
KEEP also: the Proxy's relay-chat fall-throughs forward the FULL argument
list (`(t, id, ...rest)`) — an early version dropped `ids`/`{forAll}`, so
with local chat on every message deletion in normal chats failed with
serde `invalid type: null, expected a sequence` (fixed post-1.4.35).

### 5.5 In-app browser (Android)

Message links open without leaving the app: Custom Tab (the user's default
browser first, then any visible CustomTabsService provider) → native
second-WebView overlay → JS iframe fallback. The full chain, its JNI and
launch-context gotchas and the `<queries>` requirements are documented in
docs/agents/android-shell.md.

---

## 6. Development conventions

**Language policy: English only.** All agent output — visible replies,
thinking, code comments, commit messages, and docs — is English, matching the
project's working language. (User correction 2026-09-21 after mixed-language
replies; applies regardless of which tools or modes are active.)

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
- **No BOM when rewriting files on Windows.** PowerShell 5.1
  `Set-Content -Encoding UTF8` always writes a UTF-8 BOM, and tauri-build's
  JSON parser dies on it (`unable to parse JSON Tauri config file … expected
  value at line 1 column 1`) — it killed both release workflows of v1.4.24
  (Windows + Android) at the `velta-app` build-script step while every other
  tool (cargo, node, browsers) accepted the BOM silently. Rewrite files with
  `[IO.File]::WriteAllText($f, $text)` / `WriteAllBytes` (BOM-less UTF-8), or
  after any `Set-Content -Encoding UTF8` sweep, check and strip the
  `EF BB BF` leading bytes of every touched file before committing. Full
  incident: `docs/agents/release-ci.md`.

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
  On a fine pointer with hover, a custom photo (`.velta-avatar-photo`) in the
  chat header and the profile sheet grows to fill the tile, matching message
  rows (#39). Group/channel avatars are exempt (solid color + photo/initials).


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
             tests/chat-msg-update-hardening.test.mjs \
             tests/read-tracking.test.mjs \
             tests/scroll-restore.test.mjs \
             tests/chatlist-incremental.test.mjs \
             tests/categories-bar.test.mjs
```

These cover the account-isolation contract: stale account results (A→B→A),
entry-account-pinned RPCs, view lifetime across close/reopen, per-account
drafts, popup settlement, attachment flows (the image preview modal is
settled by clicking its Send button in the stub DOM), and the event
long-poll contract: expired `get_next_event_batch` requests stay registered so
their late responses are dispatched (never dropped) and dispatched exactly
once, with account attribution still enforced; a batch re-polls immediately
(no per-event pause, #25), `velta_core_events` notifications (Android
batches forwarded by the Rust poller) are dispatched the same way,
handlers run in arrival order and a stuck handler
holds the queue for at most `eventHandlerStallMs`. The hardening suite pins the
event-storm defenses: duplicate message updates take the changed path at
most once (no repeated `onItemHeightDidChange` for unmounted rows), row
signatures survive unmounted updates, and `msgs-changed` bursts collapse
into one tail refetch per gap. The chat list refreshes incrementally
(#25): `chatlist-changed` refetches the entry ids (plus items only for new
chats), `chatlist-item-changed{chatId}` refetches that one item, bursts
coalesce into one trailing refresh, the archived count uses ids only,
Diagnostics appends patch their row locally without chat-list RPCs, and
local chat (`velta-p2p`) or cores without `chatlistEvents` keep the full
refresh. Opening a chat costs one `getChat` (a single chatlist item, never
the whole list), handed to `chatView.open(chatId, chat)`. Row mounting is
windowed (#44): the first `CHAT_ITEM_FULL_ROWS` (40) rows are full
`<velta-chat-item>`s, the rest are fixed-height `.chat-item-ghost` divs
(66px — one real row) that an IntersectionObserver (600px rootMargin)
upgrades as they approach the viewport; ghosts are never downgraded, and
environments without IntersectionObserver (the headless harness) mount
everything as before. Item data for every row is always in `state.chats`
(one bulk RPC), so an upgrade is pure DOM work. Run them after touching `rpc-core.js`,
`app.js`, `chat-view.js` or `ui.js`.

Known-broken (pre-existing, re-checked 2026-09-26 on v1.4.38): the DOM
stubs now implement `addEventListener`, so the chat/app suites run, but
`app-account-isolation` fails cases 10–14 (late getChat completion/rejection,
account-listener refresh) and `chat-account-isolation` fails 17 (attachment
send retarget) and 23 (close cancels settling). Compare against master
before blaming a change; every other suite, `read-tracking` included, is
green.

Beyond that, the primary verification path is manual:

1. Open `app/index.html` in a browser. Force demo mode with
   `localStorage["velta-mock"] = "1"` (or the drawer's "Demo mode"
   checkbox) to verify UI behavior without a backend; the mock ships demo chats,
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
  - `script-src` (1.4.40 cycle) carries ONE inline-script hash: the HTML
    viewer's link interceptor (`HTML_VIEW_LINK_JS` in chat-view.js) injected
    into the sandboxed srcdoc frame. The hash whitelists those EXACT bytes —
    change the snippet and the three CSP copies in one commit. Mail's own
    inline/remote scripts stay blocked.
  - `frame-src https:` is LOAD-BEARING: the in-app browser overlay
    (`open_webview_browser` fallback in inapp-browser.js) loads remote URLs
    in a sandboxed iframe. V-06's fix (#64) is elsewhere: the HTML viewer's
    `onFrameLink` now verifies `e.source === frame.contentWindow`, so only
    the srcdoc mail frame can hand links to the open chain — do not replace
    that check with origin string matching (the srcdoc frame's origin is
    opaque/null).
  - `connect-src` is loopback-only again (1.4.16): the github hosts that the
    update banner briefly added were removed — the version check runs
    shell-side (`get_latest_version` ureq command in lib.rs), and shell HTTP
    is not CSP-bound, so the renderer has NO GitHub reach. Do not re-add
    github hosts for it: release downloads 302 to a randomized CDN URL, so
    CSP path pinning can never scope them (CSP paths are not a security
    boundary), and the cross-origin page fetch fails on CORS regardless
    (GitHub's CDN sends no ACAO headers — that is what silently killed the
    banner in 1.4.14/1.4.15). The `ws://127.0.0.1:20808` / `http://127.0.0.1:20809`
    entries stay (V-02 verdict, #62): they are the service-APK transports —
    20809 exists because Chrome blocks `ws://` to loopback from a
    secure-context page, so it cannot be dropped. Both endpoints are
    token-gated since #61; never re-widen connect-src beyond loopback
    without that same gating.
- **Webxdc sandbox is opaque-origin.** `webxdc-manager.js` deliberately omits
  `allow-same-origin` from the iframe sandbox: every mini-app document gets a
  unique opaque origin and can reach neither the host page nor other apps'
  data. The shim's postMessage bridge works unchanged (`webxdc_serve`
  answers with `Access-Control-Allow-Origin: *`), and `webxdc-shim.js`
  shadows `localStorage`/`sessionStorage` with an in-memory store because
  real storage throws in opaque origins. Do not re-add `allow-same-origin`
  — all webxdc apps share the `webxdc.localhost` origin, so same-origin
  would let a malicious app read every other app's blobs.
- **webxdc blob serving is instance-gated** (V-05/#63): `webxdc_serve`
  refuses any non-icon blob whose `<account>/<msg>` prefix differs from the
  instance registered via the `webxdc_begin` command — the manager calls it
  right before setting the iframe `src` (never rely on an index request to
  set the open instance; that is the request an attacker could forge).
  ACAO `*` stays because opaque-origin frames need it for fetch(); the gate
  is what keeps cross-instance reads dead. Only `icon.*` files are exempt
  (chat-list cards load them for apps that are NOT open; icons are public
  to every chat member anyway).
- **Webxdc responses carry their own CSP** (`WEBXDC_CSP`, webxdc_serve.rs):
  the app CSP does not apply to custom-protocol responses, so without it
  mini-apps had unrestricted network access. KEEP it on every webxdc
  response; no remote hosts, webxdc origins + `data:`/`blob:` only. Do NOT
  add `webrtc 'block'` (Delta Chat desktop ships it): Chromium logs
  "Unrecognized Content-Security-Policy directive" for every webxdc app and
  ignores the directive anyway — WebRTC is instead disabled in the injected
  shim (RTCPeerConnection stubbed before app scripts run, webxdc-shim.js).
- **Blob/media servers answer only the app's own origin** (`media_cors`,
  lib.rs): no `Access-Control-Allow-Origin: *`; requests with a foreign
  Origin — including `null` from sandboxed frames (webxdc, HTML viewer) —
  are refused. The loopback media token is 128 bits from `OsRng`.
- **Peer-supplied ids never reach a path unchecked** — local-chat transfer
  ids go through `is_safe_transfer_id` (p2p.rs) before `partial-{id}`.
- **Message-derived strings are always escaped** before `innerHTML`,
  including reactions (the core accepts any short token as a reaction).
- **Deep links ask before doing damage** (1.4.28): a `dcbackup:` link (any
  web page or app can open one) confirms with the user before importing and
  switching to a profile — `handleDeeplinkFromUrl` shows a `confirmModal`
  and pins the account epoch across it. KEEP that confirmation. Note
  `chooseRelayOrNewProfile` renders no "new profile" button for `dclogin:`
  — the lookup must stay optional-chained or the flow dies on a TypeError.
- **PWA protocol handler.** `manifest.webmanifest` registers `web+dcaccount` as a
  protocol handler. Validate incoming `?qr=` parameters before passing them to
  the core.
- **Invite links.** `app/js/invites.js` parses invite links, mirrors custom hosts onto
  the canonical `https://i.delta.chat/#…` scheme the core accepts, and renders them as
  invite cards. Only links whose host is in the domain registry (drawer → "Invite link
  domains"; built-ins mirror the AndroidManifest intent filters) are treated as invites.
  Short invite links (`https://deltachat.id/<name>`, the username service) are detected
  and expanded to the full invite URL (the page JS-redirects, so it is a fetch + HTML
  extraction, not a 3xx follow): shell-side via the `expand_invite_link` command
  (renderer fetch is CORS-blocked), with a bare-fetch fallback and a localStorage cache
  (`velta-short-invites`). Until expanded, messages render a pending card hydrated by a
  document-level MutationObserver in `invites.js`. `openpgp4fpr:` QR text rides the
  same pipeline: the manifest scheme entry makes Android offer Velta, and
  `parseInviteLink` passes the text through to the core natively (1.4.26).
- **Trusted binaries.** The prebuilt `deltachat-backend/` binaries are static
  except for system libraries. If you rebuild them, prefer vendored OpenSSL and
  SQLite to minimize external runtime dependencies.
- **No unsafe code in the core.** The `deltachat` crate forbids `unsafe`; keep
  it that way.

---

## 9. Deployment and runtime architecture

### 9.1 PWA served statically (work in progress)

The browser PWA is not a supported release. These notes describe the
current dev path.

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
  paths: `invoke("rpc", { request })` and `emit("velta-rpc")`. Since #49 the
  desktop `rpc` command RETURNS the response line: it parks the request's
  JSON-RPC id in `RpcState.web_pending`, the sidecar reader thread resolves
  the parked waiter instead of emitting (`resolve_web_line`), and
  `tauriTransport.send` feeds the invoke resolution into the same receiver —
  rpc-core keeps its single-stream design. The broadcast now carries only
  what the core PUSHES (id-less event notifications); a response for an id
  no one waits on anymore (frontend timeout) still falls through to the
  emit path. Android keeps the write-only arm (its WebView speaks through
  the VeltaBridge; responses stay on the forwarder emit). The 180s Rust
  wait is only a leak guard — rpc-core's per-call timeouts fire first.
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
  notifications for IncomingMsg events. The frontend reports page visibility
  via `set_ui_visible`. `MainActivity.onStart`/`onStop` sets a second flag:
  Home often leaves `document.hidden` false and freezes the WebView, which
  kept the poller asleep while the page's parked poll held IncomingMsg until
  the next open. The page does not post its own Android
  notification — that second card doubled once the WebView kept running
  after Home. `onStart` calls
  `maybe_network` and emits `velta-foreground` so the page refetches.
  `CoreService` holds a partial wake lock and the default-network callback.
  A 90s kick while the activity is stopped interrupts a half-open IDLE.
  Doze ignores the wake lock; the page asks for the battery-optimization
  exemption once per cold start until it is granted.
  Event-batch requests (ids `bg-ev-`, `src/bg_events.rs`) are never timed
  out: a parked request cannot be cancelled in the core, and the old 60 s
  timeout left it parked, so its next batch went to a caller that was gone
  and was dropped silently (#21/#22/#25). `PendingGuard` clears the
  `bg_pending` entry however a `bg_rpc` ends; a batch that arrives while
  the UI is visible, or with no waiter left, is emitted to the WebView as a
  `velta_core_events` JSON-RPC notification, which rpc-core dispatches like
  its own poll result. Unit tests: `cargo test --lib bg_events` in
  `velta-app/src-tauri` (desktop build; needs webkit2gtk-4.1 dev headers and
  a placeholder `binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe`).
  **Single reader (#40/#52):** the page's rpc-core asks
  `get_event_reader_mode()` once at poll start; on Android it answers
  `"rust"`, the page skips its own long-poll entirely and fires the
  `events_listener_ready { visible }` handshake, and the Rust poller becomes
  the ONLY reader — it no longer pauses while the UI is up, it routes every
  batch by visibility (forwarded as `velta_core_events` while visible,
  notified natively while hidden). The handshake exists so no batch is
  forwarded before the page's `listen()` is installed and so the first
  polls cannot notify while the app is foreground; the handshake is
  idempotent and re-runs on reconnects. Any probe failure falls back to the
  old dual-reader behavior. `bg_notify_incoming` skips muted chats via
  `is_chat_muted` (#52 L1) — a lookup failure still notifies.
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
- **Loopback bridges are token-gated** (V-01/#61): the service generates a
  128-bit token per start (`BRIDGE_TOKEN` in the service's lib.rs). The WS
  bridge requires the client's FIRST message to be the token (10 s timeout,
  before the broadcast subscription — unauthenticated peers see nothing);
  `POST /rpc` requires `Authorization: Bearer <token>`; `GET /health` stays
  open for the transport probe. Delivery: `RpcService.nativeGetBridgeToken`
  JNI (same process) + a pairing dialog in the service's launcher activity
  (copy → paste into the client's localStorage `velta-bridge-token`).
  transport.js sends the token when configured — without it the bridge
  fails closed by design.
- Boot receiver restarts the service after reboot.

### 9.4 UnifiedPush (Android, 1.4.27+ groundwork)

Push notification registration via [UnifiedPush](https://unifiedpush.org/) —
the user picks a distributor app (ntfy, NextPush, self-hosted); Velta never
talks to Google.

- **Flow:** `MainActivity.onCreate` → `UnifiedPushService.maybeRegister`
  (auto-registers only when a default distributor exists — no OS picker from
  nowhere) → distributor sends the endpoint → `UnifiedPushService.onNewEndpoint`
  serializes it as `webpush:<endpoint>|<pubkey>|<auth>` (the format the
  chatmail push relay parses, same as the upstream Delta Chat UnifiedPush
  flavor) → JNI `pushEndpointReceived` (lib.rs) applies it via
  `Accounts::set_push_device_token` → the core registers it with the relay
  automatically (IMAP METADATA `/private/devicetoken`, core `push.rs` +
  `imap.rs register_token`; token is OpenPGP-encrypted to the relay's
  "notifiers" key and space-padded to hide the platform).
- **Push wake-up:** `onMessage` → JNI `pushWakeup` → one bounded
  `background_fetch` RPC through the `bg-` round-trip → events surface
  through the background poller's parked `get_next_event_batch` → existing
  `bg_notify_incoming` notifications. No new notification plumbing.
- **Core surface** — the vendored core already exposed everything needed
  (`set_push_device_token`, `background_fetch`/`stop_background_fetch` in
  core + JSON-RPC); the shell calls the accounts Arc directly via the
  `ANDROID_ACCOUNTS`/`ANDROID_RPC_TX`/`APP_HANDLE` globals. A token arriving
  before the core initializes is parked in `PENDING_PUSH_TOKEN`. The only
  vendored-core edit (1.4.29) is the observability events below — the push
  registration path itself is untouched upstream behavior.
- **Observability (1.4.29)** — the Diagnostics chat shows the whole chain:
  the shell emits `velta-push` when the distributor endpoint is applied, and
  the core (vendored change in `imap.rs register_token` / scheduler error
  path) emits `Info`/`Warning` events per transport — "push notifications
  registered" (relay accepted the token) vs "relay did not accept the push
  token". The rpc-core `Info`/`Warning` → diagnostic mapping surfaces both.
  Since 1.4.51 `push_wakeup_impl` also mirrors its start/done lines to
  logcat (`println!` → RustStdoutStderr): a wake can run while the process
  is half-frozen by an OEM where the buffered velta.log may never flush —
  `adb logcat -s RustStdoutStderr:*` is the reliable trace (verified: two
  natural `BackgroundFetchJob` fires, fetch done in ~0.5 s each).
- **Scheduled-fetch fallback (#52 L3, `BackgroundFetchJob.kt`)** — a
  periodic (15 min, persisted) JobScheduler job that calls the same wake
  path as a push (`Java_org_velta_BackgroundFetchJob_pushWakeup` →
  `push_wakeup_impl`), covering devices without a UnifiedPush distributor
  and OEM freezers that cut a backgrounded process's sockets — a job
  unfreezes the process for its duration (the official client delivers
  through the same pattern). `onStartJob` keeps the slot for 28 s so the
  OS does not refreeze the process during the async fetch (bounded to 30 s
  shell-side), then calls `jobFinished(reschedule=false)`. Scheduled
  idempotently from `MainActivity.onCreate`.
- **Wake vs dead IDLE (#42/#25 P8, vendored core)** — `Context::
  background_fetch` now bounds its `wait_for_work_done` at 10 s: if the
  post-interrupt fetch has not finished (a half-open IDLE socket read can
  block up to `net::TIMEOUT` = 60 s), it restarts IO so a push wake-up
  reconnects on fresh sockets instead of waiting out the stale one. Device
  evidence in #50: a backgrounded app sat 8.5 min silent because the OS
  cut the socket and nothing noticed until resume.
- ** ceilings:** (1) `CoreService` is NOT stopped when push registers —
  stopping it requires cold-start-by-push support, which needs the Rust core
  to initialize from a Service (there is no `Application` class; `run()`
  only fires from the Activity), plus a notification fallback for pushes
  that arrive before core init. Until then the foreground service stays the
  reliability guarantee and push adds instant-fetch on top. (2) The VAPID
  key in `UnifiedPushService.kt` is the upstream chatmail notifier key — a
  self-hosted relay with its own notifier keypair needs it updated. (3) The
  relay must run a chatmail version whose notifier understands `webpush:`
  tokens (verify per deployment).
- Test with at least two distributors (ntfy + a second one) per the
  UnifiedPush developer guidance.

---

## 10. Quick reference for common tasks

| Task | Command |
|------|---------|
| Run core tests | `wsl -e bash -lc "cd /mnt/c/Users/pave/Velta/velta/core && cargo nextest run --workspace --locked"` (plain `cargo test` flakes on time-shift tests — see `COREUPDATE.md` §4) |
| Run core lints | `cd core && scripts/clippy.sh && scripts/deny.sh` |
| Build core RPC server | `cd core && cargo build -p deltachat-rpc-server --release` |
| Type-check the Android shell | `wsl -e bash -lc "cd /mnt/c/Users/pave/Velta/velta/velta-app/src-tauri && cargo check --target aarch64-linux-android"` (desktop `cargo check` compiles the `cfg(target_os = "android")` code OUT — it proves nothing about JNI/Rust-side Android code) |
| Run Tauri dev | `cd velta-app && cargo tauri dev` |
| Serve PWA locally | `cd app && python -m http.server 8080` |
| Diagnose service | Open `http://localhost:8080/diag.html` |
| Run Python CFFI tests | `cd core/python && pytest` |
| Run Python RPC tests | `cd core/deltachat-rpc-client && pytest` |
| Upgrade the core | Follow `COREUPDATE.md` |

---

## 11. Notes for agents (operational rules)

Per-subsystem narratives live in `docs/agents/*.md` (webxdc, relays,
onboarding, p2p/local chat, android-shell, media, read-receipts) — read the
relevant one before touching that subsystem. The entries below are cross-cutting
do-not-regress rules; dates mark when the lesson was learned.

- **Read-receipt lifecycle (2026-10-02, #59 follow-up)** — a "stuck single
  tick" is almost always the peer never opening the chat on-screen: the only
  MDN trigger is the watermark `markseen_msgs` in the open chat, and
  notification replies do not fire it. Diagnose from the raw core state
  (`get_message`), never from the UI; the recipe + raw-RPC probe live in
  `docs/agents/read-receipts.md`. Related trap: after editing `app/` the
  debug exe can still serve OLD renderer assets until
  `cargo clean -p velta-app` (§4.3).

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
- **Call cards (post-1.4.38, issue #8)** — call messages (core viewtype
  `Call`, mapped to "call" in `_mapViewtype`) render as a call card in the
  chat instead of the stock text string: direction + state + duration from
  `rpc-core.callState` (`call_info`; state kinds Alerting/Active/Missed/
  Declined/Canceled/Completed{duration}), red tint for missed/declined.
  States are cached per msgId (`_callStateCache`, cleared on account
  switch) because rows re-mount on every scroll pass — a new per-call RPC
  per remount would multiply. Mock answers with Completed + the stored
  duration; a demo call message lives in the Ada chat.
- **Chat open position + go-down (post-1.4.38, issue #14; read tracking
  1.4.40)** — open() lands on the manual read marker or the first unread
  message (`get_first_unread_message_of_chat`; the "Unread messages" line
  rides inside that row as `unreadFirst`), else the tail — see §5.1 "Read
  tracking". `_settleScroll(computeTop, reassert)` re-asserts the target on
  a 40 ms TIMER — rAF is unusable here (occluded windows never fire it, and
  that includes headless checks) and the target row may render late
  (computeTop returns null → hold position); `_settling` blocks seen-marking
  until it ends. The go-down button shows whenever the view is away from
  the bottom (it used to appear only on new arrivals — effectively never for
  manual scrolls); its click marks the chat read and settles to the tail
  (`_jumpToLatest`, which first reloads the tail page when the window was
  opened mid-history). Never replace the settling with a single scrollTop
  write: the virtual scroller's async layout wins and the jump silently
  lands mid-history.
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
- **WSL is the core + Android sandbox, NOT the desktop target** — the WSL
  checkout has no GTK/gobject dev libraries, so `cargo check`/`cargo build`
  of `velta-app`'s desktop target dies there with
  `Package 'gobject-2.0', required by 'virtual:world', not found`
  (gobject-sys pkg-config). Desktop Tauri builds/`cargo check` for
  `velta-app` run natively on Windows (vendored `tools/strawberry-perl` +
  `tools/nasm` on PATH, and kill a running `velta-app.exe` + its sidecar
  first — os error 32, §4.3).
- **PowerShell 5.1 mangles inline code — write scripts to a file.** Passing
  anything non-trivial inline (`node -e "…"`, multi-line JS, `&&`, `$`,
  embedded quotes) through a PowerShell command line gets re-parsed by
  PowerShell's grammar and fails with confusing parser errors — put the
  code in a temp `.mjs`/`.ps1` file and run that. Same grammar rule for
  calling executables: a QUOTED path must use the call operator —
  `& "C:/path/tool.CMD" args` — because `'path' args` alone is a string
  followed by tokens ("Unexpected token" parser error). Also
  cosmetic-but-noisy: `cargo check 2>&1 |` makes PowerShell print
  `NativeCommandError` walls for cargo's normal stderr progress — a
  `Finished` line means success; don't mistake the noise for failure.
  Encoding pitfalls are a separate rule (§11 "Encoding").
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
  `changelog.md` ("What's changed in Velta <tag>" + user-facing
  conventional commits only — feat/fix/perf/refactor/revert; the rest are
  skipped) and `announce.md` (same minus the compare link, plus a
  "Download" tag link; rides a workflow artifact to the notify
  job, which posts it to `ntfy.gluek.info/velta_changelog`). The keystore
  lives in `signing/`
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
  stay compatible. WATCH: request-body field CASING is a silent trap —
  serde ignores unknown fields, so a renamed/renamed-back input field
  (`viewType` vs `viewtype`) vanishes without an error (see the Stickers
  bullet in §5.1; `sendMessage` now sends both casings). WATCH a second
  silent trap: ARGUMENT COUNT/SHAPE. The core answers a null where a Vec
  is expected with `invalid type: null, expected a sequence`, while
  `[accountId, [null]]` (null element) says `expected u32` instead — map
  a wire error to its exact position by probing the released rpc-server
  with hand-built params:
  `printf '{"jsonrpc":"2.0","id":1,"method":"delete_messages","params":[0,null]}' | DC_ACCOUNTS_PATH=<existing tmp dir> deltachat-backend/windows-x86_64/deltachat-rpc-server.exe`
  (deserialization happens before the account lookup, so no real account
  is needed). That recipe identified the local-chat Proxy's dropped `ids`
  argument (post-1.4.35 fix — docs/agents/p2p.md).
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
- **Error toasts go to Diagnostics (1.4.30)** — every error-path toast in
  app.js/chat-view.js routes through `errToast(text, ms)` (toast +
  `diagnosticsSink.append(`error`, ...)` → Diagnostics chat + velta.log). Toasts
  vanish in seconds; sink rows persist. New error toasts MUST use errToast,
  and plugin-invocation failures should include the resolved argument
  (e.g. the absolute path) in the message — that is what made the open_path
  bug diagnosable in one round-trip.
- **Frontend click/spacing plumbing (1.4.30)** — four failures hit in one feature;
  all four are permanent rules:
  1. `window.open`/target=_blank is silently swallowed by wry on desktop — nothing
  opens, no error. The working desktop path is the opener plugin (`plugin:opener|open_url`,
  `opener:default` capability; see `openExternal()` in chat-view.js and the update banner).
  2. Do NOT route desktop links through the in-app iframe overlay — it is the Android
  branch of `openInAppBrowser`; desktop links go to the system browser.
  3. DOM inserted ASYNC (link-preview cards) is invisible to per-anchor wiring
  done at row build — wire click handling by DELEGATION at the row level.
  4. The virtual scroller inline-writes `style.paddingTop/Bottom` onto `.history
  every layout pass; spacing rules must target `.history-scroll`, never `.history`.
  Also: inline `onclick` attributes die under the CSP (no `unsafe-inline`) — wire
  listeners in DOM code, never as HTML attributes.
- **Opening file attachments (1.4.30, three-step lesson)** — the tap on a
  downloaded non-media file failed three ways before it opened; all three
  layers must be correct together:
  1. COMMAND permission: `opener:default` does NOT include open_path —
  `opener:allow-open-path` must be listed in BOTH capability files
  (platforms rule, §4.3).
  2. PATH SCOPE: the bare permission ships ZERO scope entries; the plugin
  computes fs_scope.is_allowed(path) AND any(Entry.matches_path_program) —
  an empty allow list denies EVERY path (“Not allowed to open path”).
  The permission must be an object with an allow scope; Velta allows
  `$APPLOCALDATA/accounts` + `/**` (all attachment blobs live there).
  3. ABSOLUTE path: the scope matches absolute paths only. The core's
  `filePath` is relative to the accounts dir — `_openFile` resolves it
  against `window.veltaAccountsDir` (get_accounts_dir, set at boot) first.
  Debug order: reproduce → read the resolved `capabilities.json` under
  `target/<target>/release/build/velta-app-*/out/` → error toast now carries the
  resolved path. Verify with a REBUILT binary — config fixes never reach a
  running/installed app.
- **A section header can swallow functions (1.4.35)** — a duplicated
  `/* ---- deeplinks ----` divider whose `*/` was lost turned everything up
  to the NEXT divider's closer into comment text: `node --check` still
  passed, grep still "found" the definitions, and at runtime every
  fresh-install account creation died with "Setup failed:
  askNotificationPermission is not defined" (shipped in v1.4.34/1.4.35;
  addAccountFromInvite/deeplinks were dead the same way). After inserting
  dividers or moving top-level functions, run
  `node --test tests/app-source-integrity.test.mjs` — it comment-strips
  app.js and asserts the pinned definitions still exist outside comments.
- **Sending dashes can lose their terminal events (post-1.4.36)** — the
  relay line's send-activity bookkeeping (`rpc-core _trackSending/
  _untrackSending`) cleared only on MsgDelivered/MsgFailed, but the Android
  background poller consumes those events while the app is hidden, a
  transport reconnect drops mid-flight events, and a pending message deleted
  before delivery never emits one — the dashes stuck forever (user reports).
  Two defenses live in rpc-core: `reconcileSending()` (wired to visibility
  resume and velta-core-status connected) re-checks tracked ids via
  get_message, and a 90 s backstop (`sendingBackstopMs` knob) force-clears a
  stuck set. Any new send-like path (e.g. resendMessage) must re-track.
  Contract + pins: docs/agents/relays.md, tests/send-activity.test.mjs.
- **No built-in Yggdrasil, and the chatmail core stays mandatory** (#29 and
  #31, closed wontfix 2026-09-30). Mail already goes through one proxy URL
  (`proxy_url` in `core/src/net/proxy.rs`: HTTP CONNECT, SOCKS5, or
  Shadowsocks). A Yggdrasil node stays a separate app; do not vendor one,
  and do not add the Proxies drawer that issue asked for. The core is the
  database and the message model. `core/src/transport.rs` is one IMAP/SMTP
  relay, not a plugin slot. Local chat wraps the booted core and does not
  replace it. A profile with no relay is the welcome splash's "Enter local
  chat…". Detail: docs/agents/relays.md, docs/agents/p2p.md.
- **Encoding (2026-09-23)** — every text file is UTF-8 without BOM; no
  exceptions. On this Windows checkout the ANSI codepage is CP1251
  (Cyrillic), and tools that read or write with the default encoding —
  PowerShell 5.1 `>`/`>>`/`Out-File`/`Set-Content`/`Get-Content`, `cmd`
  redirection, some editors — silently turn `—` (U+2014, bytes `E2 80 94`)
  into `вЂ”`, `…` into `вЂ¦`, `→` into `в†'`, box-drawing into `в”‚`,
  and emoji into `рџ¤¦`. This corrupted ~570 runs across README.md,
  AGENTS.md, main.css, mock-core.js, sw.js, Cargo.toml and lib.rs (all
  repaired 2026-09-23). NEVER let a PowerShell 5.1 pipeline write a
  source or docs file: use `-Encoding utf8` explicitly, or write from
  WSL/bash, or use an editor/API that writes UTF-8 by default. If you
  ever see `вЂ`, `в”`, `В§`, `рџ` or any stray Cyrillic inside English
  prose, STOP and fix the encoding of the whole write path before
  committing — never "patch" the visible characters only. **Reading counts
  too**: `Get-Content` without `-Encoding` decodes as CP1251 and
  `Set-Content`/`Out-File` round-trips the damage back to disk — the v1.4.26
  version bump re-mojibaked `sw.js`/`Cargo.toml` exactly this way (the BOM
  check passed, the content was already corrupted; caught by an external
  PR). Read AND write with explicit UTF-8, or use the edit tools / WSL.
