# Velta — Tauri desktop/Android shell

This directory is the **Tauri v2** wrapper around the Velta PWA in `../app`.
It produces a native Windows installer and a native Android APK from a single
frontend codebase.

**Current stable version:** `1.3.7`  
**Bundled core:** `deltachat-core-rust 2.59.0`

## What's new in 1.3.7

- **New: incoming-message notifications** — messages arriving while the app
  is in the background show a system notification (sender + message preview,
  throttled). Android 13+ `POST_NOTIFICATIONS` permission is requested at
  boot. Tapping a notification opens the app (deep-linking to the specific
  chat is a planned refinement).
- **New: upgrade-safe release signing in CI** — the Android workflow signs
  with a persistent keystore from repo secrets, so successive builds install
  over each other without uninstalling (which wiped accounts). Without the
  secrets configured, CI falls back to an ephemeral key with a loud warning;
  see `.github/workflows/build-android.yml` for the one-time setup.
- Still open (see `CONCERNS-GPT6.md` §5.3): guaranteed sync under Doze /
  process death needs a foreground-service integration.

## What's new in 1.3.6

- **Fixed:** video seeking and mid-file playback on media served by the
  loopback HTTP server — Range requests now seek to the requested offset and
  stream exactly the requested interval (the old handler truncated the file
  from byte 0 without seeking, so `bytes=100-199` returned the first 100
  bytes labelled as 100-199). Full GETs stream in 64 KiB chunks instead of
  buffering the entire video in memory, and unusable Range headers get a
  proper `416` response.
- **Fixed:** oversized media (poster extraction) could allocate the whole
  file into memory and IPC before the size check ran — `read_media_bytes`
  now refuses files above 128 MiB via metadata before any read.
- Regression tests: `media_tests` in `src-tauri/src/lib.rs` (offset-correct
  206 payloads, suffix/open-ended ranges, 416, streamed full GET,
  pre-allocation size guard).

## What's new in 1.3.5

- **Fixed:** incoming-message notifications and chat updates going silent
  after the app idled longer than the RPC timeout — the event long-poll no
  longer abandons a timed-out `get_next_event` (whose backend waiter would
  consume the event for a response the frontend had already forgotten).
  Timed-out polls are re-issued with a 240 s backstop and their late
  responses are dispatched instead of dropped, with account attribution and
  epoch filtering intact. Regression suite: `tests/rpc-event-poll.test.mjs`.

## What's new in 1.3.4

- **Pairing consent:** LAN beacons advertise presence only (name + addresses)
  — they no longer carry the pairing token. A Nearby tap now sends a pairing
  request that the other device must explicitly approve (or it expires after
  120 s); a wrong or forged token is rejected without a prompt. QR-invite
  pairing is unchanged: presenting the token from a scanned ticket remains
  the out-of-band proof. `CONCERNS-GPT6.md` §2 tracks the security review.
- **Account isolation:** switching profiles can no longer leave the previous
  account's chat actionable or let its in-flight requests land in the new
  account (stale sends, cache pollution, A→B→A races). Account transitions
  tear down account-owned UI synchronously, RPCs stay pinned to their entry
  account, unsent drafts are kept per (account, chat), and open confirmations
  settle on switch. Regression suites under `tests/` (76 tests, `node --test`).

## What's new in 1.3.x

- **Local chat (beta):** serverless end-to-end-encrypted 1:1 chat between
  devices on the same network (iroh QUIC, no relay). Devices are discovered
  via UDP LAN beacons; Nearby pairing requires approval on the other device,
  or scan an invite QR. See `src-tauri/src/p2p.rs` and `AGENTS.md` §5.4.
- **Account switcher:** the drawer lists every profile in the accounts file;
  tap to switch (IO runs for all accounts, so nothing is disconnected).
- **Relay management:** save up to 3 chatmail relays, create accounts on any
  of them, or delete them. A "Welcome to Velta" onboarding modal accepts a
  relay address directly (first boot keeps the old auto-configure flow).
- **Fixed:** Local chat Retry crash (spawn outside runtime), peers flipping
  offline (QUIC idle timeout → 20 s keepalives), chat-open crash after
  pairing. QR camera scanning was removed (unreliable in WebViews); pairing
  uses LAN beacons, codes are pasted instead.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  WebView (system WebView, no bundled browser)                 │
│  ../app — Velta PWA (vanilla JS + Elena + virtual-scroller) │
└──────────────────▲───────────────────────▲────────────────────┘
                 │                       │
   transport.js auto-detects backend      │
                 │                       │
    ┌────────────┴───────────────────────┴────────────┐
    │  delta-web-app/src-tauri (Rust)                    │
    │                                                    │
    │  Windows: spawns ../deltachat-rpc-server.exe as   │
    │           a sidecar, talks over stdio → Tauri IPC   │
    │                                                    │
    │  Android: links deltachat-jsonrpc in-process as   │
    │           a native .so via yerpc RpcSession         │
    └────────────────────────────────────────────────────┘
```

The frontend never touches the network directly. It speaks JSON-RPC 2.0 to the
core through `app/js/rpc-core.js`, which is wrapped by `app/js/transport.js`
to pick the right backend at runtime:

1. `window.DcBridge` — Android WebView JS bridge (future option)
2. `window.__TAURI__` — Tauri IPC (`invoke("rpc")` / `emit("dc-rpc")`)
3. WebSocket loopback service (`ws://127.0.0.1:20808`)
4. HTTP loopback service (`http://127.0.0.1:20809/rpc`)
5. In-memory `MockCore` for browser development

