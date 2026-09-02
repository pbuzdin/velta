# Velta — Agent Guide

This document is written for AI coding agents that need to work on the Velta
project. Read it first. It describes the repository layout, technology stack,
build/test commands, and conventions as they actually exist in this checkout.

> **Scope note:** This repository is a Velta-specific workspace layered around a
> copy of the upstream [Delta Chat core](https://github.com/chatmail/core)
> (version `2.59.0`). The `core/` directory is effectively a vendored copy of
> that Rust project. Wrapper code for Velta's own clients lives in `app/`,
> `delta-web-app/`, `delta-core-service/`, and `deltachat-backend/`.

---

## 1. Project overview

**Velta** is a cross-platform Delta Chat client built as a Progressive Web App
(PWA) that can be hosted in several shells:

- **Tauri desktop/Android app** (`delta-web-app/`) — the web UI is embedded in a
  system WebView and the Delta Chat Rust core is linked in-process.
- **Background Android service** (`delta-core-service/`) — a headless APK that runs
  the core as a foreground service and exposes it to the PWA over a loopback
  WebSocket/HTTP bridge.
- **Standalone browser** — the PWA can be served from a static host and falls back
  to a mock core for demo/development.

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
│   │   ├── app.js            # bootstrap, chat list, navigation, modals, PWA lifecycle
│   │   ├── avatar.js         # contact avatars: fingerprint color-grid identity tiles
│   │   ├── chat-view.js      # message history, composer, selection actions
│   │   ├── components.js     # Elena-based web components (<dc-avatar>, <dc-chat-item>, <dc-chat-head>, <dc-video>)
│   │   ├── diagnostics.js    # diagnostics chat store + event sink
│   │   ├── invites.js        # invite-link registry (mirror domains), parsing, invite cards, settings modal
│   │   ├── markdown.js       # escape-first message markdown: bold/italic/underline, links, lists
│   │   ├── media.js          # media URL helpers (loopback server / asset protocol)
│   │   ├── poster.js         # lazy WebP poster extraction + disk cache
│   │   ├── mock-core.js      # in-memory demo core implementing the JSON-RPC surface
│   │   ├── rpc-core.js       # JsonRpcCore wrapper over transports + event mapping
│   │   ├── transport.js      # backend auto-detection (Tauri, WebSocket, HTTP, mock)
│   │   └── ui.js             # drawer, modals, context menus, toasts
│   ├── vendor/               # third-party frontend libraries
│   │   ├── elena.js          # lightweight web-components library
│   │   └── virtual-scroller.js
│   ├── diag.html             # connection diagnostics page for the service bridge
│   ├── index.html            # main app shell
│   ├── manifest.webmanifest  # PWA manifest (name: "Velta")
│   └── sw.js                 # app-shell service worker (CACHE constant bumped each release)
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
│   ├── Cargo.toml            # workspace manifest, version 2.59.0
│   ├── CMakeLists.txt        # CMake install wrapper for libdeltachat
│   └── deny.toml             # cargo-deny policy
│
├── delta-web-app/            # Tauri v2 wrapper
│   └── src-tauri/
│       ├── Cargo.toml        # depends on deltachat-jsonrpc (path on Android)
│       ├── tauri.conf.json   # frontendDist: ../../app, version bumped each release
│       ├── capabilities/     # Tauri v2 ACL (default.json, mobile.json)
│       ├── gen/android/      # generated Android project (cargo tauri android)
│       ├── src/
│       │   ├── lib.rs        # Windows sidecar bridge + Android in-process core
│       │   └── main.rs       # Tauri entry point
│       └── build.rs
│
├── delta-core-service/       # Android foreground-service (JNI core + loopback WS bridge)
│   ├── rust/                 # JNI crate (librpc_core.so)
│   ├── android/              # Gradle project; builds delta-core-service.apk
│   └── README.md
│
├── deltachat-backend/        # Prebuilt deltachat-rpc-server binaries
│   ├── windows-x86_64/
│   └── android-arm64/
│
├── signing/                  # local signing keystore (untracked)
└── tools/                    # icon generation + WSL APK build/sign helper scripts
```

Not tracked (local runtime/build artifacts): `accounts/` (local core account
databases), `*.apk` builds, `signing/*.keystore`.

---

## 3. Technology stack

| Layer | Technology |
|-------|------------|
| Frontend | Plain HTML/CSS/ES modules, no transpiler or bundler |
| Components | [Elena](https://github.com/elenajs/core) (`app/vendor/elena.js`) |
| Virtual list | `app/vendor/virtual-scroller.js` |
| Desktop/Android shell | Tauri v2 (`delta-web-app/src-tauri`) |
| Core runtime | Rust, Tokio async runtime, SQLite (sqlcipher) |
| Crypto | rPGP, Autocrypt, SecureJoin, TLS via rustls or native-tls |
| Networking | async-imap, async-smtp, Iroh gossip, shadowsocks proxy support |
| Core protocol | JSON-RPC 2.0 over Tauri IPC, WebSocket, HTTP, or stdio |
| Android core bridge | JNI (`delta-core-service/rust`) + foreground service |
| Python bindings | CFFI (`core/python`) and JSON-RPC (`core/deltachat-rpc-client`) |

The Rust toolchain required for the core is **1.89+** (see `core/Cargo.toml`).
Tauri (`delta-web-app`) requires Rust **1.77.2+** and Node.js **22+** (see the
README's requirements section).

---

## 4. Build and test commands

### 4.1 Core Rust library (`core/`)

```bash
cd core

# Run all Rust tests
cargo test --all

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
core unless a real backend is reachable.

To refresh the service-worker cache after editing, bump the `CACHE` constant in
`app/sw.js`.

### 4.3 Tauri desktop/Android app (`delta-web-app/`)

```bash
cd delta-web-app

# Desktop dev run
cargo tauri dev

# Build Windows installer
cargo tauri build

# Android (requires Android SDK/NDK)
cargo tauri android init
cargo tauri android dev
cargo tauri android build
```

Note: `delta-web-app/src-tauri/Cargo.toml` currently pins the core via git. For
local development against the bundled `core/`, uncomment the `path` dependency.

### 4.4 Android background service (`delta-core-service/`)

The skeleton currently contains only Cargo/Gradle manifests. To rebuild when the
source is added:

```bash
cd delta-core-service/rust
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
  1. Android WebView native bridge (`window.DcBridge`)
  2. Tauri IPC (`window.__TAURI__`)
  3. WebSocket to `ws://127.0.0.1:20808`
  4. HTTP to `http://127.0.0.1:20809/rpc`
  5. `MockCore` fallback
- `app/js/rpc-core.js` wraps any transport with a JSON-RPC client, maps core
  events to UI events, and exposes the same API surface as `mock-core.js`.
- `app/js/app.js` owns the chat list, navigation, modals, diagnostics chat, and
  the PWA shell. It also runs a DOM-budget watchdog that samples node counts.
- `app/js/chat-view.js` owns the conversation history (virtualized via
  `virtual-scroller`), composer, selection mode, and the delete-message dialog.
- `app/js/components.js` defines custom elements (`<dc-avatar>`,
  `<dc-chat-item>`, `<dc-chat-head>`, `<dc-video>`) using Elena.
- `app/js/avatar.js` derives contact identity tiles from OpenPGP fingerprints.
- `app/js/diagnostics.js` is the in-app diagnostics event store ("Velta
  Diagnostics" chat).
- `app/js/media.js` resolves local file paths to WebView-safe media URLs (loopback media server when available, asset protocol otherwise).
- `app/js/poster.js` extracts and caches WebP poster frames for video placeholders.
- `app/js/ui.js` is a collection of UI helpers (drawer, modals, context menus,
  toasts, delete-confirmation dialog).
- `app/js/mock-core.js` is a self-contained demo backend used when no real core
  is reachable (also force-selectable via `localStorage["velta-mock"] = "1"`).

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

---

## 6. Development conventions

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
  always measure the actual combination.


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

There is no automated test harness for the PWA. The primary verification path
is manual:

1. Open `app/index.html` in a browser. Force demo mode with
   `localStorage["velta-mock"] = "1"` (or the drawer's "Enter mock mode"
   toggle) to verify UI behavior without a backend; the mock ships demo chats,
   media, and a 2400-message chat for scroller testing.
2. Run a real backend (`deltachat-rpc-server`, the Tauri app, or the Android
   service) and confirm the transport switches from mock to real.
3. Use `app/diag.html` to diagnose WebSocket/HTTP connectivity to the service.

For end-to-end verification against a **real core** (message delivery,
deletion requests, SecureJoin), the setup used during development is:

1. Serve `app/` from any static server with `Cache-Control: no-store`
   (avoids stale module caching in the browser).
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
- **CSP.** The Tauri `tauri.conf.json` sets a restrictive CSP:
  `default-src 'self'; img-src 'self' data: blob: file:; style-src 'self' 'unsafe-inline'`.
  Keep it tight when adding new frontend capabilities.
- **PWA protocol handler.** `manifest.webmanifest` registers `web+dcaccount` as a
  protocol handler. Validate incoming `?qr=` parameters before passing them to
  the core.
- **Invite links.** `app/js/invites.js` parses invite links, mirrors custom hosts onto
  the canonical `https://i.delta.chat/#…` scheme the core accepts, and renders them as
  invite cards. Only links whose host is in the domain registry (drawer → "Invite link
  domains"; built-ins mirror the AndroidManifest intent filters) are treated as invites.
- **Trusted binaries.** The prebuilt `deltachat-backend/` binaries are static
  except for system libraries. If you rebuild them, prefer vendored OpenSSL and
  SQLite to minimize external runtime dependencies.
- **No unsafe code in the core.** The `deltachat` crate forbids `unsafe`; keep
  it that way.

---

## 9. Deployment and runtime architecture

### 9.1 PWA served statically

- Serve the contents of `app/` over HTTPS.
- The browser will install the service worker and cache the app shell.
- If `deltachat-rpc-server` or the Android service is running on the same
  device, the app connects over loopback WebSocket/HTTP; otherwise it falls
  back to the mock core.

### 9.2 Tauri desktop/Android app

- The Tauri Rust layer embeds `deltachat-jsonrpc` as a library and exposes two
  commands: `invoke("rpc", { request })` to call the core, and `emit("dc-rpc")`
  to push core events to the WebView.
- Account data lives in the platform app-data directory:
  - Windows: `%APPDATA%/org.deltaweb.app/accounts`
  - Android: app-private storage.

### 9.3 Android background service

- The APK has no UI; it starts a foreground service, links `librpc_core.so`,
  and optionally serves the PWA from `assets/pwa/` on `http://127.0.0.1:20809`.
- The WebSocket bridge is on `ws://127.0.0.1:20808` and supports multiple
  concurrent clients.
- Boot receiver restarts the service after reboot.

---

## 10. Quick reference for common tasks

| Task | Command |
|------|---------|
| Run core tests | `cd core && cargo test --all` |
| Run core lints | `cd core && scripts/clippy.sh && scripts/deny.sh` |
| Build core RPC server | `cd core && cargo build -p deltachat-rpc-server --release` |
| Run Tauri dev | `cd delta-web-app && cargo tauri dev` |
| Serve PWA locally | `cd app && python -m http.server 8080` |
| Diagnose service | Open `http://localhost:8080/diag.html` |
| Run Python CFFI tests | `cd core/python && pytest` |
| Run Python RPC tests | `cd core/deltachat-rpc-client && pytest` |

---

## 11. Notes for agents

- The `core/` directory is large and self-contained. If your task only touches
  Velta's frontend or wrappers, avoid changing files under `core/` unless you
  are explicitly fixing or extending the core itself.
- `delta-web-app/src-tauri` has full Rust sources plus a `gen/android` project
  generated by `cargo tauri android` — regenerated files can be large; edit
  `src/` and `tauri.conf.json` rather than `gen/` where possible.
- `delta-core-service/` is a working foreground-service APK but is secondary to
  the Tauri app; check `delta-core-service/README.md` before editing it.
- The PWA has no build pipeline. All changes to `app/` are immediately testable
  by refreshing the browser or bumping the service-worker cache in `app/sw.js`.
- Version bumps touch `delta-web-app/src-tauri/tauri.conf.json`, the
  `delta-web` package in `delta-web-app/src-tauri/Cargo.toml` (+`Cargo.lock`),
  and the `CACHE` constant in `app/sw.js`; each release commit notes both.
- When modifying the JSON-RPC API surface, remember that the PWA
  (`app/js/rpc-core.js`), the Python RPC client, and any external consumers must
  stay compatible.
