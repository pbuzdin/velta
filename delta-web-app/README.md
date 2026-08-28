# Velta — Tauri desktop/Android shell

This directory is the **Tauri v2** wrapper around the Velta PWA in `../app`.
It produces a native Windows installer and a native Android APK from a single
frontend codebase.

**Current stable version:** `1.1.5`  
**Bundled core:** `deltachat-core-rust 2.59.0`

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
