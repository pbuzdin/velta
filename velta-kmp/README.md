# Velta KMP client

Native client for **Android + Desktop (Windows/macOS/Linux)** built with
Kotlin Multiplatform + Compose Multiplatform.

**Status (2026-11-12):** Android delivery track (Rust-UI flip, #314, #192).
N1 (Prism + fingerprint identity matrix), N2 (conversation notifications,
RPC timeout/recovery, shim teardown, chat paging), and N3 (glass on the
composer and header) are in. N4 release signing is still open. The client
onboards from invites or QR scans, manages relays, switches accounts,
sends with attachments/quotes/reactions, renders images, encrypts its
database at rest, locks behind biometric/device-credential, and keeps
syncing in the background. Desktop tests gate every push, plus a
real-binary check when `VELTA_KMP_RPC_SERVER` is set. Debug APKs are
signed with the shared `composeApp/debug.keystore` and take the CI run
number as versionCode, so each build installs over the previous one; ABI
splits keep the phone APK ~28 MB. See [docs/PHASES.md](docs/PHASES.md)
for the per-phase ledger and what's left.

| Surface | Codebase | Status |
|---|---|---|
| PWA (`../app`) | build-less web UI | flagship, unchanged |
| Tauri shell (`../velta-app`) | wraps the PWA | unchanged until KMP parity |
| **KMP client (this dir)** | Compose UI + JSON-RPC core bridge | **work in progress** (back in work 2026-11-12), issue #192 |

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
- **Profile** — the contact sheet: fingerprint identity matrix (or Prism
  tile), media counts, profile key, last seen, notifications and
  disappearing-messages state, block/unblock.
- **Notifications** — per-chat conversation cards on a Messages channel;
  muted chats and the on-screen chat are skipped; tap deep-opens the
  chat. (Background delivery still needs the relay-side UnifiedPush
  notifier.)
- **Look** — `VeltaTheme` built from tokens generated from Velta
  stable's `app/css/main.css` (#318): dark, light, brutal and AMOLED,
  system dark/light by default; Prism person colors and fingerprint identity matrices are
  bit-identical to the PWA (vectors pinned in `PrismIdentityTest`).
  The chat list header has the logo, search, and a relay-status strip.
  The composer and the headers are glass on Android 13+ (a blur on
  Android 12, a translucent plate otherwise). The header glass continues
  under the status icons.

## Theme tokens (#318)

`composeApp/src/commonMain/kotlin/org/velta/kmp/ui/VeltaTokens.kt` is
generated — never hand-edit it. After changing a token in
`app/css/main.css`, run from the repo root:

```sh
node tools/gen-kmp-theme.mjs
```

`tests/kmp-theme-tokens.test.mjs` (part of `node --test 'tests/**/*.test.mjs'`)
fails when the file is stale. `Theme.kt` maps the tokens onto Material3
(`ColorScheme`, `Typography`, `Shapes`); tokens Material has no slot for
(bubbles, meta ink, read ticks, quote names, chat ground…) come from
`Velta.tokens` (`LocalVeltaTokens`). `VeltaTheme(mode)` takes
`VeltaThemeMode.System` (default), `Dark`, `Light`, `Brutal` or `Amoled`;
there's no settings UI for it yet. `color-mix()` tokens (hover/pressed,
call screen) aren't generated.

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
