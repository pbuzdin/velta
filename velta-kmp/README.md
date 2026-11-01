# Velta KMP client

Native client for **Android + Desktop (Windows/macOS/Linux)** built with
Kotlin Multiplatform + Compose Multiplatform.

**Status (2026-11-02):** P0–P3 complete, P4 at slice 7 of ~10 — the client
onboards from invites, manages relays, switches accounts, sends with
attachments/quotes/reactions, renders media, keeps syncing in the
background, and wears the Velta brand. 20 tests + two no-network e2e
round-trips against the real core gate every push. See
[docs/PHASES.md](docs/PHASES.md) for the per-phase ledger and what's left.

| Surface | Codebase | Status |
|---|---|---|
| PWA (`../app`) | build-less web UI | flagship, unchanged |
| Tauri shell (`../velta-app`) | wraps the PWA | unchanged until KMP parity |
| **KMP client (this dir)** | Compose UI + JSON-RPC core bridge | P4 in progress, issue #192 |

## What works today

- **Onboarding** — sign-in, or paste a `DCACCOUNT:` invite (🎟) and the app
  sets itself up; secure-join invites (`DCJOIN:`) start the join protocol.
- **Relays** — ⚡ screen: one card per transport with C/I/P/D capability
  flags and relay-provided details; remove.
- **Accounts** — 👤 switcher; the core's selected account persists across
  restarts (probed), so the choice survives with zero local storage.
- **Messaging** — chat list (badges, pins), chat view (day separators, sender
  names in groups, media), composer with drafts, quotes, attachments, quick
  reactions, delivery-state glyphs (⏳/⚠️/✓/✓✓).
- **Persistence** — resume straight into the chat list on every start; the
  core's accounts dir is the only storage.
- **Background** — a dataSync foreground service holds the process (screen
  off), and after a process kill the sticky service rebuilds the core
  headlessly (`am crash` verified).
- **Look** — `VeltaTheme` lifted from the PWA tokens, system dark/light.

## Layout

```
composeApp/src/
  commonMain/    Compose UI + AppModel + VeltaCore facade (PURE Kotlin — no java.*)
  jvmCommon/     shared JVM: process/socket transports, java.time formatters
  androidMain/   MainActivity, AppHolder, foreground service, JNI shim, SAF picker
  desktopMain/   sidecar spawn, window entry, AWT file picker
  desktopTest/   all tests (scripted transports + real-binary IT)
native/rpc-shim/ Rust cdylib: in-process core for Android (JSON Lines on 127.0.0.1)
```

Agent conventions, build/verify recipes and protocol facts: **[AGENTS.md](AGENTS.md)**.
Phase status and honest gaps: **[docs/PHASES.md](docs/PHASES.md)**.

## Build

```sh
./gradlew :composeApp:assembleDebug                     # Android debug APK
./gradlew :composeApp:packageDistributionForCurrentOS   # desktop installer
./gradlew :composeApp:desktopTest                       # unit tests (+ real-binary IT when VELTA_KMP_RPC_SERVER is set)
```

Requires JDK 21 (and the Android SDK for the Android target). CI:
`.github/workflows/build-kmp.yml` builds both targets and runs the tests on
every push touching this dir; the `shim` job produces the Android core
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