## Repository layout

```
delta-web-app/
├── src-tauri/
│   ├── Cargo.toml            # Rust package manifest
│   ├── tauri.conf.json       # Tauri window/bundle/mobile config
│   ├── src/
│   │   ├── lib.rs            # Android in-process core + Windows sidecar bridge
│   │   └── main.rs           # Tauri entry point
│   ├── gen/android/          # Generated Gradle project (after android init)
│   ├── icons/                # App icons for Windows/Android
│   └── target/release/bundle/# Build artifacts (.msi, .exe, .apk, .aab)
└── README.md                 # This file

The actual frontend lives one level up:

../app/
├── index.html                # Main app shell
├── diag.html                 # Connection diagnostics
├── css/main.css              # Single hand-written stylesheet
├── js/
│   ├── app.js                # Bootstrap, chat list, modals, PWA lifecycle
│   ├── chat-view.js          # Message history, composer, selection
│   ├── components.js         # Elena web components
│   ├── rpc-core.js           # Real JSON-RPC core wrapper
│   ├── transport.js          # Backend auto-detection
│   ├── ui.js                 # Drawer, menus, modals, toasts
│   └── mock-core.js          # In-memory demo backend
├── vendor/
│   ├── elena.js              # Lightweight web-components library
│   └── virtual-scroller.js   # Virtual list helper
└── sw.js                     # App-shell service worker
```

## Prerequisites

### Windows build

- Rust stable (1.77.2+)
- Node.js 18+ (for the Tauri build tooling)
- Tauri CLI: `cargo install tauri-cli --version "^2"`
- The sidecar binary must already exist at:
  `delta-web-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe`
  (it is referenced from `tauri.conf.json` bundle resources and copied next to
  the installed executable).

### Android build

- Android Studio SDK + NDK (tested with NDK 27.2.12479018)
- Rust Android targets installed:
  `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- Tauri CLI v2
- On this project the Android builds are run inside WSL with the NDK in
  `/home/pave/android/ndk/27.2.12479018` and the debug keystore in
  `/home/pave/android/keystore/velta-debug.keystore`.

## Build & run

### Windows

```bash
cd delta-web-app

# Development run
cargo tauri dev

# Release installer (.msi + NSIS .exe)
cargo tauri build

# Artifacts:
#   src-tauri/target/release/bundle/msi/Velta_1.1.0_x64_en-US.msi
#   src-tauri/target/release/bundle/nsis/Velta_1.1.0_x64-setup.exe
```

### Android

This repo includes convenience scripts for the WSL build environment used here:

```bash
# Build the release APK (sets JAVA_HOME, ANDROID_HOME, NDK toolchain, etc.)
../../tools/wsl-android-build.sh

# Sign the APK with the debug keystore
../../tools/wsl-android-sign.sh
```

Manual steps:

```bash
# One-time setup
cargo tauri android init

# Development build / run on device
cargo tauri android dev --target aarch64

# Release APK / AAB
cargo tauri android build --target aarch64

# Artifacts:
#   src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
#   src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

The project uses a **debug keystore** for the signed test APK:

```bash
export JAVA_HOME=/home/pave/jdk/jdk-17
export PATH=$JAVA_HOME/bin:/home/pave/android/build-tools/35.0.0:$PATH

UNSIGNED=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
ALIGNED=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-zipaligned.apk
SIGNED=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-signed.apk
KS=/home/pave/android/keystore/velta-debug.keystore

zipalign -p -f 4 "$UNSIGNED" "$ALIGNED"
apksigner sign --ks "$KS" --ks-pass pass:velta123 --key-pass pass:velta123 \
  --out "$SIGNED" "$ALIGNED"
```

Install on the phone:

```bash
adb install -r app-universal-release-signed.apk
```

## Data storage

Account databases, keys, and blobs live in the platform app-data directory:

- Windows: `%LOCALAPPDATA%/org.velta/accounts`
- Android: app-private storage (survives updates, wiped on uninstall)

Logs for the Tauri build:

- Windows: `%LOCALAPPDATA%/Velta/logs/velta.log`
- Android: `/sdcard/Android/data/org.velta/files/logs/velta.log` or the app-private
  `logs/` directory depending on the device.

## Stable release checklist

- [x] Desktop Windows installer works end-to-end.
- [x] Android APK builds and installs.
- [x] Onboarding starts I/O after account creation so messages sync without a restart.
- [x] Event loop (`get_next_event`) + chat-list refresh deliver incoming chats and messages live.
- [x] Safe-area insets keep the UI clear of the Android status/navigation bars.
- [x] Capability files grant Tauri event permissions on desktop and mobile.
- [x] File, photo, video and generic-file sending works on desktop; large messages show a download button that fetches the full body.

## Notes

- The frontend has no bundler. Any change under `../app/` is immediately visible
  in `cargo tauri dev` and in the PWA after bumping the `CACHE` constant in
  `../app/sw.js`.
- `Cargo.toml` pins the core via `path = "../../core/deltachat-jsonrpc"` on Android.
  On Windows the core is the prebuilt `deltachat-rpc-server.exe` sidecar.
- The JSON-RPC surface used by the UI is documented in the core's OpenRPC spec:
  `deltachat-rpc-server --openrpc`.
