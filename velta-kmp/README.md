# Velta KMP client

Native client for **Android + Desktop (Windows/macOS/Linux)** built with
Kotlin Multiplatform + Compose Multiplatform.

**Status (2026-11-12):** promoted to the Android delivery track (Rust-UI flip,
#314 verdict) — design port started (Prism person colors + fingerprint
identity matrix, web-parity vectors pinned in tests). Previous status:
**2026-11-02:** P0–P3 complete, P4 functional slices done (12),
P5 opened (release builds + size shipped) — the client onboards from
invites or QR scans, manages relays, switches accounts, sends with
attachments/quotes/reactions, renders media, encrypts its database at
rest (Keystore custody), locks behind biometric/device-credential, keeps
syncing in the background, and wears the Velta brand. 24 tests + two
no-network e2e round-trips against the real core gate every push. See
[docs/PHASES.md](docs/PHASES.md) for the per-phase ledger and what's left.

| Surface | Codebase | Status |
|---|---|---|
| PWA (`../app`) | build-less web UI | flagship, unchanged |
| Tauri shell (`../velta-app`) | wraps the PWA | unchanged until KMP parity |
| **KMP client (this dir)** | Compose UI + JSON-RPC core bridge | P4/P5 in progress, issue #192 |

## What works today

- **Onboarding** — sign-in, paste a `DCACCOUNT:` invite (🎟), or **scan a
  QR** (📷, CameraX + ZXing, decoded on-device); secure-join invites
  (`DCJOIN:`) start the join protocol.
- **Relays** — ⚡ screen: one card per transport with C/I/P/D capability
  flags and relay-provided details; remove.
- **Accounts** — 👤 switcher; the core's selected account persists across
  restarts (probed), so the choice survives with zero local storage.
- **Messaging** — chat list (badges, pins), chat view (day separators, sender
  names in groups, media), composer with drafts, quotes, attachments, quick
  reactions, delivery-state glyphs (⏳/⚠️/✓/✓✓).
- **Security** — database encryption at rest (Keystore-wrapped DEK →
  `VELTA_DB_KEY`, patch #20 contract; on-disk db verified ciphertext);
  optional app lock (🔒 biometric/device-credential — locked = the core
  never starts, nothing decrypts). Port of #178, with two Tauri-side
  keystore bugs (undersized wrap blob, StrongBox fallback) fixed here.
- **Persistence** — resume straight into the chat list on every start; the
  core's accounts dir is the only storage.
- **Background** — a dataSync foreground service holds the process (screen
  off); after a process kill the sticky service rebuilds the core
  headlessly (`am crash` verified); UnifiedPush receiver wired (relay-side
  notifier still pending); battery-allowance row for OEM savers.
- **Look** — `VeltaTheme` lifted from the PWA tokens, system dark/light.

## Layout

```
composeApp/src/
  commonMain/    Compose UI + AppModel + VeltaCore facade (PURE Kotlin — no java.*)
  jvmCommon/     shared JVM: process/socket transports, java.time formatters
  androidMain/   MainActivity (FragmentActivity), AppHolder, foreground service,
                 push receiver, VeltaKeystore/VeltaLock, scan/ (QR camera),
                 SAF picker, JNI shim
  desktopMain/   sidecar spawn, window entry, AWT file picker
  desktopTest/   all tests (scripted transports + real-binary IT)
native/rpc-shim/ Rust cdylib: in-process core for Android (JSON Lines on 127.0.0.1)
composeApp/proguard-rules.pro — JNI + serialization keeps for R8
```

Agent conventions, build/verify recipes and protocol facts: **[AGENTS.md](AGENTS.md)**.
Phase status and honest gaps: **[docs/PHASES.md](docs/PHASES.md)**.

## Build

```sh
./gradlew :composeApp:assembleDebug                     # Android debug APK
./gradlew :composeApp:assembleRelease                   # minified release APK (R8)
./gradlew :composeApp:packageDistributionForCurrentOS   # desktop installer
./gradlew :composeApp:desktopTest                       # unit tests (+ real-binary IT when VELTA_KMP_RPC_SERVER is set)
```

Requires JDK 21 (and the Android SDK for the Android target). Release
signing reads `keystore.properties` (gitignored) when present and falls
back to the debug key otherwise — sizes: debug ≈ 69 MB, release ≈ 57 MB
universal (size-tuned LTO shim + R8). CI:
`.github/workflows/build-kmp.yml` builds both targets and runs the tests
on every push touching this dir; the `shim` job produces the Android core
`.so` artifacts on demand.

## Run the desktop demo

The app spawns `deltachat-rpc-server` and talks JSON Lines over stdio
(accounts land in `~/.velta-kmp/accounts`):

```sh
export VELTA_KMP_RPC_SERVER=/path/to/deltachat-rpc-server   # any recent build
./gradlew :composeApp:run
```

Sign in with a throwaway account — or paste a `DCACCOUNT:` invite via 🎟.

## Android core shim (P1b)

Android runs the core **in-process** — `native/rpc-shim/` is a small Rust
cdylib (Accounts + CommandApi + yerpc, one session per connection) serving
the deltachat JSON-RPC surface on `127.0.0.1`; the app loads it via JNI and
connects with a plain socket transport. Same architecture as the Tauri
Android shell. Build recipe (WSL, NDK exports) is in [AGENTS.md](AGENTS.md);
the CI `shim` job publishes ready-made `.so` artifacts. The files stay out
of git (same rule as the Tauri `binaries/`).
