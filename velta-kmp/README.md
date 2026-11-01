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
./gradlew :composeApp:desktopTest                       # unit tests (+ real-binary IT when VELTA_KMP_RPC_SERVER is set)
```

Requires JDK 21 (and the Android SDK for the Android target). CI:
`.github/workflows/build-kmp.yml` builds both on every push touching this dir.

## Android core shim (P1b)

Android runs the core **in-process** — no sidecar binary. `native/rpc-shim/`
is a small Rust cdylib (Accounts + CommandApi + yerpc, one session per
connection) that serves the deltachat JSON-RPC surface on `127.0.0.1`; the
app loads it via JNI (`System.loadLibrary("velta_rpc_shim")`) and connects
with a plain socket transport. Same architecture as the Tauri Android shell.

Build (WSL — NDK exports per AGENTS §4.3.3, targets already installed):

```sh
export NDK=$HOME/Android/Sdk/ndk/29.0.13846066
export TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
export RANLIB=$TC/llvm-ranlib AR=$TC/llvm-ar PATH="$TC:$PATH"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$TC/clang
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=--target=aarch64-linux-android24"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER=$TC/clang
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=--target=x86_64-linux-android24"
cargo build --release \
  --target aarch64-linux-android --target x86_64-linux-android
```

Copy the outputs into `composeApp/src/androidMain/jniLibs/{arm64-v8a,x86_64}/`
(kept out of git — same rule as the Tauri `binaries/`; a CI job replaces this
step later).

## Run the P1 bridge demo (desktop)

The app spawns `deltachat-rpc-server` and talks JSON Lines over stdio
(accounts land in `~/.velta-kmp/accounts`):

```sh
export VELTA_KMP_RPC_SERVER=/path/to/deltachat-rpc-server   # any recent build
./gradlew :composeApp:run
```

Sign in with a throwaway account — the P1 flow is add account → add
transport → configure → start io → chat list → chat view (read-only).
