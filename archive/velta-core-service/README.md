> **ARCHIVED (2026-10-20) — unmaintained.** This UI-less service APK is no longer
> built, tested or updated. It links chatmail core **v2.62.0** by git tag and was
> not moved to the vendored core (2.64+). Its CI (`core-service.yml`) was removed
> and it is not part of the core-update checklist. Kept for history/reference only.

# Velta Core Service — UI-less Android APK

A headless Android app that runs the Delta Chat core (chatmail relay
connections, end-to-end encryption) as a **foreground service** in the
background. The app has **no visible UI**: tapping the launcher icon starts
the service and closes immediately. The only surface is a persistent,
music-player-style notification with a **Stop** action.

- `velta-core-service.apk` — ready to sideload (debug-signed, arm64-v8a, min Android 7.0 / API 24)
- `rust/` — JNI crate (`librpc_core.so`): the chatmail core linked in-process
- `android/` — the Java/Gradle shell (service, notification, boot receiver)

## How it works

```
Launcher tap → MainActivity (translucent, noHistory)
                  │  requests POST_NOTIFICATIONS (Android 13+)
                  │  startForegroundService → finish()
                  ▼
        RpcService (foreground, type=dataSync)
                  │  JNI: nativeStart(filesDir/accounts)
                  ▼
        librpc_core.so — deltachat-jsonrpc + yerpc RpcSession
                  │  start_io() → connects to chatmail relays
                  ▼
        Notification: "Delta Chat core running"  [ Stop ]
```

- **Stop button**: sends `ACTION_STOP` → `nativeStop()` → `stop_io()` →
  `stopForeground()` + `stopSelf()`. Clean shutdown.
- **Boot**: `BootReceiver` restarts the service after reboot.
- **JSON-RPC transport**: the core speaks the same JSON-lines protocol as
  `deltachat-rpc-server`, but over JNI instead of stdio:
  - Java → core: `RpcService.rpc(jsonLine)`
  - core → Java: callback `onRpcMessage(String)` (attach via `setRpcListener`)
  - Other apps/components can `bindService()` and use `RpcBinder`.
- **WebSocket bridge for PWAs**: the service also listens on
  `ws://127.0.0.1:20808` (loopback only). Any local client — e.g. the
  Velta PWA installed from a static host — can speak JSON-RPC to the
  background core through it. Multiple clients are supported (core output is
  broadcast to all). Works from HTTPS pages because loopback is a
  potentially-trustworthy origin and WebSocket is not subject to CORS.

## Rebuilding

```bash
# 1. Rust core (needs Android NDK r27, target aarch64-linux-android)
cd rust
CC_aarch64_linux_android=$NDK/aarch64-linux-android24-clang \
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android24-clang \
cargo build --release --target aarch64-linux-android
cp target/aarch64-linux-android/release/librpc_core.so \
   ../android/app/src/main/jniLibs/arm64-v8a/

# 2. APK (needs Android SDK platform-34 + build-tools, JDK 17, Gradle 8.9)
cd ../android
gradle assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

## Notes & caveats

- **Account setup**: the core starts unconfigured. Configure once via the
  JSON-RPC API (`add_account` + `add_transport`/`set_config_from_qr` with a
  `dcaccount:` invite link), e.g. from a companion UI app over the Binder, or
  reuse the Velta Tauri/PWA client.
- **Battery**: a foreground service is exempt from most Doze kills; some OEM
  ROMs still need "no battery restriction" for this app.
- The debug APK is signed with the Android debug key — fine for sideloading,
  not for Play Store upload.
- Currently arm64-v8a only (covers virtually all devices in use); add
  `armeabi-v7a` by rebuilding the Rust target if needed.

## Using it from the PWA

Pair once: tap the launcher icon, copy the bridge token, and store it in the
client's `localStorage` as `velta-bridge-token`. The PWA then finds the
service on `ws://127.0.0.1:20808`; `diag.html` checks the socket, the token
and one JSON-RPC round trip. There is no HTTP endpoint (the old
`127.0.0.1:20809` bridge was removed).
