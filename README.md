# Velta

A cross-platform **Delta Chat** client experiment built as a single PWA-ish web app wrapped by **Tauri 2**.

> ⚠️ **Status: Proof-of-Concept / 100% vibecoded**
>
> This project was built almost entirely through vibe-coding and iterative fixes. It is **not production-ready**: expect rough edges, incomplete features, and bugs. Treat it as a learning/demo project rather than a stable messenger.

## What it is

Velta shares one web frontend (`app/`) between:

- **Windows desktop** — a Tauri 2 app that bundles `deltachat-rpc-server.exe` as a sidecar.
- **Android mobile** — the same Tauri 2 app, but the Delta Chat core runs in-process inside the APK.
- **Browser/PWA** — the same frontend can be served statically and connects to a local `delta-core-service` over loopback WebSocket/HTTP, or falls back to a mock core for demo purposes.

The UI is plain HTML/CSS/ES modules (no bundler). The backend is the upstream [Delta Chat core](https://github.com/chatmail/core) at version `2.59.0`.

## Project layout

```
.
├── app/                        # Velta web frontend (vanilla JS, no build)
├── delta-web-app/              # Tauri 2 wrapper for Windows + Android
│   └── src-tauri/
│       ├── Cargo.toml          # Rust crate + deltachat-jsonrpc dependency
│       ├── tauri.conf.json     # shared Tauri config
│       ├── tauri.android.conf.json
│       ├── tauri.ios.conf.json
│       └── src/
│           ├── lib.rs          # sidecar + Android in-process core glue
│           └── main.rs         # Tauri entry point
├── delta-core-service/         # Android background-service skeleton (JNI + WS bridge)
├── deltachat-backend/            # Prebuilt deltachat-rpc-server binaries
│   ├── windows-x86_64/
│   └── android-arm64/
└── core/                       # Vendored Delta Chat core Rust workspace
```

## Requirements

- Rust **1.89+**
- Node.js **22+** (only for the Tauri tooling)
- `cargo-tauri` v2

```bash
cargo install tauri-cli --version "^2.0" --locked
```

### Windows build

- Windows 10/11
- For building the sidecar from source: Perl + NASM (needed by vendored OpenSSL in `rusqlite`).

### Android build

- Android SDK + NDK r27 (e.g. `ndk;27.2.12479018`)
- JDK 17
- Targets installed via rustup:
  `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`

## Build locally

### Windows installer

Build the sidecar first:

```bash
cd core
cargo build -p deltachat-rpc-server --release
```

Stage it for Tauri:

```powershell
New-Item -ItemType Directory -Force -Path "delta-web-app/src-tauri/binaries"
Copy-Item "core/target/release/deltachat-rpc-server.exe" `
  "delta-web-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe"
```

Then build the installer:

```bash
cd delta-web-app
cargo tauri build
```

Output:

- `delta-web-app/src-tauri/target/release/bundle/msi/*.msi`
- `delta-web-app/src-tauri/target/release/bundle/nsis/*.exe`

### Android APK

```bash
cd delta-web-app
cargo tauri android build --apk
```

The unsigned APK will be in:

```
delta-web-app/src-tauri/gen/android/app/build/outputs/apk/universal/release/
```

To sign it locally:

```bash
keytool -genkey -v -keystore velta-debug.keystore -alias velta \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass velta123 -keypass velta123 -dname "CN=Velta"

zipalign -p -f 4 app-universal-release-unsigned.apk app-universal-release-zipaligned.apk

apksigner sign --ks velta-debug.keystore \
  --ks-pass pass:velta123 --key-pass pass:velta123 \
  --out app-universal-release-signed.apk \
  app-universal-release-zipaligned.apk
```

## GitHub Actions

Pre-configured workflows live in `.github/workflows/`:

| Workflow | What it builds |
|---|---|
| `build-android.yml` | Universal Android APK on `ubuntu-latest` |
| `build-windows.yml` | Windows installer on `windows-latest`, compiling the sidecar natively (needs Perl + NASM) |
| `build-windows-cross.yml` | Windows installer where the sidecar is cross-compiled on Ubuntu to avoid installing Perl/NASM on Windows |

The Android and cross-compiled Windows workflows are the easiest starting points if you just want an artifact.

## Known limitations

- This is a **PoC**. Group creation, contact discovery, QR invites, and real-time message rendering all work in basic flows but have not been stress-tested.
- The app icon and adaptive Android icon may need further polishing.
- Logging to `velta.log` is disabled in the stable branch; use the status pill and browser/Tauri dev tools to diagnose issues.
- On Windows, the app needs the sidecar binary to talk to the real core. If the sidecar fails to start the frontend falls back to the mock core.
- On Android, the app currently uses the in-process core inside the Tauri APK. A separate background-service variant (`delta-core-service/`) is only a skeleton.

## License

See [`LICENSE`](LICENSE).
