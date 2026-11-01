# Velta KMP client

Native client for **Android + Desktop (Windows/macOS/Linux)** built with
Kotlin Multiplatform + Compose Multiplatform.

Plan, phases and decision gates live in the tracking issue:
https://github.com/pbuzdin/velta/issues/192

Positioning at a glance:

| Surface | Codebase | Status |
|---|---|---|
| PWA (`../app`) | build-less web UI | flagship, unchanged |
| Tauri shell (`../velta-app`) | wraps the PWA | unchanged until KMP parity |
| **KMP client (this dir)** | Compose UI + JSON-RPC core bridge | greenfield, tracking issue #192 |

Core contract: deltachat **JSON-RPC** — the same RPC surface the vendored core
speaks (`../core`) and that all Velta core patches target. Desktop talks to the
existing `deltachat-rpc-server` sidecar; Android targets an in-process shim
over time. No new API surface, no C-FFI binding fork.

## Layout

- `composeApp/` — single KMP module: `commonMain` (Compose UI + app state),
  `androidMain` (activity/manifest), `desktopMain` (window entry).
- `gradle/libs.versions.toml` — version catalog. Gradle 8.14.3 + Kotlin 2.2.20 +
  compileSdk 36 mirror the proven Tauri gen Android toolchain.

## Build

```sh
./gradlew :composeApp:assembleDebug                     # Android debug APK
./gradlew :composeApp:packageDistributionForCurrentOS   # desktop installer/jar
```

Requires JDK 21 (and the Android SDK for the Android target). CI:
`.github/workflows/build-kmp.yml` builds both on every push touching this dir.
