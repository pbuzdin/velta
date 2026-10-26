# Velta — Agent Guide

This document is written for AI coding agents that need to work on the Velta
project. Read it first. It describes the repository layout, technology stack,
build/test commands, and conventions as they actually exist in this checkout.

> **Scope note:** This repository is a Velta-specific workspace layered around a
> copy of the upstream [Delta Chat core](https://github.com/chatmail/core)
> (version `2.65.0`). The `core/` directory is effectively a vendored copy of
> that Rust project. Wrapper code for Velta's own clients lives in `app/`,
> `velta-app/`, and `deltachat-backend/` (plus the archived
> `archive/velta-core-service/`).

---

## 1. Project overview

**Velta** is a cross-platform Delta Chat client built as a Progressive Web App
(PWA) that can be hosted in several shells:

- **Tauri desktop/Android app** (`velta-app/`) — the web UI is embedded in a
  system WebView and the Delta Chat Rust core is linked in-process.
- **Background Android service** (`archive/velta-core-service/` (archived 2026-10-20, unmaintained, pinned to core 2.62)) — formerly a headless APK that ran
  the core as a foreground service and exposes it to the PWA over a loopback
  WebSocket bridge.
- **Standalone browser** — the wasm PWA dist (`scripts/build-pwa.mjs`) is a
  static site with the Chatmail core in a worker. Mail uses a WebSocket
  proxy on a chatmail relay; the PWA origin and the proxy host can differ
  (`docs/pwa-self-host.md`). Self-hosters clone the `pwa-dist` orphan
  branch (prebuilt + `.wasm.br`/`.gz`, force-pushed, never merged). Serving
  plain `app/` still falls back to a mock core (UI smoke test).

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
│   ├── locales/              # #129 UI packs (fr.json, ru.json): key is the English source; blank keeps English
│   ├── js/                   # application logic
│   │   ├── app.js            # bootstrap, chat list, navigation, account switcher, relay status line, multi-relay manager, modals, PWA lifecycle
│   │   ├── avatar.js         # contact avatars: fingerprint color-grid identity tiles
│   │   ├── boot-net.js       # pre-app.js error/unhandledrejection net: Diagnostics sink once app.js lives, #boot-error banner before
│   │   ├── chat-view.js      # message history, composer, selection actions, webxdc cards, bot command chips
│   │   ├── calls.js          # audio + video calls: WebRTC media + core signaling state machine, Delta Chat-style call screen (screen wake lock held from mic acquisition to releaseMedia; mic + video transceivers before offer/answer; DC data channels iceTrickling/mutedState; Android earpiece/speaker route via call_audio_* → CallAudio.kt — docs/agents/calls.md)
│   │   ├── member-list.js    # chat info member list: <velta-avatar> + name + address, live search (diacritics-insensitive), fixed-height virtual window
│   │   ├── chat-media.js     # chat info Apps/Photos/Videos/Audio/Files <details>: get_chat_media counts, lazy batched loads, virtual list/grid, search; scoped by chatId — contact profiles resolve the 1:1 chat via getChatIdByContactId and a null chatId is refused (the core reads null as ALL chats, #159)
│   │   ├── tauri.js          # the one Tauri-shell bridge: tauriInvoke()/invoke(), isTauri(), isAndroid() (case-insensitive), rustLog(); lazy lookups
│   │   ├── components.js     # Elena-based web components (<velta-avatar>, <velta-chat-item>, <velta-chat-head>, <velta-video>)
│   │   ├── diagnostics.js    # diagnostics chat store + event sink + shared console-style row renderer
│   │   ├── invites.js        # invite-link registry (mirror domains), parsing, short-link expansion, invite cards, settings modal
│   │   ├── invite-cards.js   # in-chat invite cards (chat/group/relay/WS-proxy links) + native relay-invite signup in Add account — docs/invite-cards.md
│   │   ├── icons.js          # shared inline SVG icon set (outline, stroke 2, round caps, aria-hidden); every UI icon comes from here — tests/icons.test.mjs
│   │   ├── qr-encode.js      # QR encoder with optimal numeric/alphanumeric/byte segmentation (smaller codes for every QR shown)
│   │   ├── local-chat.js     # local chat core adapter: Proxy interceptor for p2p:<peerId> chats, media transfers/progress, offline queue + auto-flush (see 5.4 / conventions)
│   │   ├── markdown.js       # escape-first message markdown: bold/italic/underline, links, lists + bot command extraction
│   │   ├── image-compress.js # outgoing photo → lossy WebP when it clearly pays (size-gated, renderer-side canvas, #81)
│   │   ├── bare-links.js     # scheme-less link detection (t.me/x, example.com) for markdown.js: TLD tiers, boundaries (#85)
│   │   ├── mentions.js       # @mentions: "@Name (XXXX)" parser (fingerprint code, rename/duplicate-proof), mentionsMe, composer member picker (listbox) — docs/mentions.md
│   │   ├── hashtags.js       # #hashtag detection for markdown.js (#134): Unicode/Cyrillic, ≥1 letter (#123 is not a tag), word-start only, ≤64 chars
│   │   ├── audio-player.js   # plain-DOM audio player (play, seek, "current / total", full width from first render) for chat bubbles + chat-info Audio rows
│   │   ├── media.js          # media URL helpers: blobfile:// protocol (boot-probed) → loopback server → asset protocol + per-element fallback
│   │   ├── p2p.js            # Local chat UI: drawer toggle, pairing, group modals (Tauri only)
│   │   ├── web-push.js       # PWA Web Push: drawer <details> switch, Notification permission, pushManager.subscribe(VAPID_KEY = notifier key, pinned to UnifiedPushService.kt), token webpush:<endpoint>|<p256dh>|<auth> → wasm set_push_device_token (all accounts), re-registered every boot; iOS 16.4+/home-screen hint (docs/agents/web-push.md)
│   │   ├── push-settings.js  # #140 Android drawer <details> "Push notifications": distributor picker/Off, relay support, last push (shell push_status/push_select/push_off → UnifiedPushBridge.kt)
│   │   ├── tunnel.js         # optional Android DNS tunnel UI: deep link, drawer row, settings sheet, diagnostics (#116/#119/#128)
│   │   ├── ws-transport.js   # WebSocket transport (Android/Windows): saved proxies, velta://ws links with signed invite tokens, settings sheet — docs/websocket-transport.md
│   │   ├── scheduled.js      # scheduled messages ("Send later"): document ops (mirrored in src-tauri scheduled_store.rs), presets, ScheduledRunner (claim → send → done; no double send) — docs/scheduled-messages.md
│   │   ├── scheduled-ui.js   # Send later sheet (presets + datetime-local), per-chat / global scheduled list, Android exact-alarm prompt
│   │   ├── recent-commands.js # #135 recent "/" bot commands popup + per-(account,chat) history, localStorage
│   │   ├── app-browser.js    # #137 attach-menu recent apps/commands + webxdc catalog mirrors (localStorage)
│   │   ├── i18n.js           # #129 UI language: English source, fr/ru packs, localStorage velta-lang
│   │   ├── read-markers.js   # manual "read up to here" markers per (account, chat), localStorage-only
│   │   ├── qr-actions.js     # QR screen logic: scan-tab/share availability, copy/share link, scanned-code classification (#37)
│   │   ├── share-in.js       # inbound share (#97): text/file payloads; invite and chat links stay on the deeplink router
│   │   ├── qr-scan.js        # code acquisition: paste or camera scan (native BarcodeDetector probed with a 2s timeout, vendored jsQR fallback (`app/vendor/jsQR.js`, minified ~131 KB, loaded on demand) — many Android WebViews ship no Shape Detection API or one whose detect() hangs)
│   │   ├── format.js         # time/size/pageBounds helpers; timeTag/stampTime emit <time datetime>; formatSplashVersion (#127)
│   │   ├── mock-core.js      # in-memory demo core implementing the JSON-RPC surface (NOT in the prod import graph: transport imports it dynamically)
│   │   ├── rpc-core.js       # JsonRpcCore wrapper over transports + event mapping
│   │   ├── velta-strings.js  # Velta wording for core device-chat texts: set_stock_strings overrides (hint 70, welcome 71, update reminder 86, donation 193) applied in init()/reconnect(); "core-welcome-image" label claimed before an account's first configure (no Delta photo). No core/ change — see docs note in §6
│   │   ├── transport.js      # backend auto-detection (Tauri, WebSocket, HTTP, mock)
│   │   ├── transport-worker-wasm.js # wasm transport: hosts the core in a module worker; memfs file passthrough (readCoreFile/readCoreFileList/writeCoreFile), single-tab Web Locks gate
│   │   ├── worker-wasm.js    # wasm worker: OPFS snapshot (memfs tree + SQLite dbs via sqlite_export/import) restored before core init (persist boot FAILS LOUDLY without OPFS — #106); numbered snap-<n> + `current` pointer written last (#123); serialized, awaited after login/restore; memfs file ops
│   │   ├── identity-backup.js # V2.5 identity backup: bundle build/wrap/unwrap (WebCrypto), base64 helpers, backup download name (#104), gzipBytes/gunzipBytes (CompressionStream — returns input unchanged when unsupported; callers detect by identity to decide the .gz suffix)
│   │   ├── ws-relays.js      # PWA websocket relay list; baked VELTA_PWA.wsProxyUrl until a domain is chosen; probeC3Relay (C3 capability probe)
│   │   ├── webxdc-manager.js # webxdc host: opaque-origin sandboxed app overlay, shim postMessage relay, per-instance serials
│   ├── webxdc-host/          # PWA webxdc host: sw-route.js (SW loader route, sandbox CSP) + frame.js (in-frame .xdc loader); KEEP rules in docs/agents/webxdc.md
│   │   ├── link-preview.js   # OG cards; drawer is off / picture / fetch (#88); shellProxy() = fail-closed proxy reader for shell-side fetches
│   │   ├── lufi.js           # #138 Lufi client logic: SJCL slice encryption (Lufi-web compatible), upload state machine, expiry rules, deletion-token store (node-tested)
│   │   ├── large-file.js     # #138 attach menu "Large file" flow: pick → expiry dialog → progress/cancel → link message; message-info delete
│   │   ├── trackers.js       # drop known tracking query params on paste and on open (#89)
│   │   ├── inapp-browser.js  # Telegram-style in-app browser overlay for message links (bar, history, JS bridge to the shell's Custom Tab)
│   │   ├── notify-policy.js  # when an already-received message may raise an OS notification (Android posts from Rust; page stays quiet there; `web` flag = PWA path: hidden or unfocused)
│   │   ├── wakelock.js       # screen wake lock for calls + QR scanning: wanters refcount, re-acquired on visibilitychange, silent no-op where unsupported (node-safe)
│   │   ├── typing.js         # composer side of the local-chat typing indicator (ping per keystroke, idle expiry)
│   │   ├── ui-scale.js       # interface scale applied pre-paint from localStorage (blocking external script, CSP-safe)
│   │   ├── version.gen.js    # generated by tools/bump.mjs — app version constant, do not hand-edit
│   │   └── ui.js             # drawer, modals, context menus, toasts
│   ├── vendor/               # third-party frontend libraries
│   │   ├── elena.js          # lightweight web-components library
│   │   └── virtual-scroller.js
│   ├── index.html            # main app shell
│   └── manifest.webmanifest  # PWA manifest (name: "Velta")
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
│   ├── Cargo.toml            # workspace manifest, version 2.65.0
│   ├── CMakeLists.txt        # CMake install wrapper for libdeltachat
│   └── deny.toml             # cargo-deny policy
│
├── velta-app/            # Tauri v2 wrapper
│   ├── soar-tunnel/          # optional DNS tunnel: Go c-shared lib + soar-socks CLI (docs/agents/dns-tunnel.md)
│   └── src-tauri/
│       ├── Cargo.toml        # depends on deltachat-jsonrpc (path on Android)
│       ├── tauri.conf.json   # frontendDist: ../../app (version mirrors Cargo.toml — Android reads only it)
│       ├── capabilities/     # Tauri v2 ACL (default.json, mobile.json)
│       ├── gen/android/      # generated Android project (cargo tauri android)
│       ├── src/
│       │   ├── lib.rs        # Windows sidecar bridge + Android in-process core
│       │   ├── p2p.rs        # Local chat engine: iroh (relay-less) QUIC pairing + 1:1 chat
│       │   ├── tunnel.rs     # Optional DNS tunnel (Android): loads libsoartunnel.so, keeps proxy_url
│       │   ├── tunnel_android.rs / tunnel_windows.rs / tunnel_store.rs # platform layers (Windows: soartunnel.dll) + several saved tunnels, one or none active
│       │   ├── ws_transport.rs # WebSocket transport: local SOCKS5 listener tunnelled over the PWA's WS proxy (invite token at the handshake), health-checked, started before IO
│       │   ├── scheduled.rs / scheduled_store.rs # scheduled messages: native store + send runner (Android alarm via ScheduledAlarm.kt)
│       │   ├── lufi.rs       # #138 Large file: proxy-aware (fail-closed) minimal WebSocket client for Lufi /upload, slice reads, config/delete
│       │   ├── bin/          # p2p-hub.rs — headless terminal hub (debug helper)
│       │   └── main.rs       # Tauri entry point
│       └── build.rs
│
├── archive/velta-core-service/ # ARCHIVED: Android foreground-service (JNI core + loopback WS bridge), core 2.62
│   ├── rust/                 # JNI crate (librpc_core.so)
│   ├── android/              # Gradle project; builds velta-core-service.apk
│   └── README.md
│
├── deltachat-backend/        # Prebuilt deltachat-rpc-server binaries
│   ├── windows-x86_64/
│   └── android-arm64/
│
├── signing/                  # local signing keystore (untracked)
├── design/                   # token snapshot of app/css/main.css (HTML + SVG); restamp header with APP_VERSION
├── docs/agents/              # per-subsystem agent notes (webxdc, relays,
│                              p2p/local chat, android-shell, media,
│                              onboarding, security-triage, large-file, calls, web-push) — referenced from §5/§11
├── docs/as-built-architecture.md # product snapshot at cd59531 (2026-10-13); no implementation plan
├── docs/web-components-audit.md  # UI semantics/a11y/progressive-rendering audit (2026-10-06)
├── docs/web-components-plan.md   # phased fix plan for that audit (quick wins → tests)
├── docs/modals-audit-and-plan.md # modal/overlay/popup inventory + native <dialog> plan
├── docs/native-elements.md       # where native HTML elements can replace custom JS/ARIA
├── docs/accessibility-and-keybindings.md # DC Desktop shortcut reference, Velta keyboard/a11y audit + plan (K1–K8, N1–N13)
├── docs/iroh-layer-plan.md        # iroh second layer over chatmail: iroh folder + chip, link protocol, dedup, calls, phases (proposal)
├── docs/research/iroh-layer-research.md # what core 2.62's iroh exposes (webxdc realtime, backup), keys, calls, upstream, wasm — file:line cites
├── PLAN-PWA-WEBSOCKET.MD         # PWA + restricted-WS-relay plan; §4b = Architecture C track (OQ-1 decided = C)
├── PLAN-UNIFIEDPUSH.MD           # Google-free background push for Android (ntfy + UnifiedPush distributor): verified core token path (push.rs → /private/devicetoken IMAP metadata), notifier-key swap, relay state, work items — issue #110
├── docs/research/wasm-core-mail-proxy-spike.md    # wasm spike log, day-by-day — status header = current state
├── docs/research/wasm-core-landing-checklist.md   # landing gate: every ⬜→✅ box; master core/ stays stock until green
├── docs/research/wasm-core-lock-landing-plan.md   # ordered review/merge steps for the core/Cargo.lock diff at landing
├── docs/pwa-self-host.md          # host your own wasm PWA; Quick start = clone branch pwa-dist; origin A + WS proxy on B
├── docs/relay-modules.md          # install / configure / uninstall: invite-only signup and the WebSocket proxy
├── docs/websocket-transport.md    # WebSocket transport for Android/Windows: velta://ws links, saved proxies, signed invites
├── docs/deploy-pwa-websocket-proxy.md / docs/deploy-dns-tunnel.md # one-command server deploy guides (tools/deploy-*.sh)
├── docs/dns-tunnel-link.md        # tunnel link v2 (QR-alphanumeric path form) + confirmation
├── docs/scheduled-messages.md     # Send later: design, Android exact/inexact alarms, Doze limits
├── docs/invite-cards.md           # invite cards in chat + relay-invite signup
├── docs/mentions.md / reply-threads.md / chat-appearance.md / settings-transfer.md # feature notes
├── docs/research/websockify-c3-deploy.md          # C3 runbook: deploy the websockify-c3 relay, verify, RELAY_WS_URL e2e
├── docs/research/ws-relay-endpoints-probe.md      # external WS endpoints vs the C3 contract — chatmail.uk /ygg-ws = Yggdrasil peering, not a mail tunnel (10-09)
├── docs/research/wasm-patches/   # 10-patch wasm series (series.txt, VENDORED.md, pinned locks + PROVENANCE)
├── packages/velta-wasm/      # MPL wasm wrapper — README = local wasm-pack build + e2e recipes
├── scripts/build-pwa.mjs         # C4 PWA dist builder (app/ + wasm assets + pwa-config.js + precache SW + wasm.br/gz sidecars not in PRECACHE); refuses a wasm without sqlite_export unless --allow-no-db-persist — §4.2.1; ship snapshot is git branch pwa-dist
├── scripts/relay-invite/         # invite-only signup: invite.py CGI (interstitial + claim) + invite-tool.py CLI + README (deploy/features/troubleshooting) — deployed to the private relay (§4.2.1 relay-list bullet)
├── scripts/verify-pwa-dist.mjs   # PWA dist rig: 10 checks (boot, OPFS persist incl. sqlite/, SW, identity-backup surface)
└── tools/                    # build-builtin-xdc.mjs (app/builtin/*.xdc from app/webxdc/*), icon generation, WSL APK build/sign helpers,
                              serve-dev.py (no-cache static server for app/)
                              bump.mjs (the one version bump), deploy-dns-tunnel.sh / deploy-ws-proxy.sh (one-command server deploys:
                              docs/deploy-dns-tunnel.md, docs/deploy-pwa-websocket-proxy.md; WS proxy has `invite NAME --uses N`, revoke)
```

Not tracked (local runtime/build artifacts): `accounts/` (local core account
databases), `*.apk` builds, `signing/*.keystore`.

### 2.1 Disk cleanup — safe-to-delete folders (10 GB+ rule)

Any folder below can hit tens of GB. When a folder in this table exceeds
**10 GB**, deleting it is always safe; it is fully regenerated by the next
build (cost: a cold rebuild):

| Folder | Typical size | Regenerated by |
|--------|--------------|----------------|
| `velta-app/src-tauri/target/` | 20–45 GB | `cargo tauri dev` / `cargo tauri build` in `velta-app/src-tauri/` |
| `core/target/` | 10–25 GB | any `cargo build`/`test` in `core/` (WSL) |
| `archive/velta-core-service/rust/target/` | ~3 GB | `cargo build` in `velta-core-service/rust/` |
| `core/target-win/` | ~2 GB | sidecar build (§4.3.3 recipe, `CARGO_TARGET_DIR=target-win`) |
| `core/target-android/` | ~0.6 GB | android cross builds (§4.3.3) |

Measured 2026-09-26: the whole Velta tree held ~43 GB of target dirs; deleting
all five reclaimed 51 GB on C: (Windows `AppData/Local/Temp` gave ~4 more) and
the next local APK build succeeded from scratch.

Never delete for space: `velta-app/src-tauri/binaries/` (Windows sidecar,
see §4.3), `deltachat-backend/` (prebuilt RPC servers), `core/test-data/`
(test fixtures), `signing/` (keystore).

> **Rebranding note:** this checkout predates the Velta rename, so older docs,
> scripts and muscle memory may reference pre-rebrand paths. The Tauri shell
> lived at `delta-web-app/src-tauri/` — that directory is GONE; the shell is
> `velta-app/src-tauri/` (this document already uses only the current names).
> Two pre-rebrand identifiers also linger on machines that ran old desktop
> builds: `%LOCALAPPDATA%/chat.delta.desktop.tauri` and `deltachat-tauri` are
> dead leftovers — current builds use `org.velta` (see §9.2). The WSL build
> sandbox `~/velta-android-build/velta-app/` (workspace scripts in the parent
> directory) was migrated from `delta-web-app/` to the current name; because
> cargo fingerprints embed absolute paths, the first build after the rename
> recompiles from scratch.

---

## 3. Technology stack

| Layer | Technology |
|-------|------------|
| Frontend | Plain HTML/CSS/ES modules, no transpiler or bundler |
| Components | [Elena](https://github.com/arielsalminen/elena) (`@elenajs/core` v1.0.1, vendored as `app/vendor/elena.js`) |
| Virtual list | [virtual-scroller](https://github.com/catamphetamine/virtual-scroller) (`virtual-scroller-dom` build, vendored as `app/vendor/virtual-scroller.js`) |
| Desktop/Android shell | [Tauri v2](https://github.com/tauri-apps/tauri) (`velta-app/src-tauri`) |
| Core runtime | Rust, Tokio async runtime, SQLite (sqlcipher) |
| Crypto | rPGP, Autocrypt, SecureJoin, TLS via rustls or native-tls |
| Networking | async-imap, async-smtp, Iroh gossip, shadowsocks proxy support |
| Core protocol | JSON-RPC 2.0 over Tauri IPC, WebSocket, HTTP, or stdio |
| Android core bridge (archived) | JNI (`archive/velta-core-service/rust`) + foreground service |
| Python bindings | CFFI (`core/python`) and JSON-RPC (`core/deltachat-rpc-client`) |

The Rust toolchain required for the core is **1.89+** (see `core/Cargo.toml`).
Tauri (`velta-app`) requires Rust **1.77.2+** and Node.js **22+** (see the
README's requirements section).

---

## 4. Build and test commands

### 4.1 Core Rust library (`core/`)

```bash
cd core   # run from WSL — native Windows cargo fails in openssl-sys (SQLCipher)
```

> **Core 2.64.0 (2026-10-20) — one-way DB migration 169** (`smtp_failure`
> table). Once an account database has been opened by a 2.64 build it can no
> longer be opened by an older Velta (≤ the last 2.63 build): there is no
> downgrade. Tell testers to **make a backup (Settings → backup / identity
> export) before installing the first 2.64 build**, and do not side-load an
> older APK/desktop build over a 2.64 profile.

KEEP (local patches) — **every change inside `core/` MUST be an op in the
quilt `tools/apply-core-patches.py`** (anchor + marker ops; never hand-edit
`core/`, never apply the wasm series in `docs/research/wasm-patches/` to
production `core/`). The 2.63.0 re-vendor (2aac743) silently dropped two
hand-made core edits that were never quilt ops (#12, #13 below); v1.4.64
shipped without them. Restored 2026-10-10. Current quilt at core 2.65.0 (40 ops, 10 files;
intent in VENDORISSUES.MD):

| # | What | Files |
|---|------|-------|
| #7 | animated WebP byte-exact — RETIRED at 2.63.0 (upstream #8777) | — |
| #10 | SMTP loop's bound transport → `smtp-via` in the connectivity HTML (#79) | smtp.rs, scheduler.rs, scheduler/connectivity.rs, smtp_tests.rs |
| #11 | "Use for sending" pin: `ui.velta.send_transport` first, upstream recency failover, 5-min dead-pin backoff; since 2.64 a server-rejected send (upstream `smtp_failure`) backs the pin off too, so upstream's fallback wins until the backoff expires / the pin connects / a send on it succeeds | smtp.rs, smtp_tests.rs |
| #12 | `background_fetch` 10 s bound + I/O restart for dead IDLE sockets (#42/#25 P8) | context.rs |
| #13 | push-token accepted/rejected Info/Warning events (Diagnostics chat) | imap.rs |
| #14 | reply-thread queries: `chat::get_reply_counts(chat)` (quoted msg → count, both sides scoped to the chat) + `get_reply_ids(chat, msg)` over `msgs.mime_in_reply_to`, hidden rows excluded (`replies.hidden=0`, 1.4.84: send_edit_request's own hidden copy quotes the original, so an edited caption counted as a reply); thin jsonrpc wrappers. 2 ops; the chat.rs op anchors on the `/// Returns true if device message…` doc line so that comment stays on `was_device_msg_ever_added`. No index/migration (per-chat scan via the chat_id index; a dbversion bump would collide with upstream migrations) | chat.rs, deltachat-jsonrpc/src/api.rs |
| #15 | `get_server_metadata` RPC: per-transport relay capabilities (TURN/calls, iroh relay, push, app versions) from IMAP METADATA the scheduler already fetches. 6 ops | transport.rs, deltachat-jsonrpc api.rs + types/login_param.rs |
| #17 | jsonrpc `maybe_network` clones the contexts under `accounts.read()` and awaits scheduler interrupts AFTER releasing it (#175, 1.4.85): a queued `start_io`/`stop_io` writer behind a stuck IO restart (dead proxy, up to 30 s per task) blocked every UI RPC, so chat switching "did nothing" on Android after a send. `tunnel_android::maybe_network` does the same | deltachat-jsonrpc/src/api.rs |
| #16 | extends #15 (ops must stay after it): IMAP IDLE, COMPRESS=DEFLATE, and max SMTP recipients on that metadata. UI: D flag ("not known yet" until the relay has connected), recipient limit and "compressed connection" in the details line. 8 ops | imap.rs, transport.rs, api.rs, login_param.rs |

```bash
python3 tools/apply-core-patches.py apply        # re-insert missing ops (fails, writes nothing, on a moved anchor)
python3 tools/apply-core-patches.py verify       # every op's marker present, else exit 1
python3 tools/apply-core-patches.py tree-check --fetch   # pristine upstream tag + quilt == core/, else exit 1
python3 tools/apply-core-patches.py self-test    # the tool's own tests
```

`verify` fails on ANY missing marker (it used to skip an op whose marker
and anchor were both gone and still print "N/N"). `tree-check` downloads
the upstream tag matching `core/Cargo.toml`, applies the quilt to it and
compares the whole tree (git-ignored paths skipped; CRLF/LF-only
differences tolerated outside `test-data/`): undeclared edits, drift in a
quilt file, extra or missing files all fail. CI: `.github/workflows/
core-patches.yml` runs self-test + verify + tree-check, the quilt/pin node
tests, then rustfmt, `cargo check` and the patched modules' nextest
(smtp/scheduler/connectivity/context/imap) on every push/PR touching
`core/**`, the tool, or rpc-core.js. COREUPDATE.md §0 has the re-vendor
steps. What the #10 exposure buys (docs/agents/relays.md has the
mechanics): the relay line's envelope + send dashes key to the transport
the SMTP loop is ACTUALLY bound to, through core rotations and failovers
(2.63: #8797 transport_id reset + #8771 most-recently-successful first),
and diagnostics tag the send line "(failover)" when it differs from the
pin. #11 semantics (pin, backoff, From before/after upstream #8711,
migration from configured_addr): docs/agents/relays.md "Sending relay".
The wasm patch series has no #10/#11 equivalent (quilt-refreshed for 2.63
in #112) — the PWA falls back to the configured address.

```bash
# Run all Rust tests; use nextest — plain `cargo test` flakes a varying
# set of ~4 time-shift tests per run (see COREUPDATE.md §4)
cargo nextest run --workspace --locked

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
core unless a real backend is reachable. That also makes it the fastest
renderer smoke test: serve `app/` over plain http, and full UI flows are
drivable in demo mode (no Tauri build needed). The wasm mail dist is
§4.2.1; self-hosting it is `docs/pwa-self-host.md`. Demo mode here is
only the UI smoke test. **KEEP:** every new
`rpc-core.js` method needs a `mock-core.js` counterpart or demo mode throws
"not a function" the moment the UI touches it. Demo honesty (1.4.52, #53; demo image attachments are SVG data URIs pinned by `tests/mock-images.test.mjs` — #74;
MDN arrival added 1.4.53, #59): MockCore never *invents* read receipts —
own messages rest at `delivered` (1:1 fixture history reads as `read`), the
double tick needs an MDN, and a 1:1 peer returns one a few seconds after a
send (groups never do) — and `sendMessage`/`resendMessage` emit
`send-activity` like the real core so the relay line dashes and detail-chip
envelope work in the demo (demo *mode* itself still suppresses both marks:
no relay configured, nothing sends through one).

The service worker was dead by design for the plain `app/` tree and stays
dead there: boot unregisters every registration (app.js, near the PWA
comment — cache-first SWs kept serving stale JS across upgrades), and
`app/sw.js` shipped dead weight for years before deletion (#48). The C4 PWA
**dist** is the exception: it generates its own versioned precache SW
(`scripts/build-pwa.mjs`), and boot's unregister sweep skips the dist
(`window.VELTA_PWA` gate) — there the SW is the update mechanism, not a
staleness hazard. Don't re-introduce a SW into `app/` itself.
Startup script loads (#48): `ui-scale.js` and
`boot-net.js` stay parser-blocking on purpose (pre-paint scale, early error
banner); `vendor/virtual-scroller.js` is `defer` — module scripts run after
deferred scripts, so the global class exists before `new VirtualScroller`.
`mock-core.js` must stay out of the prod import graph: transport dynamic-
imports the demo core, and prod modules take the shared helpers from
`format.js` (mock-core re-exports them for demo mode and tests).

### 4.2.1 PWA dist (Architecture C) — build + verify

```bash
# wasm core assets: a CI artifact from a "wasm-core (opt-in)" run AFTER
# 643ee36 (it does not run on master pushes — dispatch it), or wasm-pack
# (packages/velta-wasm/README.md), into build/wasm-dist
gh run download <run-id> -n wasm-dist-no-opt -D build/wasm-dist
grep -c sqlite_export build/wasm-dist/velta_wasm.js   # must be > 0
# build the deployable dist → build/dist-pwa (refuses a wasm without
# sqlite_export; --allow-no-db-persist only for throwaway dists)
node scripts/build-pwa.mjs [--ws-proxy wss://host/path] [--wasm-opt [BIN]]
# verify in a real browser (10 checks; bundled chromium, then msedge/chrome)
node scripts/verify-pwa-dist.mjs
```

Self-host (any HTTPS origin, including a PWA on domain A talking to a
WebSocket proxy on domain B): `docs/pwa-self-host.md`. Quick start is
`git clone --depth 1 --branch pwa-dist` — that branch is an orphan
snapshot of `build/dist-pwa` (wasm-opt + `.wasm.br`/`.wasm.gz`, empty
`wsProxyUrl`) and is **force-pushed**, never merged into master. The
builder writes the sidecars and keeps them out of the SW precache
(`scripts/build-pwa.mjs`). Refresh the branch after a dist rebuild:
orphan commit of the dist tree, `git push --force origin HEAD:pwa-dist`.

Deploy-dist rules (10-09):
- Relay deploys build with NO `--ws-proxy` — the deployed `pwa-config.js`
  must keep `wsProxyUrl: ""` (private relay domains never ride the artifact;
  users add relays via the WS-relays flow).
- `--wasm-opt` needs a real `wasm-opt` executable; if none is installed,
  optimize the wrapper build in place first (binaryen npm ships a node
  script, not an exe):
  `npm i --prefix tools/binaryen binaryen` →
  `node tools/binaryen/node_modules/binaryen/bin/wasm-opt -Os
  build/wasm-dist/velta_wasm_bg.wasm -o <same file>` → then build
  WITHOUT the flag so the SW content hash covers the optimized bytes
  (28.4 → 17.7 MB on 1.4.62's wasm; 28.7 → 16.8 MB on the 2.63 wasm
  deployed 2026-10-14, SW `velta-pwa-3b497112c3bd`; 28.7 → 17.6 MB for
  1.4.70, deployed 2026-10-15, SW `velta-pwa-229af68c1333`).
- Deploy steps (10-13): wasm with `sqlite_*` → optimize → move
  `app/.mimosa` and `app/js/.mimosa` out → build (no `--ws-proxy`) →
  verify-pwa-dist (10 PASS) → upload the WHOLE dist including `sw.js` →
  check the served `sw.js` VERSION changed. Clients pick it up on the next
  load or foreground (`reg.update()`); a page that was already open gets
  the "Velta was updated" toast and runs the new files after one reload.
  Profiles created on dists before 643ee36 never had their dc.db saved —
  recreate or identity-restore them once.

Detection is runtime-only — `app.js` is shared by all three targets and
never branches at build time: `window.VELTA_PWA` exists ONLY in the dist
(builder-generated `pwa-config.js`), `window.__TAURI__` / `window.VeltaBridge`
mark the shells. Defense in depth: the worker-wasm transport attempt also
requires `!VeltaBridge && !__TAURI__`, so a dist accidentally served inside
Tauri still can't take over the transport. Gotchas (spike Day 19):
- 10-17: the wrapper is `packages/velta-wasm` (crate `velta-wasm`, glue
  `velta_wasm.js` / `velta_wasm_bg.wasm`; was `deltachat-wasm`). The glue
  loads its .wasm by its own built-in name, so an older `wasm-dist-no-opt`
  artifact cannot be renamed into shape — `build-pwa.mjs` refuses
  `deltachat_wasm.*`; build from a wasm-core (opt-in) run on/after the
  rename. The live dist and the `pwa-dist` branch still carry the old names
  until the next deploy; the SW VERSION hash covers file names, so that
  deploy precaches the new files and drops the old cache. Delete the stale
  `wasm/deltachat_wasm*` files from the host after uploading.
- CI artifacts from runs that predate the Day-16 push (865a9d34) lack the
  module-level `vfs_*` exports → OPFS persistence silently no-ops (worker
  checkpoint errors are swallowed). Check `grep -c vfs_list
  build/wasm-dist/velta_wasm.js` before building a dist on an artifact.
  Run timestamps are UTC, commit times +0300 — compare carefully.
  Since #106 (7c68ffd3) a persist-build worker REFUSES to answer RPC when
  OPFS is unavailable (boot-error, no silent empty boot → no stray account),
  and `checkpoint()` stages the snapshot in memory first; a mid-walk throw
  writes nothing. Since #123 (643ee36) each checkpoint writes a NEW
  `snap-<n>/{accounts,sqlite}` and flips the `current` file last; older
  generations (and the pre-643ee36 single `accounts/` tree, still restored
  when `current` is missing) are removed only after the flip, and an
  unchanged snapshot (sha256 digest) is skipped. One snapshot at a time
  (`checkpointChain`). The transport awaits a checkpoint after `init()`,
  `configureWithCredentials` / `configureWithQr`, and identity restore
  awaits one before its reload (#126); it also checkpoints on
  `visibilitychange` → hidden, which is safe now that a cut-off write is
  ignored. `acquireWasmLock` retries
  `velta-wasm-core` for 1.5s so the dying page is not treated as a second
  tab. A tab that still holds the lock after that fails, and createCore can
  still land in the demo. A crash can drop the tail since the last snapshot.
  Pinned by `tests/wasm-boot-order.test.mjs`, `tests/wasm-session.test.mjs`,
  `tests/wasm-opfs-snapshot.test.mjs` and `tests/pwa-update-and-restore.test.mjs`.
- The verify rig's static server serves the dist from memory on purpose:
  per-request reads of the 28 MB wasm flaked connections under the SW-install
  burst (install fails → registration goes redundant).
- If a SW check shows a full precache cache but `getRegistrations()` = 0,
  something is UNREGISTERING the worker (that's how the #48 boot sweep bug
  surfaced) — don't chase fetch flakes first.

Web Push in that dist (`tests/web-push.test.mjs`, docs/agents/web-push.md):
the generated sw.js has `push` (generic "New message", tag `velta-push`,
skipped while a window is focused+visible) and `pushsubscriptionchange`
(re-subscribe, then `velta-push-subscription-changed` to pages). The token
reaches the core via the velta-wasm export `set_push_device_token` (wrapper
crate, not a core patch); the core holds it in memory, so app.js re-registers
on every boot. Keep `VAPID_KEY` in web-push.js equal to UnifiedPushService.kt.

Wasm mail in that dist (`tests/ws-relays.test.mjs`, `tests/wasm-blob-url.test.mjs`):

- **Relay list.** `wsProxyUrl()` in `app/js/ws-relays.js` is the tunnel base
  passed to the worker-wasm core. An untouched install returns the baked
  `window.VELTA_PWA.wsProxyUrl` and writes nothing. After a change the URL
  is `wss://<host>` (`localStorage` `velta-ws-relays` / `velta-ws-relay`).
  The last domain cannot be removed. With nothing stored and an empty
  baked URL, the page hostname is the tunnel (a dev `localhost` stays
  proxy-less). Use, editing the in-use host, or removing it reloads
  after 400 ms — the core reads the proxy once.
  Splash "WebSocket relays" and the drawer item exist only outside Tauri
  and VeltaBridge, and only when `VELTA_PWA.wasmCore` or
  `localStorage velta-wasm===1`. Create-account prefills `activeWsRelay()`.
  Hostnames need a dot; schemes, paths, and `:port` are stripped. The dist
  CSP `connect-src` adds `https:` and `wss:` plus the baked URL. Another
  relay must allow this page's Origin. Placeholders stay `relay.example.org`.
- **Account creation is C3-gated (10-09).** All three create paths (splash
  form, profile-modal add, deeplink new-profile) run
  `ensureMailTunnelForLink(link)` first — PWA only (`VELTA_PWA.wasmCore`),
  never the shells/mock. It probes `wss://<host>/dns/<host>`
  (`probeC3Relay`, ws-relays.js): a capable relay answers its own name with
  a NON-EMPTY JSON IP array; 404 (stock chatmail), origin-gate 403, HTML,
  or silence means that host has no tunnel. If the active tunnel resolves
  the host (`probeDnsVia`), create-account stays on it and does not
  reload. The wasm worker rewrites `POST https://<host>/new` to same-origin
  `/cm-new/<host>` because stock chatmail sends no CORS header. Autopick
  first resolves `example.com` through the active tunnel and refuses a
  tunnel that only answers its own name. Capable-but-not-active →
  `addWsRelay`+`useWsRelay`+stash the link in `sessionStorage
  velta-pending-add`+reload; boot resumes the create after the
  notifications block (stash removed before use — no reload loops). Note:
  adding a relay to an EXISTING profile (`addRelayFlow`) is not gated —
  multi-transport mail in wasm still rides the single active tunnel, a
  deeper design question. The probe runbook + chatmail.uk verdict:
  docs/research/ws-relay-endpoints-probe.md.
- **Invite-only account creation (R1/V2 v1, 10-09).** Open signup is
  CLOSED on the private relay: nginx `/new` + `/cgi-bin/newemail.py`
  return 403; the only path is an invite link `https://<relay>/i/<token>`.
  Relay pieces live in `scripts/relay-invite/` (deployed to the box:
  `/usr/lib/cgi-bin/invite.py` + `/root/relay/invite-tool.py`, store
  `/var/lib/velta-invites/invites.json` root:www-data **0660** — the claim
  CGI must WRITE the decrement; `invite-tool save()` has to chown the
  tmp file or every mint flips it root:root and all claims 502). Flow:
  interstitial GET `/i/<token>` → same-origin PWA link
  `/app/index.html#/join?t=<token>` → `createAccountFromRelayInvite` →
  GET `/i/claim?t=` (fcgiwrap 502s request BODIES on this box — do not
  "fix" it back to POST) → flock'd atomic single-use consume →
  `configureWithCredentials`. Claimed credentials park in
  `sessionStorage velta-invite-creds` (30 min) so a configure failure
  retries without burning a second invite; tunnel-switch reload resumes
  via `velta-pending-invite`. Minting (on the box, root):
  `python3 /root/relay/invite-tool.py add [uses] [days] [note]` prints
  the link; `list` / `revoke <token|url>`. Known simplifications vs the
  plan: raw token rides URLs (it IS the invite secret), no AEAD tickets,
  CLI minting instead of admin endpoints, no client-URL redirect dance
  (PWA is same-origin). PWA-only claim path; native clients get set up
  via dclogin: links from the operator.
- **Relay ops: checking outbound port 25 — the naive probe LIES.** A bare
  `/dev/tcp/host/25` + `head -c 80` waits for exactly 80 bytes; SMTP
  greetings are shorter, so a fully WORKING port reads as "blocked"
  (cost us a false diagnosis on 10-09). Ground truth, in order:
  1. Read ONE greeting line with its own timeout:
     `timeout 10 bash -c 'exec 3<>/dev/tcp/mx.google.com/25; timeout 5 head -1 <&3'`
     → `220 … ESMTP` = open. TCP connects but no banner = reachable yet
     tarpitted — Yandex-class receivers silently stall sources whose PTR
     is missing or mismatches the HELO name (fix rDNS at the hoster, not
     the firewall).
  2. Doubt the network path? tcpdump the SYN while probing — SYN out +
     SYN-ACK back means the path is fine and the problem is SMTP-level.
  3. Postfix's verdict lives in mail.log as
     `proxy-reject: END-OF-MESSAGE: 451 …` with `sasl_username=` proving
     the client auth was fine. mail.log uses ISO timestamps
     (`2026-10-09T14:35:56`) — grep those, NOT syslog `Oct  9` form.
  Status 10-09: outbound 25 unblocked (gmail banner 220 ✓), PTR still the
  default-pool name → tarpitted by strict receivers, queue waiting on the
  rDNS fix.
- **The logged IP is the DNS answer, printed before connect.** On wasm the
  dial is `wss://<proxy>/tcp/<ip>/993` (465 for submission, 443 for the
  autopick probe). The bridge dials that address. `/dns/<mail-domain>`
  stays `["127.0.0.1"]` so this relay's own mail does not hairpin through
  a public address; any other name is its public addresses. Private
  addresses are refused, except `127.0.0.1` on 443, 465, and 993.
  `/imap` and `/smtp` stay pinned to local mail. An old `dns_cache` entry
  can still name a previous address; fresh results come first.
  Runbook: `docs/research/websockify-c3-deploy.md`.
- **Close code 1005 is the socket shutting down.** `ws_stream_wasm` calls
  `WebSocket.close()` with no code. websockify answers that empty close
  with status 1005, which is reserved. Chrome logs "Received a broken close
  frame containing a reserved status code." A close that sends 1000 is
  answered 1000. The line is not a failed dial.
- **Account blobs and the worker version.** Wasm keeps blobs in memfs. A
  raw `/accounts/...` URL is requested from the site root and 404s.
  `fileUrl` / `mediaFallbackUrl` return `{base}blob?p=<encoded path>` only
  for `/accounts/` paths without `..`, and only when `wasmBlobs()` is set
  (same gate as the relay list). The dist service worker handles that GET
  by asking the controlling window (`velta-blob` MessageChannel);
  `app.js` wires the reply to `core.transport.readCoreFile`. A request
  that fires before the worker controls the page hits the origin and can
  be cached as a 404. `sw.js` is not precached. Its cache name is
  `velta-pwa-<12 hex>`: sha256 of each precache path plus that file's
  sha256, in precache order. Activate deletes every other cache name, so
  a redeploy must rewrite `VERSION` or browsers keep the old shell.
  Assets are cache-first from the worker's own VERSION cache; navigations
  are network-first (see "SW updates" below).
  Registration is `{ updateViaCache: 'none' }`. The drawer
  `[data-v="sw"]` matches `velta-vNN` and `velta-pwa-<12 hex>` and paints
  again on `navigator.serviceWorker.ready` (the drawer is built before the
  cache exists). `app/diag.html` still parses only `velta-v\d+`.
- **OPFS snapshot layout (#123/#126, 10-13).** SQLite does NOT live in the
  memfs: rusqlite on wasm32 keeps every db in sqlite-wasm-rs's memory VFS,
  so the old memfs-only snapshot saved accounts.toml and never dc.db (every
  reload = unconfigured profile). The wrapper exports `sqlite_list` /
  `sqlite_export` / `sqlite_import`; the worker writes
  `snap-<n>/{accounts,sqlite}` and flips the `current` file last, pruning
  older generations only after the flip (a reload mid-write keeps the last
  complete one; legacy `accounts/` is still restored). `build-pwa.mjs`
  refuses a wasm without `sqlite_export` (`--allow-no-db-persist` to
  override). The transport checkpoints on `visibilitychange` → hidden;
  identity restore awaits a checkpoint before its reload. `read-file`
  falls back to `sqlite_export`, so the backup password fallback can read
  dc.db.
- **Saves that must survive a reload (PWA avatar loss, 10-15).** Blob dirs
  ARE in the snapshot (`snap-<n>/accounts/<uuid>/dc.db-blobs/`); the avatar
  was lost because nothing saved it before the user reloaded: the 8 s
  interval and the hide flush lose any change made a few seconds before a
  reload (page cannot await OPFS while unloading). `JsonRpcCore._persist()`
  awaits a checkpoint after `setAvatar` / `setDisplayName` /
  `setSelfStatus` / `setChatImage`, and starts one (not awaited) after a
  `sendMessage` with a file. Add it to any new "user expects this to stick"
  write. KEEP the snapshot order databases → memfs walk: `vfs_list` is async
  and the core runs between awaits; it writes a blob before the row naming
  it, so dbs-first can only add orphan blobs, never a `selfavatar` /
  attachment row pointing at a missing file (the old order did — avatar
  broken after reload and `build_avatar_file` failing, so no
  Chat-User-Avatar went out). The core's own avatar path (copy → recode via
  the image crate → blobdir) works in wasm (a 4000×3000 JPEG recodes in
  ~1.3 s). `/uploads/` is outside the snapshot; `dropUpload` frees the
  picked temp file after `set_config selfavatar` / `set_chat_profile_image`
  via the worker's `remove-file` (only `/uploads/<name>`). Sent-file
  uploads are not dropped yet. `tests/wasm-blob-persist.test.mjs`,
  `tests/wasm-opfs-snapshot.test.mjs`.
- **SW updates (10-13).** Install precaches with `cache: 'reload'` (a host
  with max-age otherwise filled the new VERSION with old files — reproduced
  headless); navigations are network-first with the precached
  `index.html` as the offline fallback; pwa-config calls `reg.update()` when
  the page becomes visible and fires `velta-sw-updated` (app toast) when a
  new worker takes over an open page.
- **Identity backup password.** `mailLoginForBackup` prefers
  `listTransports()` (`password`, else `imap.password`, else `imap_password`)
  for the sending address when that row has a password, else the first row
  that has both. If the RPC list has none, it reads the selected account dir
  from `/accounts/accounts.toml` and that account's `dc.db` text only.
  No password still throws "not configured yet". Core 2.63 does not write
  `mail_pw`. Pinned by `tests/identity-backup.test.mjs`.

### 4.3 Tauri desktop/Android app (`velta-app/`)

```bash
cd velta-app

# Desktop dev run
cargo tauri dev

# Build Windows installer
cargo tauri build

# Android (requires Android SDK/NDK)
cargo tauri android init
cargo tauri android dev
cargo tauri android build
```

KEEP (asset staleness trap): the debug exe embeds `app/` at compile time via
`generate_context!`, and neither `touch tauri.conf.json` nor
`touch src/lib.rs` reliably re-embeds changed renderer assets — after
editing `app/`, force the rebuild with `cargo clean -p velta-app` before
`cargo tauri build --debug --no-bundle`, then relaunch. Verify from the
running app with `fetch('js/mock-core.js', {cache:'reload'})` (paths are
relative to the `tauri.localhost` root — `fetch('mock-core.js')` 404s and
fakes a "stale build" verdict). The running exe serves `http://tauri.localhost`
embedded assets only — a leftover static dev server on the devUrl port
(1430) is NEVER consulted by current binaries; a stale module + fresh bytes
confusion means the page is loading embedded assets, not your server.

Desktop `cargo check`/`build` of this crate runs **natively on Windows only** —
the WSL sandbox lacks the GTK/gobject dev libraries (pkg-config `gobject-2.0`
failure); see §11 "Build environment".

**Never build the Android APK with `velta-app/src-tauri/binaries/` present.**
That directory holds the Windows sidecar staged for the desktop installer
(README "Build locally"); `tauri.conf.json` lists it under `bundle.resources`,
and Tauri packages resources verbatim into every target — including the APK's
`assets/` (+22 MB of useless Windows PE; 68 MB APK instead of ~45 MB). The
`tools/wsl-android-build*.sh` scripts delete the directory as a guard; if you
build by hand, remove it first.

**Capabilities need explicit `platforms` scoping.** A capabilities file
without a `platforms` field applies to ALL platforms, and tauri-build
validates each capability's permissions against the plugin manifests of the
target being built — `updater:default`/`process:allow-restart` live in
desktop-only dependency crates, so the Android build died with
"Permission updater:default not found" (cost the first v1.4.20 release run).
**fs plugin access is scope-gated (V-07/#65):** the capability files carry
`fs:default` + `fs:allow-read-file`/`fs:allow-write-file` +
`fs:scope-applocaldata-recursive` — NO `fs:read-all`/`fs:write-all`. The
only arbitrary-path reads are user dialog picks; the renderer must call
`allow_picked_path` (lib.rs) right after a pick to add that path to the
plugin's runtime scope (`tauri_plugin_fs::FsExt`). Writes go exclusively to
`resolve_upload_path` targets under `AppLocalData/uploads/`, whose filename
argument is reduced to its final component (traversal guard). New file
flows must follow this pattern — do not re-add `*-all` permissions.
Rule: desktop-only permissions stay in a file pinned to
`"platforms": ["linux", "macOS", "windows"]` (`capabilities/default.json`),
mobile-only ones in `mobile.json` (`android`/`iOS`); shared ones may repeat
in both.

**Every capability also needs `windows` targeting.** The runtime matches a
capability against a webview label; a file without `windows` matches NONE.
Mobile rode on `default.json`'s implicit-everywhere `windows: ["main"]` until
the platforms pinning above removed it from Android — `mobile.json` then
matched no webview, every plugin command was denied ("Command
plugin:event|listen not allowed by ACL"), core init failed and the app fell
back to demo mode with no accounts (broke 1.4.21–1.4.22, fixed 67d2e0e /
v1.4.23). `mobile.json` now carries `"windows": ["main"]`. Diagnose runtime
ACL denials from the BUILD output, not the sources: read the resolved
`capabilities.json` under `target/<target>/release/build/velta-app-*/out/`
and check identifier + platforms + windows for the platform you build.

Related dead code (1.4.23 audit): `transport.js` probes
`window.VeltaBridge` for an "android-webview" transport that nothing
injects — Android has always bootstrapped through the `tauri` transport
(`event.listen` in its `setReceiver` is the first thing an ACL break
kills). Remove or wire the probe deliberately before trusting it.

**A stale desktop debug app blocks local builds.** `velta-app.exe` left
running (with its `deltachat-rpc-server.exe` sidecar) makes tauri-build fail
with "os error 32 ... used by another process" — kill both before
`cargo check`/`tauri build`.

Note: `velta-app/src-tauri/Cargo.toml` currently pins the core via git. For
local development against the bundled `core/`, uncomment the `path` dependency.

### 4.3.1 Rebuilding the Windows sidecar from the vendored core

`cargo build -p deltachat-rpc-server --release` in `core/` builds vendored
OpenSSL (rusqlite `bundled-sqlcipher-vendored-openssl` +
async-native-tls/vendored). On a stock Windows toolchain this fails twice —
both failures were hit and cost a 13-minute dead build; never repeat them:

- **Perl must be Strawberry Perl (or another full Windows perl).** Git Bash's
  bundled perl is missing core modules — OpenSSL's Configure aborts with
  `Can't locate Locale/Maketext::Simple.pm in @INC` (via `Params/Check.pm` →
  `IPC/Cmd.pm`). A portable Strawberry zip extracted to `tools/` and put
  first on `PATH` works; no installer or admin needed. The verified
  toolchain is now vendored locally (both gitignored): `tools/strawberry-perl/`
  (5.32.1.1 portable, `Locale::Maketext::Simple` confirmed present) and
  `tools/nasm/` (2.16.03). Build with
  `$env:PATH = "<repo>\tools\strawberry-perl\perl\bin;<repo>\tools\strawberry-perl\c\bin;<repo>\tools\nasm;$env:PATH"`.
  Re-extract after a checkout on a fresh machine — download the
  5.32.1.1 64bit-portable zip (the 5.38.x portable URL 404s) and the NASM
  win64 zip. See `docs/agents/release-ci.md` for the full recipe and
  incident notes.
- **NASM is needed for asm builds.** Without it, set `OPENSSL_NO_ASM=1`
  (builds fine, skips hand-tuned assembly).

Then copy `core/target/release/deltachat-rpc-server.exe` to
`velta-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe`
*and* `velta-app/src-tauri/binaries/deltachat-rpc-server.exe`, and verify the
swap by piping a `get_system_info` JSON-RPC request into the exe's stdin —
it must report the vendored core's version (v2.65.0 since the 2026-10-23
re-vendor, shipped in 1.4.79; v2.64.0 in the 2026-10-20 interim; v2.63.0 since 1.4.63; the
previous prebuilt was silently v2.59.0, which the drawer footer exposed).
`.github/workflows/build-windows.yml` does the same via
chocolatey-installed StrawberryPerl + NASM.

### 4.3.2 macOS build (test build, ad-hoc signed)

- `tauri.macos.conf.json` swaps the Windows `bundle.resources` sidecar for
  `bundle.externalBin: binaries/deltachat-rpc-server` — Tauri resolves
  `binaries/deltachat-rpc-server-<target-triple>` (or
  `-universal-apple-darwin`) at BUILD time, even for `cargo check`, and
  ships it as `Contents/MacOS/deltachat-rpc-server`. `find_sidecar` looks
  the name up per platform (`SIDECAR_NAME`). KEEP the Windows sidecar out
  of the macOS bundle and vice versa.
- `tauri-winrt-notification` MUST stay under `[target.'cfg(windows)']` —
  under the old `not(android/ios)` gate it dragged the `windows` crates
  into macOS builds, which do not compile there.
- Desktop log dir: Windows keeps `%LOCALAPPDATA%\Velta\logs`; macOS/Linux
  use `app_log_dir()` (`~/Library/Logs/org.velta`) — there is no
  LOCALAPPDATA, and the relative fallback resolved to an unwritable `/`.
- `Info.plist` (merged by tauri-build) carries the microphone/camera usage
  strings; `Entitlements.plist` grants audio-input/camera under the
  hardened runtime. A new capability that touches a TCC-protected resource
  needs both.
- Signing: `signingIdentity: "-"` (ad-hoc), no notarization — users clear
  the quarantine once (README "Install", release notes). Setting the
  `APPLE_*` secrets (Developer ID + notarytool) in `build-macos.yml` is the
  upgrade path; the env identity overrides the config.
- Updater: `latest.json` carries `darwin-aarch64` + `darwin-x86_64`, both
  pointing at the one universal `Velta_<version>_universal.app.tar.gz`.

### 4.3.3 Local Android APK builds (WSL)

`build-velta-android-wsl.sh` (workspace script in the PARENT directory,
`C:/Users/pave/Velta/`) copies the tree to `~/velta-android-build` and builds
a debug universal aarch64 APK via `cargo tauri android build`; it prints the
APK path at the end. Needs the WSL JDK/SDK/NDK paths baked into the script
and **~25 GB free on Windows C:** — the build lives inside the WSL
ext4.vhdx, which lives on C:. Check `df -h /c` before starting: WSL-side
`df` shows the vhdx's virtual size (1007G), never the Windows free space,
which is what actually limits the vhdx's growth.

Failure catalog (both hit on 2026-09-26; the fixes live in the script):

- **openssl-src `install_dev` → `make … Error 127`,
  `aarch64-linux-android-ranlib: not found`.** The NDK ships only
  `llvm-ranlib`/`llvm-ar` — no target-tripled wrappers, which is what
  openssl's install recipe invokes. The script exports `RANLIB`/`AR`
  pointing at `llvm-ranlib`/`llvm-ar` and prepends the NDK toolchain bin to
  PATH. Keep those exports when editing the script.
- **Disk full** (above): a gradle JVM fatal error mid-build plus
  `wsl -e` refusing to start (`CreateInstance E_FAIL`) both mean the vhdx
  could not grow. Free C: space first — deleting WSL-side files does NOT
  shrink the vhdx (sparse mode is refused by WSL over corruption risk), so
  the room must exist on C: before the build starts.

### 4.3.4 No Material Components in the APK (`veltaKeepMaterial`)

The Tauri APK ships without `com.google.android.material` (merged from the
tested `test/no-material` branch). In `gen/android/app/`:

- `build.gradle.kts` no longer declares `material`, and a
  `configurations.all { exclude(group = "com.google.android.material") }`
  rule strips the copy that `tauri-android`, `tauri-plugin-fs`,
  `-dialog`, `-deep-link`, `-notification` pull in transitively (library
  modules still compile against it; only the app APK drops it).
- `themes.xml` (day + night) parent `Theme.AppCompat.DayNight.NoActionBar`.
- `activity_main.xml` (unused template) is a `FrameLayout`, not
  ConstraintLayout (that came in via Material).
- Caveat: `tauri-plugin-dialog`'s `showMessageDialog`
  (`MaterialAlertDialogBuilder`) would crash. JS only uses
  `plugin:dialog|open`/`save` and capabilities grant only those; do not
  call `message`/`ask`/`confirm` from the dialog plugin on Android.
- Opt-out: `-PveltaKeepMaterial=true` keeps Material in the APK
  (e.g. to bisect a regression).
- `-PveltaAppIdSuffix=.foo` gives a local side-by-side `org.velta.foo`
  build; the default is empty, so default/release builds stay `org.velta`
  with label "Velta". CI side-by-side builds (PR #133) patch
  `applicationId`/`strings.xml` in the workflow instead: `build-android.yml`
  `workflow_dispatch` input `side_by_side` (default true for manual runs)
  builds `org.velta.test` / "Velta Test" (artifact `velta-android-test`);
  tag/release builds always stay `org.velta`. On master since PR #133.
- These files are `cargo tauri android init` output: re-running init
  reverts all of this — re-apply after any re-init.

### 4.4 Android background service (`archive/velta-core-service/`, ARCHIVED)

> Archived 2026-10-20 at Pavel's request: unmaintained, pinned to core
> v2.62.0, no CI, not part of core updates. The notes below are historical.

**Incoming-message notifications** have platform parity: Windows
`notify_incoming` renders a three-line toast (chat name / sender / text +
circular sender avatar) via `tauri-winrt-notification` directly — AUMID is
the config identifier, so toasts only resolve after one installer install
(`examples/win-toast.rs` is the manual visual check). The page requests a
toast when the window is minimized or unfocused, not only when
`document.hidden` is set — WebView2 leaves the page visible while the
window is minimized (`shouldNotifyIncoming` in `app/js/notify-policy.js`).
Android: see below.
**Incoming-message notifications (Android)** are posted only by
`bg_notify_incoming` (lib.rs) over JNI into
`gen/android/.../org/velta/Notifications.kt`: MessagingStyle conversation per
chat (group name title / sender line / plain text — never a "Group:" prefix),
sender avatar as the Person icon, chat avatar as largeIcon, follow-up
messages append to the same conversation. KEEP: the JNI signature there must
match `Notifications.show`; optional avatar paths pass as null JStrings
(`opt_jstring`); the fallback when the Kotlin side is unreachable is a plain
title/body notification. Receiver-type confusion against
`android.app.Notification.Builder` means the compat inner class did not
resolve — import `androidx.core.app.NotificationCompat.MessagingStyle`
explicitly.
**Notification taps open the chat (issue #20):** the contract is the link
`velta://chat?account=<id>&chat=<id>&t=<token>` (account 0/absent = current
profile). The token is a persistent 128-bit hex value in app-local data
(`chat-link-token`), returned by `chat_link_token`. Android:
`Notifications.show` takes that token as its last String argument (the JNI
signature must keep matching) and sets an explicit `ACTION_VIEW` content
intent with the link on `MainActivity`; tao turns VIEW data into
`RunEvent::Opened` on cold start (onCreate) and warm start (singleTask →
onNewIntent). `run()` appends every opened URL to `OPENED_URLS` and emits
`deeplink` as a wake-up only. Windows: `notify_incoming` takes `accountId`/`chatId`, appends
the same token, and the toast's `on_activated` focuses the main window,
queues that link, and emits `deeplink` (in-process only — a toast clicked
after the app quit just launches it). Frontend: load `chat_link_token`
before handling any link, listen for `deeplink`, then drain with
`take_opened_urls`. The `deeplink` payload is not the URL.
`deep-link://new-url` is the exception: the desktop plugin does not queue,
and the page routes that payload. Then `handleDeeplinkFromUrl` →
`extractChatLink` → `openChatFromLink`
(switch account if needed, `getChat` check, `openChat`). A `velta://chat`
whose `t` does not match is ignored (issue #23), so a web page that fires
the scheme cannot switch account or open a chat. Pinned by
`tests/notification-deeplink.test.mjs`. macOS plugin notifications do not
carry the link. `chat_link_with_token` is `#[cfg(target_os = "windows")]`
because that is its only caller. The macOS and Windows release builds set
`RUSTFLAGS=-D warnings`, so an ungated helper is dead code on macOS and
fails the job (v1.4.44 never published). Gate a new helper with the same
`cfg` as the code that calls it. See docs/agents/release-ci.md.

**Incoming-message notifications (PWA, since 10-09):** `notifyIncoming`
splits into `notifyIncomingTauri` (unchanged shell paths) and
`notifyIncomingWeb` — the installed PWA/browser gets OS notifications
through the service worker (`registration.showNotification`), per-chat
`tag` so repeats replace instead of stacking. The drawer + privacy gates
(master/system/mentions/text redaction) are shared via `notifyGateBody`
and now apply to the web path too. The generated SW (§4.2.1) handles
`notificationclick`: focus an in-scope client and postMessage
`velta-notification-click {accountId, chatId}`; with no client it
`openWindow`s and stashes the click until that page sends
`velta-pending-notification` (app.js listener → `openChatFromLink`,
fail-safe on unknown chat). Web permission is asked at the same point as
the shells (after a working account, `askNotificationPermission`); a
prompt fired without user activation is silently dropped by browsers, so
it piggybacks on the next `pointerdown` via `navigator.userActivation`.
There is no Web Push yet — a notification only fires while the page
context (or its worker) can observe the message; background delivery is
the UnifiedPush track (PLAN-UNIFIEDPUSH.MD, #110) for Android and a
future Web-Push/VAPID track for browsers.

**Share into Velta (#97)** uses that same queue. KEEP: `MainActivity`
registers `ACTION_SEND` and `ACTION_SEND_MULTIPLE` (separate filters,
`DEFAULT`, mime types OR). Shares wait in `createShareInbox` until boot
calls `shareInbox.ready()` (after the chat list and the first drain); the
page always shows "Share to…" (`buildSharePicker`: search, profile chips
when several, skip `deaddrop`, `device`, and `readOnly`; p2p included),
opens the picked chat and hands over to `ChatView.receiveShare` (text and
one photo/video are staged in the composer, documents and several files
are sent). Invite and chat links are not shares: `handleDeeplinkFromUrl`
returns true when it consumed one, including a rejected token, and only
unconsumed https or non-app schemes become text. Listen for `deeplink`,
then drain; drain again on `visibilitychange`/`velta-foreground`. Windows has no share-sheet entry
(the 11 flyout is packaged-only): setup writes
`%APPDATA%\Microsoft\Windows\SendTo\Velta.lnk` and recreates it only when
the UTF-16LE target is not this exe. Do not add other files there. Outbound
QR "Share a link" is still #37 (`share_text`). Pinned by
`tests/share-in.test.mjs`, `tests/share-flow.test.mjs`,
`tests/share-receive.test.mjs` and `cargo test --lib opened_args_tests`. Detail:
docs/agents/android-shell.md.

The skeleton currently contains only Cargo/Gradle manifests. To rebuild when the
source is added:

```bash
cd archive/velta-core-service/rust
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
  1. Android WebView native bridge (`window.VeltaBridge`)
  2. Tauri IPC (`window.__TAURI__`)
  3. opt-in worker-wasm core (PWA only; the retired `ws://127.0.0.1:20808`
     service probe was removed — unauthenticated listener)
  4. `MockCore` fallback
- `app/js/rpc-core.js` wraps any transport with a JSON-RPC client, maps core
  events to UI events, and exposes the same API surface as `mock-core.js`:
  multi-account (`getAllAccounts`/`switchAccount`/`addAccountWithQr` — a
  failed configure there re-selects the previous account so no stray is
  left selected, #99; `deleteAccount` wraps `remove_account` with
  switchAccount's epoch boundaries, #100; the `syncOnlyActive` flag funnels
  all IO through `_startIo`, #101), the
  relay surface (see docs/agents/relays.md), second-device backup transfer
  (`provideBackup`/`getBackupQrSvg`/`addAccountWithBackup`/`importBackup`;
  `get_backup` does not start IO — `addAccountWithBackup` calls `start_io`
  only after the import resolves, then emits `account-changed` without
  bumping the epoch, #118),
  backup export (`exportBackup` -> core `export_backup`, directory +
  optional passphrase, progress on `imex-progress`), autorelay onboarding
  (`initTransports` -> core `init_transports`; the core probes its built-in
  relay pool and configures the fastest, then grows the profile to ~3
  transports from IMAP idle hooks — wired into the splash "Autopick the
  fastest relay" button),
  vCard (`parseVcard`/`importVcard`/`makeVcard`), `getMessageHtml` (original
  body behind "Show Full Message…"), `createQrSvg`. Chat fulltext
  search (`searchMessages` -> core `search_messages`; wired into the Search-in-chat modal), pinned messages (`pinMessage`/`getPinnedMessages`, core 2.59+ API). Wire types are
  normalized here (drawer ids are always strings; `switchAccount` coerces to
  u32). KEEP the **account-isolation contract**: `account-changing` fires
  synchronously at the start of every account transition (the app tears down
  chat/popups/drawer/search), `account-changed` fires in a `finally` after
  selection succeeds or fails; every multi-step RPC captures its entry
  accountId and drops cache writes/UI events/async decoration when the epoch
  no longer matches; foreign or unattributed events (`contextId`) never
  mutate state; ChatView sessions are invalidated by `close()` and the
  epoch; unsent text/replies are drafts keyed by (account, chat);
  `closeAllPopups()` settles confirmations (dismissal = cancel). Pinned by
  the tests in §7.2.
- **Event long-poll contract** (rpc-core): the backend parks `get_next_event`
  until an event exists and hands each event to exactly one waiter; polls
  use a dedicated 240 s backstop (`eventPollTimeoutMs`), and an expired
  poll's entry stays registered so its late response is dispatched, not
  dropped. Don't replace it with a normal `_call`. (Pinned by
  `tests/rpc-event-poll.test.mjs`.)
- **Mid-session auto-reconnect** (1.4.11, app.js `velta-core-disconnected`):
  retry `core.reconnect()` forever with 1 s doubling backoff capped at 15 s,
  then re-fire `velta-core-status` connected — `transport.reconnect()` alone
  does NOT set the status pill — and refresh the chat list. While down, the
  rpc-core poll loop ramps delay 250 ms per consecutive failure (cap 5 s)
  and logs the failure on the first and every 20th attempt only.
- **Connectivity gate on core IO** (#28): the webview's `online`/`offline`
  events (plus `navigator.onLine` at boot) drive `RpcCore.setNetworkIo` —
  offline pauses the core's IMAP/SMTP loops (`stop_io_for_all_accounts`)
  instead of letting them hammer a dead network, online resumes with a
  `maybe_network` nudge; `reconnect()` re-pauses when the device is still
  offline. Both transitions announce in the Diagnostics chat. No-op on
  mock cores. An interface-up-router-dead state still reads online — the
  core's own retry handling covers that. (Pinned by
  `tests/network-io-gate.test.mjs`.)
- `app.js` owns the chat list, navigation, modals, the diagnostics chat and
  the PWA shell, plus a DOM-budget watchdog. KEEP: boot is stage-isolated —
  drawer + menu bind first and set `uiLive`; later-stage failures log and
  boot continues; `openChat` returns early when the ChatView stage failed;
  the outer catch shows the splash when `!uiLive`; `js/boot-net.js` loads
  before every other script (CSP forbids inline scripts) routing
  errors/unhandledrejection into the Diagnostics sink once app.js is alive,
  into the static `#boot-error` banner before that. Startup RPC chain
  (#46): boot's retrying `getAccount` is THE account fetch — `refreshAccounts`
  takes it as `knownAccount` instead of issuing a second one; chat-list
  paint never awaits fingerprints (avatars render initials/plain color and
  re-render when `fingerprintFor` resolves). Subsystem notes:
  docs/agents/relays.md (relay line/detail/manager), onboarding (splash,
  second device). Chat-list **Delete chat** calls `deleteChat` → core
  `delete_chat` and the chat leaves the list (#34). A group or an in/out
  broadcast leaves first (`leaveGroup` → `leave_group`, error swallowed)
  so the member-removed notice goes out; mailing lists and 1:1 chats do
  not (#145). `deleteMessages` only
  clears rows; the in-chat **Clear history** action feeds it `getMessageIds`
  (ids only, #47 — it never loads the full messages). A
  `p2p:` chat is forgotten with `removePeer` — do not send that string id
  to `delete_chat`. Pinned by `tests/rpc-account-isolation.test.mjs`.
- **Chat-list categories bar** (1.4.52, #57): `#chat-categories` chip row in
  `index.html` between the relay zone and `#chat-list` — All / People /
  Groups / Channels / Bots / System. `chatCategoryOf` and the swipe axis
  lock `swipeCategoryStep` are exported from `rpc-core.js` (NOT
  `components.js` — it extends `HTMLElement` and is not node-importable for
  tests); filtering runs via `visibleChats()` inside `renderChatList`
  (`state.chats` stays the unfiltered source). The People/Bots split reads
  contact bot flags from a LAZY `state.contactBots` map — one `getContacts`
  call fetched the first time a People/Bots view needs them (#46 budget;
  since #77 that includes a boot-RESTORED People/Bots category, which
  `visibleChats()` kicks itself — otherwise restored views classify bots
  as people); unknown contacts count as people. Since 1.4.84 the map is
  per account (`state.contactBotsAcct`; contact ids are account-local) and
  `setChatCategory` re-fetches it (`ensureContactBots(true)`) every time
  People/Bots is chosen, so a profile switch or a contact newly flagged bot
  is picked up. Active chip persists in
  `localStorage["velta-chat-category"]`; `syncChatCategoryBar` hides the bar
  for every side view — and entirely (#80) when every special category is
  disabled (a lone "all" chip is noise). Category VISIBILITY is
  user-configurable (#75):
  drawer → "Chat categories" (same details-checkboxes pattern as Bottom bar
  buttons) stores disabled cats in `localStorage["velta-cats-hidden"]`;
  "all" is always on, hidden cats drop their chips (`b.hidden`),
  a persisted active cat that gets disabled falls back to "all"
  (self-healing guard inside `syncChatCategoryBar`), and the swipe walks
  visible chips only (`!b.hidden` filter). Mobile-only swipe (left/right = next/previous chip)
  attaches only under `matchMedia("(pointer: coarse)")`, is axis-locked
  (48px + 1.4× horizontal dominance), swallows the gesture's follow-up click
  and no-ops past either end. KEEP: the bar code must live INSIDE the
  app.js slice that contains `renderChatList` — `tests/app-account-isolation`
  runs app.js as slices between marker comments, and module-level code in
  the relay-pull region (~line 620) is invisible to the harness. Pinned by
  `tests/categories-bar.test.mjs`.
- `app/js/chat-view.js` owns the conversation history (virtualized via
  virtual-scroller), composer, selection mode and the delete dialog, plus the pinned-message tray under the chat head (`_refreshPinnedBar`, fed by `pinned-changed` events AND — #69 — debounced re-checks on `msgs-changed`/`msgs-deleted`: the core's tombstone REPLACE clears a pin WITHOUT a `MessageUnpinned` event, and core `MsgDeleted` (explicit/remote/ephemeral deletions) maps to `msgs-deleted`+`msgs-changed` in rpc-core — unmapped, remote deletions never reached the UI at all). #157: a chat you cannot post in (`can_send` false — someone else's channel) still shows the tray, without the ✕ unpin buttons and without a Pin/Unpin menu chip. Composer send keys (1.4.52, #56): Enter sends while the `velta-send-enter` drawer setting is on (default); with it OFF, Ctrl/Cmd+Enter sends instead and plain Enter inserts a newline; Shift+Enter is always a newline and IME composition never sends. KEEP:
  rows must NOT get `content-visibility` (the scroller measures mounted rows
  itself; collapsing desyncs its height cache — scroll jumps on remount);
  day chips render inside the first message row of each day (`dayFirst`) —
  separator items broke the scroller's prepend diff; `_loadOlder` prepends
  stay pure message prefixes. Bubbles use `contain: layout style` (not
  paint — the reply pill overflows). Media blocks (.msg-image/.msg-video/
  .msg-audio) deliberately bleed −5px left/right past the bubble padding (edge-to-edge
  official-client look); it works only because the bubble has no paint
  containment — keep bubble padding (7px 10px 6px) and the −5px bleed in sync.
  Media box geometry is WIDTH-first (#27): `width:min(naturalpx, 480px,
  calc(min(cap, 45vh) × W/H))` + `aspect-ratio` — px terms ONLY, never a %
  inside min(): percentages inside the shrink-to-fit bubble participate in
  intrinsic sizing and collapse the box in Safari/WebKit (the macOS sliver
  bug; the probe showed Chromium collapsing too when the meta line doesn't
  rescue the bubble width). `max-width:100%` handles the narrow-bubble
  clamp; the reserve box equals the decoded box, so the decode never jumps.
  Chromium exception (`html[data-engine="chromium"]`, set from `chat-view.js`;
  iOS WebKit shells are excluded): once a landscape wrap is `.ready`, that
  bubble gets `width: min(480px, 100%)` and the wrap
  `min(var(--img-w), 100%, calc(min(var(--img-cap), 45vh) * var(--img-r)))`.
  The definite bubble width is what makes the percentage safe. Safari keeps
  the px-only inline width. Do not put `%` inside `min()` on that inline width.
  `.chat-item` cards use full
  `contain: layout paint style`. The rendered-row LRU (`_rowCache`) survives
  `close()`; `open()` clears it when the account changed. A row that is
  off screen releases its video and audio decoder and restores the same
  source when it is shown again — live players left in the cache stalled
  Windows WebView2 until chat-list clicks stopped landing.
- **Bubble contrast (main.css)**: the outgoing bubble is blue
  (`--bg-bubble-out`) in BOTH themes, so links/inline elements inside
  `.msg-row.out .bubble` must never ride `var(--accent)` — blue-on-blue,
  ~3:1 dark / ~2.9:1 light (both below the 4.5:1 AA text bar). Out-bubble
  elements use the light-on-blue palette instead: `#dfeaf6` in dark,
  `#14507e` in light (6.7:1 / 7.3:1) —
  the same tones `.msg-row.out` blockquote and quote text already use
  (brutal theme overrides to `--nb-main-ink` on its yellow bubble).
  `.msg-row.out .msg-text a` carries the rule as the precedent; put new
  inline elements (links, mentions, code) on that palette, not the accent.
- **Read tracking** (1.4.40, PR #17): opening a chat no longer marks it read.
  `open()` lands at the manual read marker (while unread remain), else the
  core's `get_first_unread_message_of_chat`, else the bottom — loading a
  window via `getMessages({aroundId})`; a window short of the tail sets
  `hasNewer` and pages down (`_loadNewer`), while `onIncoming`/
  `onMsgsChanged` skip appends and `appendOutgoing` jumps to the tail.
  KEEP (#43): the `msgs-changed` listener passes `fresh` only for an
  unknown scope (`chatId === 0` — live ticks, scope-less local-chat
  events); a known chat's event refetches the tail from the id cache the
  core layer already invalidated, never forcing a full id-list reload.
  Messages become seen only once on screen: `_checkSeen` takes the lowest
  visible row as a watermark and batches `markSeen` (core
  `markseen_msgs` for exactly those ids). KEEP: no seen-marking while
  `_settling` (open/jump positioning) or `document.hidden`; rows in the
  pending batch are flushed on `close()` only while the session is still
  current (never into another account); go-down = catch up (`markRead`).
  `markRead` is one `marknoticed_chat` call (#47) — core marks every fresh
  message noticed, clearing the badge without shipping the chat's id list
  (receipts for rows shown still go out via the per-visible-row `markSeen`). The "Unread messages" line and the marker ride inside
  their rows (`unreadFirst`/`readMarker` item flags, like `dayFirst`), and
  `_renderItem` rejects cached rows whose `_veltaFlags` differ. Local
  (P2P) chats keep open = read. The message menu does not set or clear
  markers (#38). A stored marker still wins at open, and the line's X still
  calls `clearReadMarker`. Pinned by `tests/read-tracking.test.mjs`.
- **Remembered scroll position** (issue #18, drawer setting "Remember
  scroll position in chats", localStorage `velta-remember-scroll`,
  default ON since #70 — unset or "1" = on, "0" = off): `close()` saves
  `{anchorId, dy}` (topmost visible row + its
  viewport offset) in the in-memory `_scrollAnchors` map, keyed like drafts
  by (account, chat), only when the chat is fully read AND the user
  genuinely scrolled off the bottom (`_userAway`: a scroll outside
  `_settling` within 1.5 s of wheel/touch/key/scrollbar input — settles and
  programmatic seeks never count); anything else deletes the chat's anchor.
  `open()` priority: marker > first unread > saved anchor > bottom; unread
  messages retire the anchor, a deleted anchor falls back to the tail, and
  the restore is a `getMessages({aroundId})` window + `_restoreScrollSettling`
  (relative dy correction on the settle timer). Tracked chats only. Setting
  off = old behaviour. Shared landing fix (both modes): the scroll handler
  holds `_loadOlder` while `_settling` (close() leaves scrollTop 0, and the
  prepend under the pin made reopen landings non-deterministic — the settle
  end pages instead), and the bottom settle's final re-assert is instant,
  not smooth. Pinned by `tests/scroll-restore.test.mjs` (default-ON since
  #70; also covers the appendOutgoing follow-only-when-near-bottom rule
  from #71).
- **Saved copies jump back to the original message** (issue #19): core
  `originalMsgId` is mapped in `rpc-core.js`. A copy in Saved Messages gets
  a round chevron (`data-act="show-original"`, title “Show in chat”) hanging
  off the bubble. `_showOriginal` loads that message and either jumps inside
  the open chat or `onOpenChat`s the source chat and then jumps. Notes typed
  in Saved Messages have no `originalMsgId` and no button. Pinned by
  `tests/chat-msg-update-hardening.test.mjs`.
- **Read-only chats hide every reply affordance** (1.4.26): device chats and
  channels the member cannot post in get no hover-reply pill, no
  context-menu/selection Reply, no selection-quote chip — `app.js` derives
  `chatView.readOnly` from the chat kind plus the core's `can_send` check
  (the same check that hides the composer), ChatView applies a
  `chat-read-only` body class for DOM-rendered buttons and guards
  `_setReply`/`_setReplyFragment` as the backstop. Never gate these on
  `chat.kind === "channel"` alone — the rights check is the source of truth. The hidden composer also removes the
  bottom breathing room; restored by `body.chat-read-only .history-scroll` padding
  (NOT on `.history` itself — the virtual scroller inline-writes its own
  padding-bottom there every layout pass and would clobber the rule).
- **Attachments carry the pending reply** (1.4.26): `_takeQuote()` is the
  single consumer of the pending reply (`replyTo`/`replyFragment`) — full
  replies ride the core's `quotedMessageId`, fragment replies become
  `"> "` quote lines prefixed to the text/caption — and `_send`,
  `_sendPendingMedia`, `_sendVoiceFile`, `_sendAttachment`'s file/video
  paths, and `_sendSeparateImages` (the first image only) all use it.
  Adding a new send path MUST call `_takeQuote()` too, or replies get
  silently dropped (the image path did, pre-1.4.26).
- **Pending attachment strip** (post-1.4.31, #5): no send-preview modal.
  Picked/pasted media shows in `#media-preview` (strip above the composer,
  official-client pattern); the caption IS the composer input, focused on
  attach; Send sends media+caption via `_sendPendingMedia`, X clears.
  Videos preview from `fileUrl` (bytes never enter RAM); images read into
  a Blob (paste/crop need it). `_setPendingMedia(kind, src, corePath,
  name)` — src is a Blob (object URL owned by us) or a URL string.
  Desktop picker files are COPIED into the accounts `uploads/` dir at
  pick time (`resolveAttachmentPath` — same as Android content-URIs):
  shell media commands scope paths to AppLocalData, and out-of-tree
  picked files broke the poster/send reads. Media does NOT ride drafts —
  `close()` drops it (official client does the same).
  Several gallery images (#120) skip the strip. The image picker opens
  with `multiple`. Two or more paths each send immediately as their own
  `viewtype: image` (`_sendSeparateImages`). Content URIs are copied with
  a distinct filename (`<ms>-<i>`) so two picks do not share one file.
  The pending reply rides the first image only. One image — a string, or
  the one-element array the dialog returns for a single pick — still
  stages for a caption. The browser file input has no Tauri path.
  `_writeBlobForSend` writes the bytes with `transport.writeCoreFile` at
  `/uploads/<name>` (slashes stripped) and the core copies that into the
  blobdir. Several images each send (`_sendLocalImages`). One image still
  stages. Voice, paste, and crop use the same write. Desktop and Android
  keep `resolve_upload_path` plus `plugin:fs|write_file`. Pinned by
  `tests/chat-account-isolation.test.mjs`.
- **Save attachment.** Message menu **Download** (image, video, or file;
  stickers stay **Save sticker**) calls `_saveAttachment`. A file still
  on the server is fetched first. Android opens the system save dialog
  and `save_attachment` copies the account-scoped path to that content
  URI. Desktop and the PWA save the bytes from the page (the desktop
  command only returns an error). Pinned by
  `tests/chat-msg-update-hardening.test.mjs`.
- **Voice messages** record in the composer (attach menu → Voice message;
  hidden in local chats — that core rejects `viewtype: voice`).
  `MediaRecorder` + `getUserMedia({audio:true})`; `#voice-rec` shows the
  timer, Cancel, and Send (`#btn-voice-send` is `aria-pressed`). The blob
  is written under `uploads/` as `voice-<ts>.m4a`, `.ogg`, or `.webm`
  (`voiceFileExt`: first of `audio/mp4`, opus ogg, opus webm that
  `isTypeSupported` accepts) and sent as `viewtype: voice` WITH that file.
  A voice message with no file is what the core rejects ("attachment
  missing for message of type #Voice") — the old demo placeholder did
  exactly that. `MessageData` has no duration field; `<audio controls>`
  reads the length from the file. `close()` stops the mic and does not
  send. A send whose upload outlives the chat checks `_isCurrent` before
  `sendMessage`, so it cannot land in the next account.
- **Message editing** (1.4.20): own text messages edit via core
  `send_edit_request` (rpc-core `editMessage` → refetch → `msg-updated`).
  KEEP: `onMsgsChanged`'s in-place compare must include
  `item.msg.text !== m.text` — without it, edits arriving from the other
  device never re-render (only downloadState/viewtype/state were compared).
  Menu guards live in `app/js/msg-edit.js` `canEditMsg` and mirror the
  core's `send_edit_request` (own, not info, not hasHtml, not call, non-empty
  original text; not P2P — `local-chat`'s proxy would fall through to the
  wrong id space). Caption edits: own image/gif/video/audio/voice/file/vcard
  messages WITH a caption are editable (text only; the attachment is kept,
  "edited" marker + in-place re-render as for text). Core refuses
  "Cannot add text", so media sent without a caption cannot gain one — no
  Edit item then. webxdc/sticker excluded (no user caption). Core has no
  edit time window. `_setEdit` bails if an attachment is staged
  (`pendingMedia`), else `_send()` would post new media instead of the edit.
- **Long-press guard** (1.4.20): the row's 500 ms context-menu timer cancels
  on `touchcancel` AND on multi-touch (`touches.length > 1`) — the WebView
  claims two-finger gestures and answers with `touchcancel`, not `touchmove`,
  which previously left the timer alive (menu opened mid-swipe). Any
  `touchmove` still cancels the timer.
- **Mobile swipes (#35)** — only when `(max-width: 820px)` and the pointer
  is not `(hover: hover) and (pointer: fine)`. Swipe right on a `.bubble`
  translates it up to 64px and, past 48px, calls `_setReply` (skipped when
  read-only, selecting, or in text-selection). Swipe left on `#history-scroll`
  translates `#main` with the finger; past 72px (or 28% of the width) it
  calls `onBack` (`closeChat`). `.swipe-back` on `.app` shows the sidebar
  while `.chat-open` would keep it `visibility: hidden`. A vertical move
  wins and stays a scroll. A video poster (no `controls`) starts both
  swipes (#139); the click that follows does not open the lightbox.
  A `<video controls>` still opts out so its scrubber keeps the finger.
  An invite card starts both swipes (#87); the click that follows does
  not join, copy, or open the card. Other buttons still opt out.
  Reply-right and back-left do not run together
  (`_replySwipe` / `_backSwipe`). `close()` cancels a back drag so the
  column is not left translated. A committed swipe parks `#main` at
  `translateX(100%)` with no transition before `.chat-open` drops, then
  clears that inline transform on the next frame — otherwise the .22s
  close slide runs from `-100%` to `100%` across the list. The close path
  must never leave that parked column behind (#86: a local chat's teardown
  threw and the screen stayed blank): the swipe handler wraps `onBack` in
  try/catch and clears the inline transform when it failed, `closeChatUI`
  (app.js) wraps `chatView.close()` in try/catch so the `.chat-open` drop
  always runs, and `_typingStop` swallows a `TypingSender.stop()` error.
  The commit check is `_isCurrent() || externalSurface` (#98): the
  Diagnostics chat releases the view and writes `#history` itself, so
  `openDiagnosticsChat` sets `chatView.externalSurface = true` after
  `close()` — without it no session exists and the swipe could never close
  the diagnostics chat. `open()`/`close()` clear the flag.
  Pinned by `tests/chat-msg-update-hardening.test.mjs`. Detail:
  docs/agents/android-shell.md.
- **Select text (#36, #121)** — bubble text stays unselectable on touch
  (long-press belongs to the context menu). `user-select: none` inside
  `(hover: none) and (pointer: coarse)` is not enough: some WebViews
  still start a native selection on long-press. The row's `selectstart`
  listener calls `preventDefault` while `_offerSelectText()` is true and
  this row is not already in Select text. `-webkit-touch-callout: none`
  is on `.bubble` in that same query, and `default` on `.text-selecting`.
  Do not put `user-select` on `.msg-text a` (that rule is drag-only).
  **Select text** is on the touch message menu only
  (`_offerSelectText` hides it when `(hover: hover) and (pointer: fine)`
  matches). It calls
  `_enterBubbleTextSelection`: `.text-selecting` on that bubble's `.msg-text`,
  select-all so the native handles can shrink the span, and a
  `.msg-select-bar` (Reply, Copy, Close) inserted at the top of `.bubble`.
  Reply quotes the current span via `_setReplyFragment` (the existing `"> "`
  fragment, no core change; omitted when `readOnly`). Copy writes that span,
  not the whole message. Close, or a pointerdown outside the text and the
  bar, leaves the mode and notifies the virtual scroller — the bar changes
  row height. `_leaveTextSelection` calls `removeAllRanges` WHILE
  `.text-selecting` is still on, then sets `user-select: none` and clears
  again. Removing the class first leaves Android's selection handles on
  screen. Close does not `preventDefault` its pointerdown; Reply and Copy
  do, and they snapshot the span first. While the mode is open, long-press
  and `contextmenu` do not open the bubble menu (`_msgContextMenu` returns;
  the long-press timer is not armed). The floating `#sel-quote-chip` stays
  hidden so there is one Reply. Desktop mouse selection is unchanged and
  still uses the chip — which binds ONLY on
  `(hover: hover) and (pointer: fine)` (#113: touch selects through this
  Select-text flow instead; `_bindSelectionQuote` gates itself, pinned by
  `tests/selection-quote.test.mjs`). The desktop menu does not offer Select text.
  A coarse pointer gets a bottom sheet (`showMessageSheet`) instead of the
  menu: two rows of reactions, the last cell opening a searchable emoji
  tray, then actions in two columns of related pairs (Reply/Forward,
  Pin/Save, Edit/Resend, Copy/Select text, Select/Info), Delete as a
  full-width row, plus a "Show links" details listing every link in the
  message as real anchors so the WebView's own long-press menu works per
  link (#161, 1.4.80). Desktop replaced the vertical menu with the bubble
  action bar (`showActionBar`, 1.4.80): a chip row anchored above the
  bubble (right-aligned over own `.out` bubbles, left-aligned over
  received ones, flipped below at the viewport top, closed by chat
  scroll/outside tap) — quick-reaction emoji + smiley→tray over
  short-label chips, opened by right-click or the ⋮ hover chip beside the
  Reply pill (the track is a flex row; the ⋮ mounts in read-only chats
  too). Link gestures pass the pressed anchor's href in: Copy link
  (tracker-stripped, same URL as open) + Open link; Share link is
  touch-only. The bar keeps the `ctx-menu` class and item icon+span shape,
  so the fake-DOM menu tests keep working.
  Multi-touch still cancels the long-press timer (the guard above); it does
  not enter selection.
- **Send/receive ticks** (1.4.20, semantics updated post-1.4.36): the tick
  icons follow the core's MessageState — `OutPending` renders the spinning
  ring, `OutDelivered` (the RELAY accepted the message) renders the SINGLE
  stroke check (`TICK1`), `OutMdnRcvd` (the recipient's client confirmed
  seen) the double-check (`TICK2`, Delta Chat desktop's fill-based SVG in a
  3:2 viewBox; `.ci-last .ci-ticks` is retuned to 17×12 for the aspect), and
  `OutFailed` a bold red exclamation (squash-tolerant in the tick box — a
  circled icon would render as an ellipse there; the bubble additionally
  carries the reason badge + retry/remove). Chatmail is store-and-forward:
  pipeline visibility ENDS at the own relay's acceptance — "seen" comes only
  from the recipient's MDN. Never promise per-recipient-relay delivery. The
  message-info sheet (`_showInfo`) shows Sent, Received (em dash when unset),
  State as Seen/Not seen plus Encrypted/Not encrypted (Seen is the MDN for
  outgoing, and not-unread for incoming), Database ID (`#id`), the RFC 724
  Message-ID, and each server URL as `addr UID=n` (folder kept when it is
  not INBOX). Message-ID and server URLs come from `get_message_info_object`.
  Reactions (#122) sit under State: one open `<details>` per emoji
  (`messageInfoReactions` in format.js). The summary chip is a `<button>`,
  so a tap toggles our reaction (see below) and does not toggle the details. The body
  names who sent it. `getMessageReactions` reads `get_message_reactions`
  and `get_contacts_by_ids`; contact 1 with no name is "You". A local chat
  skips that RPC and shows the chips already on the message, with no
  per-person list. A null RPC result clears the box. Pinned by
  `tests/message-info.test.mjs`.
  The selection checkbox (`ICO.check`) is separate.
  KEEP (read-receipt lifecycle, verified live 2026-10-02 against real
  accounts — full narrative in `docs/agents/read-receipts.md`): the ONLY
  MDN trigger is the peer's client running `markseen_msgs`, and Velta fires
  that only from the open-chat watermark — notification direct-replies and
  replies typed without an on-screen chat NEVER produce an MDN, so the
  sender's tick legitimately stays single. Both sides must open each other's
  chat; the flip then lands in ~20 s (relay round-trip). Self-talk/Saved
  messages never reach `OutMdnRcvd` (markseen ignores own messages). The
  CHAT-LIST row tick is `summaryStatus` of the LAST message only — older
  read messages in the chat never light the row up, and a single tick on the
  newest message is correct until the peer reads exactly that one. When a
  user reports "stuck ticks", check the raw core state first
  (`get_message`), then the PEER side (`state 10`/InFresh = never viewed).
- **Bot chip (post-1.4.36)** — incoming messages whose sender contact carries
  the core's `isBot` (`fromContact.bot`, mapped by rpc-core and the mock)
  render a small bordered "bot" tag in the meta row beside the timestamp.
  The desktop hover-reply pill sticks along the bubble's right edge for the
  whole bubble (issue #26), so the chip stays in the meta row.
  Sticker bubbles carry no meta row and go unmarked.
- **Context-menu Resend (post-1.4.36)** — own messages (non-P2P) offer
  Resend: core `resend_messages` flips the message back to OutPending and
  retransmits (recipients get a duplicate); the core rejects info/drafts/
  pending with an error, which toasts. `rpc-core.resendMessage` re-tracks
  the id in `_sendingIds` so the relay line spins during the re-send.
  P2P local chats keep their own retry paths (`_lcRetryTransfer`,
  the proxy's resendMessage).
- **Viewtype mapping is load-bearing** (rpc-core `_mapViewtype`): the
  renderer branches on the mapped string ("image", "sticker", …), so a
  collapse like `case "Sticker": return "image"` silently dead-branches the
  whole sticker UI (it did — stickers rendered as bubble-wrapped photos,
  fixed 1.4.20+). Same class of bug in `_mapChatListItem`'s summary emoji:
  Video was grouped under the File 📎 icon until split out (🎬). Audit mappings against `MessageViewtype` /
  `MessageState` in `core/deltachat-jsonrpc/src/api/types/message.rs` when
  touching them. Sticker rows: `bubble.sticker` drops the chrome
  (transparent bg must out-specificity `.msg-row.out .bubble` AND the
  brutal override — two rules); wrap bg `none` so transparent
  PNGs don't sit on the shimmer (cap + object-fit rules live in the
  Stickers bullet below).
- **Stickers** (1.4.20+): picker = ui.js `showStickerPicker` fed by core
  `misc_get_stickers` (rpc-core `getStickers`); received stickers are added
  by TAPPING the sticker in the chat (official-client behavior) — a
  confirm asks "Add this sticker to your sticker collection?" then rides
  `misc_save_sticker` — and the context menu's "Save sticker" remains as
  the direct path; sending rides `sendMessage {viewtype:"sticker", file}`.
  Collections are LOCAL per-account folders
  (`<account>/stickers/<collection>/`, core `misc_save_sticker` just
  copies the blob) — no device sync; they move only via backup/restore.
  Render rules: `bubble.sticker` drops the chrome (transparent bg must
  out-specificity `.msg-row.out .bubble` AND the brutal override — two
  rules); 175px cap (matches official Android DC's
  `media_bubble_sticker_dimens` 175dp square) — BOTH in the reserved box AND
  the decode `reveal()` (the photo's 450px cap made stickers render big and
  jump); sticker images are `object-fit: contain` (photo img uses `cover` to
  fill the reserved box — cover CROPS transparent PNGs). Sticker bubbles load
  the ORIGINAL file (no 720px thumbnail): animated stickers play in-chat like
  official Android, and stickers are small enough that the static-JPEG
  thumbnail buys nothing. Tap behavior: received sticker = add-to-collection
  prompt THEN lightbox; own sticker = lightbox UNCONDITIONALLY (no
  naturalWidth gate — the static thumbnail may still be decoding when tapped,
  which silently killed taps on Android). Composer trigger is
  `#btn-sticker` INSIDE `.composer-input-wrap` (right edge) — icon is the
  hand-drawn square-with-fold smiley (e888008; an svgrepo circle variant
  was tried and rejected by the user). P2P chats: no save/picker
  interplay. MockCore ships `mock:<emoji>` tile paths the picker renders
  as text — never feed those to fileUrl.
- **JSON-RPC `MessageData` casing (post-1.4.31, silent-kill class)**: the
  deployed sidecar binary deserializes `send_msg`'s MessageData in
  SNAKE_CASE (`viewtype`, `quoted_message_id`) while the vendored 2.61
  source carries `rename_all = "camelCase"` — serde IGNORES unknown
  fields, so camelCase forms vanish without an error: a sticker sent as
  `viewType: "Sticker"` became `None`+file → `Viewtype::File` → Image at
  prepare ("stickers send as images"; proven by probe: snakeCase and the
  deprecated `send_sticker` keep Sticker). rpc-core `sendMessage` now
  sends BOTH casings (`viewType`+`viewtype`, `quotedMessageId`+
  `quoted_message_id`) — each build reads its own, the other is ignored;
  works on either core. On the next core rebuild, re-probe with
  `send_msg` `{viewType:"Sticker"}` + `{viewtype:"Sticker"}` on a real
  binary and delete the snake twins if camelCase wins (probe script:
  temp `sticker-probe.mjs` pattern — real rpc-server, throwaway account
  on `d13.buro.dev`, `send_msg`/`send_sticker` to a probe group chat).
- `app/js/components.js` defines the Elena custom elements
  (`<velta-avatar>`, `<velta-chat-item>`, `<velta-chat-head>`,
  `<velta-video>`). KEEP: the chat-head subtitle (`cht-status`, `statusLine()`) renders
  `bot` for bot contacts and `online` / `last seen X ago` for users — the
  contact is the real source; chat-list rows never hydrate contacts (one RPC
  per row); presence maps core `lastSeen: 0` to `null` = unknown (no
  subtitle, no "last seen just now" — never a `Date.now()` fallback, fixed
  1.4.5). There is no verified rosette any more: core 2.61.0 stopped
  tracking contact verification.
- `app/js/avatar.js` — fingerprint color-matrix identity tiles, delivered
  as percent-encoded SVG data-URL CSS backgrounds (`avatarBackgroundUrl`,
  cached per fingerprint — zero child nodes); group avatars stay solid
  color; a contact's photo rides inside the matrix tile; photo avatars
  shimmer via the img's own background until `load` (`.loaded` removes it —
  Elena does not reliably call `updated()` on first render, so bind from
  `updated()` AND once via rAF from `connectedCallback`). The fingerprint
  itself is fetched once per `(accountId, contactId)` via `setFingerprintSource`
  (wired by app.js with `core.accountId` and `addrOf`) and kept across account
  switches — contact ids are per-account, hence the composite key; entries
  never expire. `parseFingerprint` reads only the grouped fingerprint lines,
  so hex in a display name or address is not part of the key. The block is
  the one whose address matches. No parsed key hashes the address (the
  element `addr`, or `addrOf`). **Greyscale rule (7ef758c):** a tile not
  backed by a real OpenPGP fingerprint is greyscale (`mono`, `monoFill` =
  luma grey, no color-name captions) and the profile key row shows "—".
  Contact 1 makes `get_contact_encryption_info` throw; the real self key
  comes from `make_vcard([1])` → `fingerprintFromVcard` (wired as
  `selfFingerprint`). An address hash is never shown as a profile key —
  that used to paint a different tile than the contact others see.
  `cachedFingerprintIsDerived(id)` tells components which; derived entries
  are dropped on `setFingerprintSource` so they re-resolve after configure
  / key arrival (`tests/avatar-mono.test.mjs`). Chat list and chat head
  pass `addr` when the contact has one. Same key, same tile on every shell.
- **Profile sheet (`showChatInfo`) hydration contract**: the full contact
  (real avatar, bot flag, presence) is fetched whenever `chat.contact` is
  absent — group-opened profiles (`openContactProfile`) therefore pass NO
  partial contact stub, or hydration is blocked and the sheet keeps matrix
  initials with stale rows. Relay rows: 1:1 contact profiles show the
  contact's relay from their address (no per-contact relay list upstream);
  the self profile shows the account transports — one row, or a collapsed
  `Relays (n)` details list for several. GROUP/CHANNEL sheets show no relay
  rows at all: the account transports are identical on every group and
  relay management is account-scoped (the drawer's "Relays of this
  profile…" is the single entry point) — do not resurrect them there.
  "Chats in common" (#171) is a collapsed details row, but the membership
  walk does not run when the sheet opens. Opening the section calls
  `chatsInCommon` over the chats already listed, with `getChatContactIds`
  (`get_chat_contacts` only). `getChatMembers` is only for non-numeric
  local-group ids. While a search is narrowing the chat list, the section
  sees that narrower list. The group member list keeps the (n) count
  (members collapsed by default since 1.4.41). Member rows carry the
  member's RELAY DOMAIN as
  the subtitle with the full address in the tooltip (#72). A Storage row
  (all non-P2P sheets) sums attachment `fileBytes` over the whole chat —
  paged newest→oldest, 500/page, computed lazily on sheet open; the core
  has NO per-chat size API (only account-wide get_account_file_size).
  The sheet also carries the "Old messages" cleanup details (same
  OLD_MESSAGE_SPANS + deleteMessagesOlderThan as the chat-list menu);
  its confirm REPLACES the sheet (showModal is one-at-a-time), so the
  handler reopens the sheet via modalHistorySettled + showChatInfo —
  the mute/ephemeral dialog pattern — which recomputes Storage.
- **Theming contract**: `THEME_LABELS` (ui.js) drives the picker;
  `applyTheme` (app.js) sets `html[data-theme]` + the theme-color meta.
  Themes: auto (system), dark, light, brutal (1.4.6 — explicit only, never
  matched by Auto). A theme is a token block in main.css plus component
  overrides appended AFTER the base rules (brutal re-overrides the 1.4.3
  quote palettes — keep it last). Every new theme value lands in
  `THEME_LABELS` and the theme-color map together.
- **List action bar + side views** (`.list-bar`, 1.4.7+): buttons switch
  what `#chat-list` shows via `setListView` over {chats, contacts, calls,
  qr, search, new, archived}; `renderChatList` early-returns unless the view
  is "chats" (keep that gate — refresh storms clobber the other views).
  `archived` (issue #13, post-1.4.37; reworked 2026-10-03 twice) — the
  dedicated head button is GONE (it sat in the prime head slot); the folder
  is now the SECOND TAB of the search screen ("Search | Archived (n)",
  `searchScreenTab` module var, button always lands on Search; the
  standalone `renderArchivedView`/`listView === "archived"` state is
  deleted). Count shown on the tab label (shown while `archivedCount` is
  0-hidden — piggybacked onto
  refreshChatList via `getChatList({ archived: true })`, list flag 0x01 =
  DC_GCL_ARCHIVED_ONLY — NOT 0x02, which is DC_GCL_NO_SPECIALS and
  silently returns the unarchived list, hiding every archived chat), and
  writing from an archived chat unarchives it
  (every chat-view send routes through `_sendArchivedAware`). The head X
  closes the whole search screen from either tab.
  Contacts come from `core.getContacts` through a virtual scroller
  (`sideScroller`, stopped by `stopSideScroller` on every view switch);
  Calls read the LOCAL call log (localStorage `velta-call-log`, capped 30 —
  the core has no call-log API); QR renders `inviteQrProvider(null)` (#37: tabs My code / Scan a QR code — scan tab phones-only, in-page `mountScanner` in qr-scan.js, camera stopped by `stopQrScanner` from `setListView`; Copy a link; Share a link = `share_text` JNI → Share.kt on Android, Web Share elsewhere; logic in qr-actions.js, test tests/qr-screen.test.mjs). Inbound share into a chat is #97 (§4.4), not this button. The
  header search button and `#btn-new-chat` are view toggles
  (`syncHeaderButtons()` from `setListView` — keep that call). Button
  visibility is user-configurable (drawer → Bottom bar buttons, localStorage
  `velta-bar-hidden`); `applyBarVisibility` adds `.bar-bare` when all four
  view buttons are hidden; Menu and `#btn-new-chat` are always visible. KEEP:
  boot lands on the chats view WITHOUT going through `setListView`, so the
  initial `.bar-btn.active` is painted directly in the bind-ui slice — don't
  rely on `setListView` to mark it.
  `#btn-new-chat` is `.bar-btn.bar-accent`. `.bar-btn.active` squares the
  bottom corners for the view tabs; `.bar-btn.bar-accent.active` restores
  `border-radius: 8px` on all four (#109). Do not set `box-shadow` on that
  rule — it would beat the brutal theme's shadow. Pinned by
  `tests/native-elements.test.mjs`.
  The new view's rows (`newChatOptions`): New chat, New group, New channel
  (#155 — name via `askText`, then `createChat(name, [], "channel")` →
  `create_broadcast`; no member pick, people join with the channel invite
  QR; a channel you create is postable, seeded demo channels stay
  read-only), New local group when local chat is on, Join via invite
  link, Add a relay to this account (#149 — `addRelayFlow` with no list
  refresh, so it does not reopen the Relays modal; a second transport on
  this profile, not a new one), Add account via invite link. Pinned by
  `tests/module-bindings.test.mjs` and the channel-creation case in
  `tests/rpc-account-isolation.test.mjs`.
  The old `.fab`/`.sidebar-foot` and the sidebar-head Menu button are gone —
  do not resurrect them.
- **Drawer contract** (ui.js `buildDrawer`): no close button, no offset
  shadow (slides over the sidebar's own edge; a right border separates).
  Stops above the list bar (`inset` bottom = `var(--list-bar-h)`).
  open()/close() dispatch a `velta-drawer` document event (the bar Menu
  button listens to flip hamburger↔cross and to close instead of re-open).
  Width `clamp(300px, 33vw, 420px)`, full width on mobile. While open, a
  capture-phase document `pointerdown` listener closes it on outside taps;
  the transparent overlay swallows the click. Toggle-spoiler pattern
  (`<details class="drawer-details">` + `.scale-opts` checkboxes): Bottom bar
  buttons (`data-bar-key`), Chat categories (#75, `data-cat-key`),
  Notifications (NINE `data-notify-key` switches — notifications/
  mentions/text/system always; vibration/sounds/bg/bgforce Android-only
  (hidden off-Android at drawer build); calls everywhere. Storage:
  default-on keys store "0" when off, default-off keys (mentions,
  bgforce) store "1" when on; absent = default. The page ALSO pushes
  the full set to the shell via `set_notify_prefs` (persisted to
  `notify-prefs.json` in app local data + a filesDir copy the Kotlin
  BackgroundFetchJob/Notifications channel layer read):
  `bg_notify_incoming` gates on enabled/mentions_only (drawer label "Replies only"; heuristic:
  text contains @ or the displayname)/show_content/system_new_msgs;
  `push_wakeup_impl` skips when `use_bg_connection` is off;
  `force_bg_connection` ON requests battery exemption. Desktop gates
  in notifyIncoming: master/system/replies (heuristic)/content) and Image quality
  (`data-mq-value` radios, `velta-media-quality` "0"=Standard/"1"=Compact
  (940 KB / 130 KB compression targets), Auto-download limit
  (`data-dl-value` radios, `velta-download-limit` "0" / 1 MB `1048576` /
  5 MB / 25 MB, mirrored to the
  core's per-account `download_limit`. Core 2.65 does not multi-device-sync
  that key — `DownloadLimit` is not in `Config::is_synced` — so the
  localStorage value is device-global and is copied into whichever account
  is open. A stored `655360` (the old 640 KB preset) is rewritten to 1 MB.
  In core 2.63 attachments above it
  (post-messages, >140 KB split) are NOT auto-downloaded: they wait for a
  tap and stay on the relay until downloaded or purged by the relay
  (chatmail `delete_large_after`, ~7 days), so a limit costs relay storage
  even with multi-device off; the drawer hint `DL_LIMIT_HINT` in
  `app/js/multidevice.js` says so), and a read-receipts
  ctx-item (`velta-mdns` "0"=off mirrored to core `mdns_enabled` — off
  also stops seen-status sync between own devices), a multi-device
  ctx-item (#117, core `bcc_self` "1"=on, default "0"; the core is the
  source of truth — no localStorage copy of the value. With it off (and
  `force_encryption` on, the default) core 2.63 deletes every downloaded
  message from every transport's relay (`ephemeral.rs`
  `should_delete_all_downloaded_messages`); there is no
  `delete_server_after` any more. State + helpers: `ensureMultiDevice` /
  `setMultiDevice` / `paintMultiDevice` in app.js, pure logic in
  `app/js/multidevice.js`. States "loading" ("…") / "on" / "off" /
  "unknown": a failed read paints the switch indeterminate
  (`aria-checked="mixed"`) and retries with `MD_RETRY_DELAYS` backoff —
  never a fake "off". `MD_HINT` sits under the row (`data-md-hint`,
  `.ctx-hint`). Switching off goes through `confirmModal` (stronger text
  when the core flipped it on since the user's last choice — the only
  "other device" signal there is). The core turns `bcc_self` on by itself
  on backup export / Add second device (imex `export_database`) and on an
  incoming sync message (sync.rs) and emits NO event (not a synced key),
  so `velta-bcc-self-choice` (localStorage JSON {accountId: {choice,
  notified}}) records the user's last choice — seeded with the first
  observed value, never rendered — and `ensureMultiDevice` (drawer open,
  rebuild, `refreshAfterBackground` resume, imex-progress 1000/0) compares:
  core "1" vs choice "0" shows the `data-md-note` note (Turn off again /
  Keep on) and, once per flip, a 12s toast with a "Turn off again"
  `opts.action`. Velta never reverts the flip itself; the state `let`s sit
  at the top of app.js because events can fire during the boot awaits),
  mirrored to the core's per-account `media_quality` config — pushed from
  `rebuildDrawer` on boot/account switch; core `set_config` takes FLAT args
  `[accountId, key, value]`, NOT a nested [key,value] pair) follow it —
  add new toggles as args to `buildDrawer` + a change handler, never
  as one-off DOM queries outside ui.js. The low-battery marker (#83,
  ANDROID-ONLY row) is localStorage-gated (`velta-low-battery-react`),
  not core config: when on, every send through
  `rpc-core.sendMessage` fires the `core._batteryGate` hook — battery
  from `get_battery_status` (JNI → Battery.kt, cached 30 s in app.js);
  under 10% and unplugged the 🪫 reaction moves to the latest outgoing
  message via `batteryReactionPlan` (tests/battery-reaction.test.mjs),
  otherwise it is cleared. Notification gates are DESKTOP-ONLY:
  on Android the Rust background poller posts notifications while the page
  is frozen and cannot run the localStorage gate (known gap). CI LESSON
  (v1.4.54): gen/android Kotlin changes have NO local compile check —
  only the CI gradle build catches them (a missing const killed the
  first v1.4.54 android job). Same for `#[cfg(target_os = "android")]`
  RUST in lib.rs (v1.4.55: ureq `.header()` vs `.headers()`, JNI guard
  lifetimes killed the first android job) — BEFORE tagging a release
  that touched any Android-only code, run
  `wsl -e bash -lc "…NDK exports per §4.3.3 (RANLIB/AR → llvm-ranlib/llvm-ar + NDK bin on PATH)… && cd /mnt/c/Users/pave/Velta/velta/velta-app/src-tauri && cargo check --target aarch64-linux-android"`
  (~8 min; the bare command without the §4.3.3 exports dies in
  openssl-src's make — 1.4.80 hit exactly that; desktop `cargo check`
  compiles the Windows cfg only).
- **Header heights** are pinned by `--head-h` (56px): `.sidebar-head` and
  `.chat-head` are border-box
  `height: calc(var(--head-h) + env(safe-area-inset-top))`. Change the var,
  not the paddings. The sidebar head's top padding carries the relay-zone
  gap below it (1.4.81) — the logo/search cluster reads its bottom
  whitespace through to the strip, so top and zone pad as a pair.
- **`.relay-line` is shared by two widgets** — the sidebar 6px sending
  strip (`#relay-line` + `.relay-line` classes) AND the relays-modal card
  rows (quilt op #15). Three properties have already leaked between them
  (height, flex, align-items — the strip went invisible when the modal's
  `align-items:center` landed): the meter block is scoped `#relay-line`
  with `align-items:stretch` pinned, the modal rule owns the class — any
  NEW property on either rule must be checked against both widgets, or
  rename the strip class when next touching it. The modal's capability
  flags (1.4.81) are neutral key-caps (`--text-dim` on `--bg-hover`) with
  a `var(--green)` corner dot on `.on` chips marking offered capabilities —
  no colored letters (the hardcoded green/silver pair measured 1.91:1 in
  light), no slash over small letters; W is probed via `probeC3Relay` (in the Tauri shells it
  invokes the Rust `probe_c3_relay`, c3_probe.rs: no Origin header, 5 s,
  strict hostname check, true only for a non-empty JSON string array —
  the WebView's tauri origin is refused by origin-gated relays; the PWA
  keeps the browser socket), I/P
  come from IMAP ServerMetadata. Under the address, `relayDetailsHtml` adds the relay's
  `/shared/comment` and `/shared/admin` (get_server_metadata, escaped text,
  never links) and its quota from the connectivity HTML (bar + %, only when
  reported). Core patch #16 adds `canIdle` / `canCompress` /
  `maxSmtpRcptTo` to get_server_metadata: D flag = instant delivery (IDLE;
  null → "not known yet" until the relay connected), recipient limit and
  "compressed connection" go in the details line (no flag).
- **History loading strip** (`#chat-load-bar`): 6px blue gradient sweep
  pinned under the chat header; turned on by `chat-view.open()`,
  `_loadOlder()`, `_loadNewer()` and `_jumpToLatest()` (paging is history
  loading too); `_loadBar()` holds a
  150 ms minimum on-time and a new on cancels a pending off; sits at
  `top: calc(var(--head-h) + env(safe-area-inset-top))`.
  ALSO driven by core connectivity: `refreshRelayStatusInner` (app.js)
  turns it on while `get_connectivity()` is WORKING (3000–3999) — the
  desktop client's "Updating…" (IMAP fetch or SMTP send; the core can't
  distinguish). It rides the relay-status coalescing (1.5 s gap guard —
  get_connectivity RPCs re-trigger ConnectivityChanged, an unguarded
  handler fed an event storm); piggyback there instead of adding
  listeners.
- **Failed sends** (post-1.4.31): red reason badge below the message
  content (`failReason()` parses the core error — LAST `Error: ` segment
  wins: "…5.3.4 Error: message file too big" → "Message file too big";
  a greedy `Error: (.+)$` regex grabs the WHOLE line, use `lastIndexOf`)
  + retry/remove buttons left of the bubble (`_syncFail` mirrors the
  template for live `MsgFailed` transitions; `m.error` rides
  `_rowSignature` so the refetch upgrades "Not sent" to the real text).
  Remove deletes FOR EVERYONE (`forAll: true`) — `state === "failed"`
  does NOT guarantee non-delivery (an oversized send can still reach the
  recipient), a local-only delete left the message alive on the other
  client. rpc-core `_mapMessage` carries `error: m.error || null`.
  Menu, selection, and that Remove confirm first, then hold the bubble
  (`deleteUndoMs`, 10s): centered "This message was deleted" plus Undo.
  `deleteMessages` runs when the bar ends or `close()` flushes the hold.
  Undo restores the whole batch and does not call the core. A remote or
  ephemeral `msgs-deleted` drops the hold so the delete is not sent twice.
- **Times are 24-hour**: `formatTime` and `formatDateTime` (format.js) force
  `hour12: false` and `hourCycle: "h23"`. `formatDateTime` is the `<time>`
  tooltip and the message-info clock. Don't reintroduce locale defaults
  (rendered `03:21 AM` on en-US).
- All `:hover` styling lives inside
  `@media (hover: hover) and (pointer: fine)` — touch devices report
  `hover: none` and hover states stick after taps. `:active` press feedback
  and non-hover states (`.relay-detail.pull-open`) stay reachable on touch.
- `app/js/diagnostics.js` is the in-app diagnostics store ("Velta
   Diagnostics" chat): console-style rows (shared `diagnosticRow()` helper),
   identical consecutive entries collapsed into one counted row, ring-capped
   at 120 rows (worst case ≈600 DOM nodes with the copy buttons; the DOM
   budget watchdog's report names the last row texts when the chat itself is
   the growth) — prefer
   appending here over toasting for repeatable background errors. The bar
   under the chat carries a pause/play button (freezes the live rendering;
   the store keeps recording, resuming re-renders to catch up), the recovery
   group "Restart: Core | UI" (`btn-restart-core` / `btn-reconnect-ui`, the
   only callers of `restartIo`/`reconnect` from the UI) and two switches:
   **Logging**
   (runtime gate on the shell log writer, `set_logging_enabled` /
   `LOG_ENABLED` in lib.rs; persisted in localStorage `velta-logging`,
   default OFF on both sides — V-09/#66: the log mirrors message content
   outside the account db, and the renderer pushes the persisted choice at
   boot so the shell never logs before that unless the user opted in — the
   Diagnostics chat itself keeps working when off, it never passes through
   `log()`) and **DevTools** (`set_devtools`: desktop opens/closes the
   WebView inspector, Android flips `WebView.setWebContentsDebuggingEnabled`
   via JNI for chrome://inspect; persisted in `velta-devtools`, applied at
   boot).
- `app/js/media.js` resolves local paths to WebView-safe media URLs:
  blobfile probe → loopback HTTP → asset protocol, with one-shot error
  fallbacks per element. In the wasm dist, after those fail, `/accounts/`
  paths (no `..`) go through the service-worker blob URL in §4.2.1.
  Details and the WebView2 media quirk:
  docs/agents/media.md. `fileUrl(path, {thumb: true})` appends `?w=720` —
  BOTH the blobfile protocol and the loopback server answer with a cached
  720px JPEG thumbnail (sha1(path+mtime+size+w) key under
  `<app-data>/thumbs`, generated in lib.rs via the `image` crate, EXIF
  orientation applied); animated gif/webp, non-static formats, Range
  requests and every failure fall through to the original bytes, so the UI
  can never regress. Bubble images pass thumb:true; the lightbox never does.
- `app/js/link-preview.js` — OG preview card for the first link in a text
  message. Fetches shell-side (`fetch_link_preview`, lib.rs — same trust
  model as `expand_invite_link`: https-only, 5 s timeout, 256 KB page /
  512 KB image cap) and inlines og:image as a `data:` URL (CSP img-src has
  `data:` everywhere; remote hosts stay out). In-memory cache per URL;
  failed fetches cached as null. **Proxy/tunnel:** the page and og:image
  go through the active account's proxy — app.js registers
  `setLinkPreviewProxySource` (reads `proxy_enabled` + `proxy_url`, first
  list entry), so the user's own SOCKS5/HTTP proxy and the Android DNS
  tunnel (tunnel.rs writes its `socks5://velta-tunnel:…@127.0.0.1` URL into
  `proxy_url`) both apply; `fetch_link_preview(url, proxy)` builds the ureq
  agent in `link_preview_agent` (ureq `socks-proxy` feature; SOCKS5 resolves
  the host on the proxy side). Fails closed: no reader / a failed config read
  means no fetch (not cached, retried on the next render), and a proxy ureq
  can't speak (`ss://`, `https://`, `socks4`) or a dead one is an Err — never
  a direct fetch. `expand_invite_link`, `probe_relay` and `fetch_page_title`
  still fetch directly. Never fetched: a registered invite URL
  (already an invite card) and any `deltachat.id` URL (short username
  links are invite cards; the rest of that host is the same service).
  Setting: drawer → “Link previews” radios, and the same three on the
  chat context menu (localStorage `velta-link-preview`, per-chat
  `velta-link-preview-chats` wins). `off` (unset and the old `"0"`),
  `picture`, `fetch`. The old global `"1"` and per-chat `"on"` read as
  `fetch`. The drawer hint is `LINK_PREVIEW_IP_WARNING` — the fetch
  reveals this device’s IP (issue #30). No confirm dialog. `picture`
  does not fetch incoming links. KEEP: the
  card slot is rendered empty (`data-lp`) and hydrates async — the
  hydration MUST call `notifyHeight()` after unhiding or the virtual
  scroller’s layout math goes stale (same contract as image decode).
  Cards never render in demo mode (no Tauri shell → no fetch command).
  `picture`: the composer shows a dismissible ghost card
  (`#link-preview-draft`) for the first finished `https://` URL
  (`senderPreviewUrl`: skip invites, `deltachat.id`, and hosts with no
  dot) and on send bakes it to a 480px image (`renderPreviewImage`: WebP
  at quality 0.72, JPEG if `toBlob` does not return `image/webp`,
  dark card `#1c1c26`, "Sent with Velta" chip in the top-right with a dim
  fill and hairline border; the live card has no chip). A landscape page
  image is drawn at the card width and its own height; a portrait page
  image stays in the 220px cover band. The live card sizes the image with
  `max-width: 100%` and a max-height so a wide image is not clipped on the
  sides. It
  sends that as a normal image with the draft as the caption
  (`_sendPreviewImage`, file `lp-<ts>.webp` or `.jpg` under `uploads/`).
  The recipient does not contact the site. `fetch` still runs
  `linkPreview()` for plain-text messages only (`receiveFetchesPreview`);
  `picture` and `off` do not. An image/file/video caption, including a
  baked card, does not fetch.
  Sending before the card is ready, or an encode failure, sends plain
  text. Dismiss remembers that exact URL. KEEP: bubble
  anchors (markdown links AND card links) are handled by the DELEGATED
  branch in the row click handler (`e.target.closest(`a[href]`)`) — the
  card's <a> is inserted async after row build, so per-anchor wiring
  never sees it. http(s) opens go through `openHttp()` (strip trackers,
  then Android in-app browser / desktop `openExternal()` =
  `plugin:opener|open_url`). See §5.5.
- `app/js/trackers.js` — drop known tracking query params (#89). Drawer
  “Strip tracking from links” (localStorage `velta-strip-trackers`,
  missing = on, `"0"` = off). Paste into the composer and opening an
  http(s) link share one list: `utm_*`, `hsa_*`, and known click ids
  (`fbclid`, `gclid`, and the rest in `CLICK_IDS`). Short names are
  host-limited so real ids survive: `si` on YouTube and Spotify, `s` /
  `t` / `ref_src` / `ref_url` on X and Twitter, `tag` / `linkcode` /
  `linkid` / `ascsubtag` on Amazon. Nothing removed → the original
  string (a clean URL is not re-serialized). Non-http schemes and invite
  fragments (40-hex hash, including OPENPGP4FPR-style) are unchanged.
  A toast “Tracking removed from link” offers Undo once (`toast`
  `opts.undo`, 6s): paste restores the clipboard text if that slice is
  still intact; open opens the original URL. Copy does not strip. Short
  links are not unwrapped. Tests: `tests/trackers.test.mjs`.
- **Native video frames replace posters (post-1.4.31)** — `poster.js` and
  the click-to-load `#active` state are GONE. `velta-video` renders a real
  `<video preload="metadata" src="...#t=0.1">` (no `controls` — Android WebView
  stacks its own large centered play button on controls videos; controls
  return only in the no-lightbox fallback via `v.controls = !videoLightboxOpener`): Chromium/WebView2
  paints frame 0 natively (the `#t` fragment forces the first-frame fetch),
  `loadedmetadata` shapes the host box to the true aspect (portrait
  videos must NOT hit the stale 200px min-width inside a styled box — it
  inflated the element past the clipped host and put the play button
  below center), `play`/`pause` toggle a centered `.velta-video-play`
  affordance, and taps route to the fullscreen lightbox
  (`setVideoLightboxOpener` — components.js must not import ui.js, cycle).
  The media-fallback chain (blobfile → media server, once) and the fail
  band stay. KEEP: heights must stay DEFINITE down the chain
  (`.msg-video[style]` → `velta-video` → `.velta-video-card` → `video`
  all `height: 100%`) or percentage resolution collapses to auto and the
  row height destabilizes (virtual-scroller unsafe).
  - Path resolution (still load-bearing): the core returns blob paths
  RELATIVE to the accounts root; `scoped_accounts_path` joins onto the
  AppLocalData root (accounts/ AND uploads/ are both under it), strips
  the `\\?\` canonical prefix before returning paths — convertFileSrc
  percent-encodes the prefix into asset.localhost URLs that 404.
  - The dead poster commands `poster_cache_path`/`write_poster` were
  removed; `read_media_bytes` stays (`attachmentBytes` in chat-view.js).
- `app/js/ui.js` — drawer, modals, context menus, toasts, update banner,
  delete-confirmation dialog. Outside the native shells the footer
  "Service worker" line is the cache name from §4.2.1, and "WebSocket
  relays" opens the list there. The drawer head shows the avatar (self
  profile sheet via `onProfile`), display name, Edit profile and **Accounts**
  (#148) — a native `<details class="acct-switch">` whose `<summary>` is
  the pill and whose `.acct-pop` content lists the profiles (current one
  checked + `aria-current`) plus, behind a `.ctx-sep`, a "Profile
  management…" row opening the tabbed lifecycle modal. The details ALWAYS
  renders — single profile included, since the popover is the modal's
  head-side door; the standalone mid-drawer "Profile management…" item is
  the second door (both open the same modal; the test pins exactly two
  `profile-management` actions). It opens with no JS; `wireDisclosure()` adds
  outside-tap/Escape close only while open (attached from the async
  `toggle` event, so the opening tap can't close it), a pick or drawer
  close sets `open = false`. Do NOT go back to `popover`/`popovertarget`
  or a `hidden` toggle. `rebuildDrawer()` calls the old drawer's
  `destroy()` (drops its document listeners) and re-opens the new drawer
  and switcher if they were open — rebuilds land asynchronously (boot,
  refreshAccounts, tunnel status, profile/relay edits) and used to drop
  the open menu/drawer and leak the old drawer's capture `pointerdown`
  listener. Tests: `tests/account-switcher.test.mjs`. `.qr-box` carries no
  background/border of its own — the core's QR SVG is self-contained.
  **Native controls (2026-10-07):** the top eight rows of
  `docs/native-elements.md` are in the app (counts in "What landed"); the
  survey tables there are the original notes. Traps: popover is used only
  when `HTMLElement.prototype` has `popover` (macOS 10.15/11 keep the
  overlay) and `#toasts` (`popover="manual"`) is re-shown after a dialog
  or lightbox; prompt modals pass `form: true` and every button has an
  explicit `type` (an untyped button inside a form submits); the QR paste
  box stays a textarea and ignores Enter during IME composition;
  `field-sizing` on the composer is behind `@supports`, with `sizeComposer`
  kept for Android 7 and Safari; day-chip `<time>` uses a local
  `YYYY-MM-DD`, not a UTC slice; a file chosen in the browser is written
  into the wasm core with `writeCoreFile` (shells still use
  `resolve_upload_path`); toast close
  is `CLOSE_SVG` at `--ico-2`. Tests: `tests/native-elements.test.mjs`.
- `app/js/mock-core.js` — self-contained demo backend when no real core is
  reachable (`localStorage["velta-mock"] = "1"` forces it). Implements the
  same contract surface as the real core, including
  `accountId`/`accountEpoch` (undefined values made `a?.x === a.x` guards
  pass on null and crashed demo mode), with no-op demos for vCard and
  backup transfer.

- **HTML mail/attachment viewer** (`_openHtmlOverlay`, chat-view.js;
  1.4.40 link fix): a sandboxed (`allow-scripts`, no `allow-same-origin`)
  srcdoc iframe — a plain link click would navigate the FRAME ITSELF and
  `target=_blank` dies in the sandbox/wry, so the overlay injects a
  capture-phase interceptor (`HTML_VIEW_LINK_JS`) that preventDefaults
  anchor clicks and postMessages the href to the parent, which routes it
  EXACTLY like chat bubble links (Android in-app browser chain / desktop
  opener plugin). The snippet's bytes are hash-whitelisted in `script-src`
  (§8) — the parent cannot reach into the opaque frame any other way.

- **Chat info actions** (1.4.41): the group/channel/1:1 sheet carries, in
  eligibility order — Edit group/channel (channels: only when the core's
  `can_send` grants it, the same rights source as the composer; groups
  keep it for every member), Add members (groups; shared multi-select
  `pickContactModal` → `addChatMembers` → `add_contact_to_chat`),
  Invite via link/QR (groups + channels; `showInvite(inviteQrProvider(
  chat.id))`), a Notifications row opening the timed mute dialog
  (`setChatMuted`: `{kind: "NotMuted"}` / `{kind: "Forever"}` /
  `{kind: "Until", duration: seconds}` — MuteDuration is an internally
  tagged enum on the wire (`#[serde(tag = "kind")]`); bare strings fail
  deserialization SILENTLY, which is exactly what broke the ⋮ menu's Mute
  (`setChatFlags({muted})`) until 1.4.51 — wire-shape regression tests in
  `tests/mute-wire-shape.test.mjs`), and a
  Disappearing messages row (`get/set_chat_ephemeral_timer`, seconds,
  official option list). Editors opened FROM the sheet replace its modal
  history entry, so every close path must `await modalHistorySettled()`
  and reopen the sheet — skipping that tears the sheet down with the
  dialog. The ⋮ chat menu carries Leave group/channel
  (`leaveGroup` → core `leave_group`; not offered for mailing lists, which
  reject self-removal) behind a danger confirmation; the
  left chat turns read-only in place (composer hidden, history stays).

- **Post-1.4.34 UI surface** — settings are checkbox rows in the drawer
  (`data-toggle` labels + change handlers in ui.js; Demo mode is the renamed
  mock toggle; Send on Enter is `velta-send-enter`, "0" = off, read by the
  composer keydown, which also guards `isComposing`; Remember scroll
  position in chats is `velta-remember-scroll`, "0" = off, default on
  (#70) — see
  "Remembered scroll position"). Profile flows live in
  one tabbed modal: `openProfileManagement()` (app.js) — Add profile (relay
  input + QR scan → `addAccountFromInvite`), Second device (provide-QR pane +
  receive hand-off), Export backup (`exportBackup` + `imex-progress`;
  desktop folder picker, Android system save dialog (the core tar is
  written in the cache and copied onto the content URI — the app-private
  `exports/` dir is not a place the user can open), and in the PWA the
  wasm branch writes the core's `.tar` into memfs `/backup/export` and
  downloads it — gzip-compressed via `gzipBytes` as
  `velta-backup-<addr>-<date>.tar.gz` (plain byte-identical `.tar` where
  CompressionStream is missing — detect by identity, the `.gz` suffix
  follows the bytes, #104). The core imports plain tars only: both shells
  route a picked backup through the `prep_backup` command (sniffs the
  `1f 8b` magic, gunzips to a temp file, else passthrough); Android's
  `resolve_content_uri_blocking` tail runs the same helper. No zip
  wrapper — restore imports the decompressed `.tar` directly), Delete profile
  (danger tab: typed-address confirm, last-profile refusal, transition
  guards; `rpc-core deleteAccount()` wraps `remove_account` with
  switchAccount's epoch boundaries and follows the core's reconciled
  selection, #100). A checkbox row above the panes, "Sync only active
  profile" (`velta-sync-only-active` in localStorage, read by
  `rpc-core init()`), quiesces background accounts: all for-all-accounts IO
  paths funnel through `_startIo()`; `switchAccount` stops the old account's
  IO only after the selection commits; `applySyncMode()` applies a
  mid-session toggle (#101). Tabs lock
  (`.pm-tabs.locked`) while a flow runs. Modals are full-screen below 600px
  viewport (`.modal-compact` opts out — confirmations use it); on desktop
  they fill the chat-list pane (width mirrors .sidebar via clamp, height
  stops above the list bar; in-chat modals stay full-screen via
  `:has(.app.chat-open)` gating — phones stop above the bottom bar in list
  context, by design: cee7084, Pavel's choice; see §11 "Phone modals keep
  the bottom bar"). Inner scroll areas inside modals are fine. Modals ride a `{velta:'modal'}` history entry — Android BACK
  closes the top modal (lightbox pattern; replacement reuses the entry,
  `modalReplacing` guard). Toasts are `<details class=toast>` bars anchored
  above the composer/bottom bar: 3px shrinking timer bar (danger red for
  errToast) whose animationend dismisses, one-line ellipsis,
  overflow-gated expand chip (re-measured after `document.fonts.ready`),
  copy button in the open pane, the house close icon in the summary. `opts.undo`
  adds an Undo button in the summary (`opts.action = { label, run }` adds one
  generic action button the same way, e.g. multi-device "Turn off again"); the click preventDefaults so the
  `<summary>` does not toggle, then dismisses. Clicking pauses
  the dismissal timer — expandable toasts via the native open/close toggle,
  one-liners by toggling pause/resume directly (they used to vanish
  mid-read). On the desktop
  two-pane layout the bar spans the ACTIVE context column only — the list
  pane in list context, the chat area above the composer with a chat open
  (`body:has(.app.chat-open)`: `#toasts` sits outside `#app`, a descendant
  selector can never match); phones keep the full-width bar. Bubbles cap at `min(480px, 90%)` (avatar rows −50px). Jump targets
  outside the loaded window (search hits, quotes, pinned bar) fetch older
  pages via `_jumpFetchAndScroll` (page cap `jumpMaxPages`) then
  `_scrollToItemSeek` — the scroller has no scroll-to-item API (a window
  opened mid-history reloads the tail first). Arrivals in local (P2P)
  chats mark-read through `markReadSoon` (400ms coalescing, flushed on
  close); other chats mark seen on screen (§5.1 "Read tracking").
- **Profile/chat info editing (post-1.4.35, merged editor per issue #16)** —
  the sheet's action row (`data-pa`) is context-shaped: ONE editor button
  opens `showEditProfile` (name + avatar + description in a single modal).
  Self = Edit profile (delegates to the drawer's `editProfileFlow`, which
  also applies `setSelfStatus` for config `selfstatus`); groups/channels =
  the same modal (`contactId: 0, kind: "group"` → `renameChat` = core
  `set_chat_name`, `setChatImage` = core `set_chat_profile_image`, null
  image clears, `setChatDescription` = core 2.62 `set_chat_description`);
  empty string clears a description. 1:1 keeps Send / Edit name (the local
  custom name) / Block, and a contact's bio stays read-only. Descriptions
  are applied only when changed (group edits inform members core-side).
  PWA/wasm: `pickProfileImage` writes the file to `/uploads/` via
  `writeCoreFile` before `setAvatar` / `setChatImage` — a data URL is not
  a path (core looks for `/data:image/...`). Mock has no `writeCoreFile`
  and still stores the data URL. `tests/avatar-upload.test.mjs`.
  MockCore mirrors all the methods —
  `tests/description-edit.test.mjs` pins the wrapper arguments and the mock
  roundtrips. KEEP: call `modalHistorySettled()` before reopening the sheet
  after an editor that closed ITSELF (`showEditProfile` does): its close
  schedules `history.back()` and the late popstate tears the reopened sheet
  down (the reopen reuses the dying `{velta:'modal'}` entry). Opening
  `showChatInfo` while a modal is still up is race-free (showModal →
  closeAllPopups replaces it and skips the history consume) — prefer that
  shape. The self branch must also refresh the sheet stub from
  `state.account` before reopening (it carries the name captured at open
  time). The 1:1 Edit-name flow still closes-then-reopens without settling —
  same latent race, so far tolerated.

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

### 5.4 Local chat, serverless P2P (`velta-app/src-tauri/src/p2p.rs` + `app/js/p2p.js` + `app/js/local-chat.js`)

A core-independent 1:1 end-to-end-encrypted transport between paired
devices on the same network (iroh QUIC, relay-less, optional mDNS
discovery). Pairing tickets, offline queues, media chunking, the
`local-chat.js` Proxy adapter and its test pins are documented in
docs/agents/p2p.md. KEEP: local chat is disabled by default — a fresh
install must not open QUIC sockets or broadcast LAN beacons unasked.
The drawer switch is also shown in the browser while the preference is
on, so "Enter local chat…" can be turned off. The typing row stays
engine-only.
Local groups (≤ 5 members, creator-signed roster, per-sender seq replay),
the typing indicator and group media (32 MiB, streamed per online member)
are protocol-2 features, documented in docs/agents/p2p.md. KEEP: every new
frame goes out only through `v2_tx`/`v2_link` (a 1.4.x peer drops the session
on a frame it does not know); group transfer ids and file names get the same
`is_safe_transfer_id`/`sanitize_name` treatment as 1:1; a `p2pg:<gid>` chat is
answered by the adapter and never reaches the real core.
KEEP also: the Proxy's relay-chat fall-throughs forward the FULL argument
list (`(t, id, ...rest)`) — an early version dropped `ids`/`{forAll}`, so
with local chat on every message deletion in normal chats failed with
serde `invalid type: null, expected a sequence` (fixed post-1.4.35).
Planned (not built): an email-backed **iroh second layer** (iroh chats
folder, "iroh" chip, live text/typing/presence with Message-ID dedup, call
signalling) that extends this engine with a relay mode and core-contact
links instead of patching core — read docs/iroh-layer-plan.md and
docs/research/iroh-layer-research.md before touching p2p.rs for it.

### 5.4.1 Large file via Lufi (#138)

Attach menu → "Large file" (Tauri shell only, not in local chats): the file
is encrypted on-device with SJCL exactly like the Lufi web client
(`app/vendor/sjcl.js` = Lufi's own sjcl.js 1.0.8, hash-pinned by
`tests/lufi.test.mjs`), uploaded slice by slice over `wss://<server>/upload`
by `lufi.rs`, and the chat gets `📦 name (size)` + `<server>/r/<short>#<key>`.
Recipients without Velta open the link in any browser; the Lufi page
decrypts. KEEP: every network call takes the account proxy from
`shellProxy()` and `lufi.rs` routes it through `link_preview_proxy` —
fail closed, never a direct fallback. KEEP: the deletion token lives only in
localStorage (`velta-lufi-files`, per account+msg), never in the message.
Server URL default `https://upload.disroot.org` (changeable in the upload
dialog, `velta-lufi-server`). Details, live round-trip recipe:
docs/agents/large-file.md.

### 5.4.2 "Velta Beam (both online)" (was "Send directly") — built-in webxdc (#138 part 2)

Renamed "Velta Beam" (manifest name, menu label, docs); internal id
`send-direct`, folder `app/webxdc/send-direct/`, `send-direct.xdc` and the
`prepare_builtin_xdc` name stay so existing messages/tests keep working.
Icon: `icon.svg` (faceted V, beam spanning the arm tips) → `icon.png` (512px, cairosvg); the build script now
packs the committed PNG. It opens as a **panel below the chat header** (in the chat-view flex flow; history shrinks, composer stays visible) (`webxdc-panel.js`
`wantsPanel`: name "Velta Beam" or `send-direct*.xdc`), height
`--webxdc-panel-h` (max(220px, 30dvh), capped at 45% of the chat view), no focus trap, no history entry; the ⤢
button expands (pushes an entry; BACK collapses), ✕ closes. Expand/collapse
only toggles classes, and reopening the open app is a no-op — the frame is
never reloaded, so a transfer survives.
Receiver progress: receivers broadcast `T_PROG {id, peer, name, have, n,
done, ok}` every 1 s (and on completion); `ReceiverTracker` (transfer.js)
gives the sender — and other receivers — a per-receiver list (percent bar,
"done" after SHA-256) and the "N receivers" status. Silent >10 s: dropped
if it had nothing, kept as "stale" if partway, done stays done.
Group fan-out (docs/agents/large-file.md "Group fan-out"): `Seeder`
(transfer.js) answers REQs from any verified piece; the source answers at
once, other seeders after 0–250 ms jitter and drop a piece seen on the
channel meanwhile (`noteChunk`), one send per piece per 1 s round, token
bucket 40 pieces/s. OFFER may carry `ph` (per-piece SHA-256/128, ≤2048
pieces) → partial seeding; without `ph` only a full verified copy seeds.
Receivers back off exponentially (1.5 s → 12 s cap, + jitter). PROG adds
`seed`/`src`; the sender broadcasts PROG `src` so it shows as a seeder.
Seeders re-announce OFFER, so late joiners see "Available now" after the
sender left. Beam is NOT on `trusted-xdc.js` (it needs no host powers).
Tests: tests/beam-fanout.test.mjs (dedupe, jitter, rate, backoff, 1 sender
+ 3 receivers with 10% loss incl. a late joiner after the sender left).

Attach menu item next to Large file: sends `app/builtin/send-direct.xdc`
into the chat and opens it. Sources in `app/webxdc/send-direct/`
(`transfer.js` = node-tested protocol: OFFER/REQ/CHUNK frames over the
webxdc realtime channel, 48 KiB chunks, windowed re-requests for lossy
gossip, pure-JS SHA-256 check; `ui.js`; `index.html`; `manifest.toml`).
KEEP: after editing them run `node tools/build-builtin-xdc.mjs` — the .xdc
is a reproducible STORE zip and `tests/send-direct-xdc.test.mjs` fails on a
stale one. Receiver saves via `webxdc.sendToChat` (normal attachment) or
Download. Host realtime wiring: docs/agents/webxdc.md.

**Group audio calls** (built-in trusted "Velta Circle" app `group-call.xdc`, host-owned full-mesh WebRTC, relay-only, cap 6; webxdc frames never get mic/camera): docs/agents/group-calls.md. KEEP: trust only by bundle SHA-256 (`app/js/trusted-xdc.js`, generated by tools/build-builtin-xdc.mjs), never by name. Every rebuild of group-call.xdc APPENDS its new hash and keeps all old ones (calls already sent to chats must keep working); never hand-edit or prune the list, and keep the folder/file names. The call is a chat card (no ringing); the in-call bar hides while the call screen is shown and uses tokens only.

### 5.5 In-app browser (Android)

Message links open without leaving the app: Custom Tab (the user's default
browser first, then any visible CustomTabsService provider) → native
second-WebView overlay → JS iframe fallback. The full chain, its JNI and
launch-context gotchas and the `<queries>` requirements are documented in
docs/agents/android-shell.md.

---

## 6. Development conventions

**Language policy: English only.** All agent output — visible replies,
thinking, code comments, commit messages, and docs — is English, matching the
project's working language. (User correction 2026-09-21 after mixed-language
replies; applies regardless of which tools or modes are active.)

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
- Semantics/accessibility and progressive rendering of the UI: read
  `docs/web-components-audit.md` (findings A1…D4 with file:line refs) and
  `docs/web-components-plan.md` (phased plan) before touching components,
  dialogs, the drawer, the chat list or message rows.
- Modals, overlays, menus, popovers, toasts and Android BACK handling: read
  `docs/modals-audit-and-plan.md` (inventory, WebView support matrix,
  `<dialog>` conversion plan; supersedes plan items 0.4/2.4) before touching
  `showModal()`, the lightbox, webxdc/HTML-viewer/in-app-browser overlays or
  the call screen. The `<dialog>` conversion in that plan has not started.
  `docs/native-elements.md` records the native controls that landed on
  2026-10-07 (popover, forms, `<progress>`, `<time>`, composer hints,
  field-sizing); its survey tables are the original notes.
- Keyboard shortcuts and accessibility beyond the component audit (focus
  order, roving tabindex, reduced motion, forced colors, contrast, text
  scaling, touch targets, TalkBack): read `docs/accessibility-and-keybindings.md`
  (Delta Chat Desktop shortcut reference, gap table, phased plan P0–P5)
  before adding any key handler. New shortcuts go through the planned
  registry (`app/js/keybindings.js`, plan P0.1), not ad-hoc `keydown`
  listeners. Enter handlers must ignore IME composition (`isComposing`).
- SVG icons are inline strings; no icon library.
- CSS is a single hand-written file (`app/css/main.css`).
- The plain `app/` tree has no service worker (`app/sw.js` was removed,
  #48). The dist worker's cache name is the content hash in §4.2.1, not a
  hard-coded constant.
- `app/vendor/` files carry local fixes for upstream bugs (the zoom
  normalization in `virtual-scroller.js` is a patch, not upstream code).
  Read `VENDORISSUES.MD` before upgrading or re-vendoring any of them, and
  re-apply the local patches afterwards.
- **Modal async flows: settle BEFORE close.** `showModal`'s `close()` fires
  `onClose` synchronously, and `onClose` handlers typically resolve the flow's
  promise with null/`false`. If the flow calls `close()` first, the close-path
  settlement wins the `settled` race and the real result is silently dropped
  (this swallowed every successful QR scan once — the reject toasts worked,
  successes vanished). Always `finish(result); close();` — never the reverse.
- **Never open the Android soft keyboard over the camera.** Focusing an input
  raises the keyboard; any scan flow must `blur()` inputs while scanning and
  focus back only when returning to paste mode (`qr-scan.js` gates its initial
  `focus()` on the camera being unavailable).
- **CSS `display` beats the `hidden` attribute.** An element with both a
  class rule `display: flex|block|…` and the `hidden` attribute stays visible
  (author styles always win over the UA rule). Add an explicit
  `.foo[hidden] { display: none; }` whenever a styled container is toggled
  via `hidden` (bit us on the splash's action/form panes).
- **No BOM when rewriting files on Windows.** PowerShell 5.1
  `Set-Content -Encoding UTF8` always writes a UTF-8 BOM, and tauri-build's
  JSON parser dies on it (`unable to parse JSON Tauri config file … expected
  value at line 1 column 1`) — it killed both release workflows of v1.4.24
  (Windows + Android) at the `velta-app` build-script step while every other
  tool (cargo, node, browsers) accepted the BOM silently. Rewrite files with
  `[IO.File]::WriteAllText($f, $text)` / `WriteAllBytes` (BOM-less UTF-8), or
  after any `Set-Content -Encoding UTF8` sweep, check and strip the
  `EF BB BF` leading bytes of every touched file before committing. Full
  incident: `docs/agents/release-ci.md`.

### 6.3 Python

- `black` and `ruff` with `line-length = 120`.
- `isort` profile set to `black`.
- Both `core/python` and `core/deltachat-rpc-client` use `pyproject.toml` and
  `setuptools`.

### 6.4 Visual design
- Token snapshot: `design/velta-design-system.html` + `.svg`. Header version
  matches APP_VERSION. 2px spacing grid; odd steps on the ladder are amber
  documented exceptions (bubble `7 10 6`, composer `13`, ±5 media bleed,
  pin-tray `9`) — do not snap them to even pixels.
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
  always measure the actual combination. Bubble-internal `.btn-text`
  actions ("Show Full Message…", transfer Retry) are scoped per surface in
  main.css: `.msg-row.out` uses `--text-meta-out`, light incoming a darkened
  `#1a68b8`, brutal incoming `--accent-2` — raw accent fails on all three
  (3.0/2.85/1.67 plus 4.19 on brutal incoming). Keep new inline buttons on
  those scoped rules, not bare `.btn-text` inside a bubble.
- **Identity avatars (user contacts)** always render the color matrix as the
  background — never a solid color. The matrix uses equal-height rows
  (3 squares / 2 rects / 2 rects / 3 squares), deterministic per-fingerprint
  colors, and never places similar hues on neighboring cells (see
  `colorForCell` in `avatar.js`). The fingerprint glyph sits on a soft-black
  badge (`#1c1c1c`) in soft white (`#f4f4f4`); a contact's photo replaces the
  glyph as a rounded square padded inside the matrix with a thin dark ring.
  On a fine pointer with hover, a custom photo (`.velta-avatar-photo`) in the
  chat header and the profile sheet grows to fill the tile, matching message
  rows (#39). Group/channel avatars are exempt (solid color + photo/initials).


- **Contrast is a hard rule for every text (2026-10-20).** All text meets
  WCAG AA: **4.5:1** for normal text, **3:1** for large text (>= 24px, or
  >= 18.66px bold) and for meaningful icons and UI borders. It must hold in
  **dark, light and brutal**, on **incoming and outgoing bubbles**, and with
  **custom accents** (Chat appearance; test at least a dark, a mid and a
  light accent such as yellow `#f2e14c`). Accent-colored text uses
  `--accent-text` (UI) / `--accent-text-in` (inside bubbles); ink on accent
  fills is `--on-accent`; sender names go through `senderColorVars`
  (chat-view.js); a custom accent derives every one of them with
  `deriveAccent` (chat-appearance.js), which must keep them >= 4.5:1.
- **Tokens only in reworked areas.** Calls, the group call bar/app, Chat
  appearance, device info, settings export, multi-device note, message
  labels: colors come from custom properties; `var(--x, #hex)` fallbacks are
  banned app-wide (every token is defined). `tests/design-token-guard.test.mjs`
  enforces it; the 1:1 call screen uses the `--call-*` tokens.
- **UI change checklist** (before committing any UI change):
  1. Tokens, not raw colors/sizes; new tokens go into `:root`, light and
     brutal as needed, and into `design/velta-design-system.html` + `.svg`
     (restamp the header with APP_VERSION and the date).
  2. `node --test tests/` (includes `bubble-label-contrast` and
     `design-token-guard`).
  3. `node scripts/e2e-contrast.mjs` (mock core; every theme × default,
     dark, mid and yellow accent; lists each offending element with its
     ratio; `--quick` = default + yellow, as in CI). Zero violations.
  4. `node scripts/e2e-narrow-overflow.mjs` after layout changes.
  5. Built-in webxdc apps (Beam, Circle) changed:
     `node scripts/e2e-xdc-contrast.mjs [--shots DIR]` (dark/light ×
     in Velta / not in Velta at 360px; also fails on horizontal overflow,
     a raw id in the text or a wrong velta.cc line). Zero violations.
- **Full contrast run takes ~20 min** (`--quick` alone is ~7 min, mostly
  waits). Give it that budget: a caller time limit kills the browser and
  the script then dies with "Target page, context or browser has been
  closed" — that is the timeout, not a real failure.
- **Webxdc design tokens.** A webxdc cannot load Velta's CSS, so each
  built-in app bundles `velta-tokens.css` (colors, radii, font size from
  main.css's dark `:root` and light blocks, light via
  `prefers-color-scheme`, plus a `--sp-*`/`--fs-*` scale), generated by
  `node tools/build-builtin-xdc.mjs` into `app/webxdc/{send-direct,group-call}/`.
  Never edit the copies; `design-token-guard` fails when one drifts from
  main.css or when the apps use raw colors/font sizes. The velta.cc line
  shows only without `webxdc.veltaCall`; never mention any other velta.cc
  host in the apps.

### 6.5 Profiling (JS + Rust)

Linters don't find runtime bottlenecks. Use:

- **JS (WebView):** Chrome/Edge DevTools → Performance while scrolling the chat
  list or opening a busy chat. Optional: wrap hot paths with
  `performance.mark` / `performance.measure` (event batch handling, chat-list
  refresh, markdown render) and read them in the same flame chart.
- **JS on phone:** Android Studio Profiler on the WebView process when DevTools
  isn't enough (CPU + memory).
- **Rust (desktop):** `cargo flamegraph` (or `samply` / `perf`) on a release
  build for sync / p2p / Tauri command cost. Criterion benches for small pure
  functions.
- **Rust on phone:** Android Studio CPU profiler / `simpleperf` on the
  in-process core.

Skip Lighthouse for the installed app; it's only weakly useful for PWA mode.

### 6.6 Public-repo hygiene — private relay identifiers (hard rule)

This repo is public; the operator's relay is private. NEVER commit the
relay's domain, its IP, the hosting-provider name, or the short host
label — not in code, docs, tests, commit messages, issue text, or release
notes. Docs and tests use `relay.example.org` / `<relay-domain>` /
`<relay-ip>` placeholders. Before EVERY push, this sweep must be empty
(binary PNG hits are fine):

```bash
git grep -nE "aeza|95\.181\.162\.170|\ba7\b" -- '*.md' '*.mjs' '*.js' '*.rs' '*.toml' '*.json'
```

On 2026-10-09 the identifiers leaked into 6 commits across 2 sessions and
the whole history was rewritten with `git filter-repo`
(--replace-text + --replace-message; force-push `88f15966` → `15372ed`).
Consequences to remember: commit SHAs from 2026-10-09 cited in old notes,
chat summaries, or issue bodies are DANGLING (pre-rewrite); old SHAs stay
fetchable on GitHub by exact SHA until GC; and any other working copy of
this repo must `git fetch && git reset --hard origin/master` before its
next push or the tainted commits come back.

---

### 6.7 Pitfalls found in 1.4.70 (and how to avoid them)

- **Timestamp units.** jsonrpc `ChatListItem.lastUpdated` and message `timestamp` fields: check the Rust type in `core/deltachat-jsonrpc/src/api/types/` before scaling. `lastUpdated` is already **milliseconds** (`get_timestamp() * 1000`); multiplying again gave year 58757. Never assume seconds; a 2-digit year format hid this bug for months. Tests with a fixed clock must assert the full year.
- **Date math uses calendar days**, not `(now - ts) / 86400e3` windows (`calendarDaysAgo` in `format.js`). Never pair `hour12:false` with `hourCycle:"h23"` (node/WebView then print "24:05").
- **Bundled assets sent to core (Tauri).** Don't fetch an app asset in the WebView and write it with the fs plugin before passing the path to core: on Android the bytes came out corrupt, core still sent an empty webxdc, and opening it showed "not found". Embed with `include_bytes!` and write from Rust (`builtin_xdc.rs`, `prepare_builtin_xdc`), validate (zip with `index.html`, read back), and **never send a message unless the file validated**; show an error toast instead.
- **PWA persistence is snapshot-based.** Anything that must survive a reload (avatar, profile, chat image, sent blobs) must await a checkpoint before reporting success; snapshots export DBs first, then list blobs, so a DB row never points at a missing blob.
- **Verify the claim, not the commit.** "Fixed on tip" isn't fixed until reproduced on the deployed build: check the served `sw.js` cache name, and for Android check the release APK. Subagent or reviewer statements like "timestamps are converted from seconds" must be checked against the code.
- **Read the user's words literally.** "above app logs" meant the App log bar, not the logo; ask or re-read before moving UI.
- **Releases.** Run the full node suite and look at real dates/times in a screenshot of the chat list before tagging. Tag only after AGENTS/docs reflect the release.

### 6.8 Pitfalls found in 1.4.71

- **Map every viewtype in `_toCoreViewtype` (rpc-core.js).** Unknown types fall back to `"Text"`; a webxdc sent as Text+file never becomes a Webxdc message, `get_webxdc_blob` fails and `webxdc_serve` answers its 404 body `not found` — the "Send directly not found" bug that survived c0a6d6f (fixed e25678b, `tests/send-webxdc-viewtype.test.mjs`). When adding a viewtype, add its case and a test.
- **Menu buttons that toggle (#136):** use `bindMenuToggle` (ui.js) — it swaps in the X icon and restores it on ANY close because it watches the menu leave the DOM; don't restore icons from individual close handlers.
- **Never move a webxdc iframe in the DOM** (it reloads and kills a Velta Beam transfer); panel/expand states are CSS classes only.

### 6.9 Pitfalls found in 1.4.72

- **No `.mjs` under `app/`.** nginx (the live PWA host) serves `.mjs` as `application/octet-stream`; Chromium's strict module MIME check rejects it, so `vendor/sjcl.mjs` (via lufi.js) stopped app.js and the splash never rendered. Renamed to `vendor/sjcl.js` (60b4cef); `tests/no-mjs-runtime-modules.test.mjs` forbids `.mjs` modules/imports. Don't fix this with server MIME config.
- **TDZ during the top-level core await.** app.js suspends on `await coreStartupPromise` (worker-wasm init, 10+ s on phones) while the early Diagnostics chat is already tappable; openDiagnosticsChat → renderChatList hit module consts declared further down (`chatCatsEl`, then `chatItemGhostIO`): "Cannot access 'chatCatsEl' before initialization". Fix (4abf905): `globalThis.__veltaAppEvaluating` is set just before the await, renderChatList defers while it is set, and the module end clears it and flushes the deferred render (`tests/chatlist-tdz-boot.test.mjs`). Anything reachable from UI events before module end must not touch later-declared consts; reproduce by delaying the `.wasm` fetch in Playwright and tapping Diagnostics.
- **The shim must not force `color-scheme` on app documents.** Setting `color-scheme: dark` on the app's `<html>` turned default text light while apps that only paint a white background kept it: white on white (poll app). Leave the document scheme to the app; the iframe element keeps Velta's scheme for `prefers-color-scheme` (10141f7).
- **`setUpdateListener` is a subscription, not one batch.** The shim kept the listener for one batch, called it with a fake `{done}` object and ignored `getStatusUpdates`' result, so polls lost state on reopen and missed live updates. Keep the listener, replay stored updates from the given serial, then stream (c91ee58, poll state).
- **Webxdc info messages** (`sendUpdate({info})`, viewtype WebxdcInfoMessage) render with the app icon; a tap opens the parent instance at the update's `href` (query/fragment only); `sendStatusUpdate` passes the whole update to core (c91ee58).
- **Async row hydration must survive virtual-scroller detaches.** Webxdc card hydration aborted when the row was detached mid-fetch, leaving forwarded cards on "app" + placeholder; retry on reattach instead of aborting (c91ee58).
- **PWA webxdc host (7834065; KEEP rules in docs/agents/webxdc.md).** The SW serves a loader page for `<scope>webxdc-run/...` frame navigations with a CSP-header sandbox (no allow-same-origin → opaque origin, blob:/data: only). The iframe ATTRIBUTE must include `allow-same-origin`, or Chromium never routes the navigation through the SW; the response sandbox makes it opaque. Must-keep safeguards: frame.js refuses to run unless `self.origin === "null"` in a child frame; every other same-scope frame navigation and top-level app loads get 403 + sandbox; the host hands the `.xdc` only to the open app's own frame.
- **Live PWA deploy is manual** (the private relay host — see private notes; nginx root `/var/www/html`, PWA in `app/`; never edit nginx/postfix/dovecot configs). Build `node scripts/build-pwa.mjs` (no `--ws-proxy`), `node scripts/verify-pwa-dist.mjs`, refresh `pwa-dist` (orphan commit, force-push, keep its README), then copy the tree (no `.git`) to `/var/www/html/app.new`, `chown -R www-data:www-data`, `mv app app.prev-<timestamp>`, `mv app.new app`. Verify over HTTPS: `sw.js` VERSION, JS served as `application/javascript`, fresh-profile boot to the splash version line. Rollback: `mv app app.bad-<ts> && mv app.prev-<ts> app`. An already-open old build needs a reload or two (the first load after a deploy can still run the old SW's cache).

### 6.11 Narrow viewports and the interface scale (2026-10-18)

- **CSS zoom multiplies viewport units.** The interface scale zooms `<html>` (`ui-scale.js`); under zoom, `100vw`/`100dvh` are multiplied too, so full-screen sheets were 414px wide on a 360px phone at "Large" and every modal (About, chat info, relays, profile, QR) was clipped on the right. main.css now sizes only with `--vw`/`--vh`/`--dvh` (= unit / `--ui-zoom`, written next to `zoom` by `ui-scale.js` and `applyUiScale`); `tests/narrow-viewport-css.test.mjs` forbids raw vw/vh/dvh. JS positions from rects/`clientX`/`innerWidth` must be divided by `uiZoom()` (ui.js) before writing `style.left/top` (`placeMenu`, attach menu, quote chip, local-chat queue pop). The crop overlay still mixes spaces at scale != 1.
- **Fixed min-widths inside bubbles.** File/app/voice/audio/call/transfer cards had `min-width: 180–240px`, wider than a bubble on a 320px phone with avatars; cap them with `min(Npx, var(--bubble-inner-max))`. Flex text columns need `min-width: 0` + `overflow-wrap: anywhere`, and `.bubble` uses `overflow-wrap: anywhere` (not `break-word`, which leaves min-content wide).
- **Key/value rows wrap.** `.info-row` is `flex-wrap: wrap` with shrinkable `.k`/`.v` (`min-width: 0`, `overflow-wrap: anywhere`); the value drops under the key instead of clipping.
- **Audit:** `node scripts/e2e-narrow-overflow.mjs [--shots DIR]` (mock core, 320x640 and 360x740, UI scale 1 and 1.15, plus the chats and the Chat appearance drawer section at 10 px and 22 px message text with 0 px corners; flags elements past the right edge or clipped by overflow hidden; intentional `overflow-x: auto` scrollers are skipped). Run it after any layout change.
- **About → Show device info** (`app/js/device-info.js`, `tests/device-info.test.mjs`): native `<details>` + wrapping `<pre>`, Copy (clipboard + toast) and Share (`qr-actions.shareLink`: Android `share_text`, else Web Share; hidden when neither exists). Never add account identifiers to it.

### 6.12 Release 1.4.75 (2026-10-18): issues and fixes

- **Narrow-viewport overflow / zoom** (98fe557): the interface scale zooms `<html>`, and zoom multiplies vw/vh/dvh, so phone modals overflowed at "Large". The rules are in §6.11 (`--vw`/`--vh`/`--dvh`, `uiZoom()`, `min(Npx, var(--bubble-inner-max))`), with `scripts/e2e-narrow-overflow.mjs` as the audit. About → Show device info shipped with it.
- **Phone modals keep the bottom bar** (2a54ffa): ec910ce made chat-list task modals full height. It was reverted in e34a1bb by Pavel's decision: modals opened from the chat list stop above the bottom action bar (cee7084), and inner scroll areas are fine. The e2e now fails if a phone modal covers the bar. See the §11 rule.
- **Multi-device clarity** (bf450bc): a failed `bcc_self` read shows "unknown" and retries, never a false "off". Turning it off asks first. The core silently re-enables `bcc_self` (backup export, Add second device, sync message); Velta remembers the user's last choice per account (`velta-bcc-self-choice`), re-checks on drawer open, resume and imex end, and shows a note and toast with "Turn off again". Never revert it automatically. The auto-download-limit hint was corrected: oversized files stay on the relay, the limit does not only cap second-device history.
- **Push notifications section, Android** (d571598, Refs #140): UnifiedPush distributor picker, Off, relay push support and last push time. `app/js/push-settings.js`, `tests/push-settings.test.mjs`, docs/agents/android-shell.md. #140 stays open; commits use "Refs #140", never Closes.
- **Chat appearance and hyphenation** (add0045): per-device `--msg-font-size`, corners and accent applied pre-paint by `js/chat-appearance.js`. Per-message `lang` drives `hyphens: auto`; machine text stays manual. See §11 and `docs/chat-appearance.md`.
- **Settings export / apply** (b2b95b0): one whitelisted `Velta settings v1` text in Saved Messages, with a strict parser and a diff confirm before apply. See §11 and `docs/settings-transfer.md`.
- **Reactions scaling** (74c2d14): in-bubble reaction chips ignored the text size. They inherited 16px from `button { font: inherit }`, not the 13px in their own rule. They now use `calc(var(--msg-font-size) * 16 / 15.5)` with em spacing, which is unchanged at the default. Before scaling anything with the text size, measure the computed size first: a later `font: inherit` can override the declared one.

### 6.13 Release 1.4.76 (2026-10-20): issues and fixes

- **Velta Circle group audio calls** (1425420 → cff054f): trusted built-in webxdc (hash list, §5.4.2), host-owned full mesh via TURN, cap 6, chat card instead of ringing, ended card, rename + icon. Webxdc frames are denied mic/camera/screen/location on every shell (e21d17f). docs/agents/group-calls.md.
- **Calls** (249328c, 5511db0, 39ff547, 36873b8): the mic is actually sent, earpiece by default, video calls with camera toggle/flip, PWA call path with TURN hostname fallback; permission is checked/asked before every getUserMedia.
- **VPN toggle stalled IO** (f2eac32): the network watcher resumes core IO after a grace period on any network signal, plus a periodic safety net and the native `velta-network` event.
- **Core 2.64.0** (b940e0d, 094b49f, 2225de8): patch #11's pin yields to upstream's send-failure fallback; migration 169 is one-way, back up before upgrading. `velta-core-service` archived (fec71ac).
- **PWA** (d4ef4f9, d1029f8, 5204178): background Web Push (docs/agents/web-push.md); velta.cc/web published by `pwa-web.yml`, never with a baked-in relay.
- **Design system + contrast** (018f96d, 3ec2e38, 5cb7a5c): §6.4 hard rule, `e2e-contrast` in CI, token guard; Beam/Circle on bundled `velta-tokens.css`; webxdc card Start on its own row, no "tap to open" (f14252e).

### 6.10 Pitfalls found in 1.4.73

- **Code without a CI build rots silently.** d4632e7 (bridge token gate) was committed without compiling `velta-core-service` and no workflow built it, so five compile errors sat on master (fixed d80dc01), and the sidecar's tokio misuse (blocking_read in the forwarder task, `tokio::spawn` on a JNI thread) crashed it on a device (a1cf215). `core-service.yml` now runs clippy + tests on host and aarch64-linux-android with the committed `Cargo.lock` (`--locked`). Every crate that ships needs a CI job; if you can't build locally, say so and don't merge until CI is green.
- **Line-ending-only commits mislead `git blame`.** The EOL renormalization (4044bce) shows up as the last change of every line it touched; use `git blame -w --ignore-rev 4044bce` (or `log -L`) before calling code "new" or attributing a bug. Keep EOL fixes in their own commits; plists must stay LF (d0214db).
- **Verify audit claims before acting on them.** The audit flagged `dialog:allow-save` (capabilities/mobile.json) as unused, but the Android backup export needs it (`tests/backup-export-android.test.mjs`); `infoFor` (webxdc-manager.js) looked dead but chat-view.js uses it for info messages. Grep every caller, run the tests, and keep a finding open until it's reproduced.
- **The wasm rename needs a rebuilt wasm.** wasm-bindgen glue embeds its output name (`velta_wasm_bg.wasm`), so renaming old `deltachat_wasm*` artifacts doesn't work; `build-pwa.mjs` refuses them (f37ebdf). Use a `wasm-core (opt-in)` run on/after f92d41e, then `wasm-opt -Os`.
- **velta.cc/web/ (GitHub Pages) is CI-published** by `.github/workflows/pwa-web.yml` after each successful master wasm-core run (or dispatch): it rebuilds the dist from the run's wasm with NO `--ws-proxy` (the workflow fails if `wsProxyUrl` is non-empty — the relay host must never appear on public velta.cc) and commits `web/` to the `website` branch (normal commit, no `.br/.gz`). A cross-origin page mints `/new` through the relay's `/cm-new/` (worker-wasm `relayBase`); a relay used from there must list `https://velta.cc` in `ws_allowed_origins` and both nginx origin maps. Separate origin = separate profiles/OPFS/push subscription from the relay-hosted PWA.
- **Remove stale files from the host after a renaming deploy.** The deploy copies a fresh tree, but check that no `wasm/deltachat_wasm*` (or other renamed leftovers) remain in `/var/www/html/app`; the SW VERSION covers file names, so the new cache never references them.

### Device-chat texts (Velta wording, no core change)

Core writes its device messages from stock strings. `app/js/velta-strings.js`
holds Velta's versions and `JsonRpcCore._applyVeltaStrings()` sends them with
`set_stock_strings` on every boot/reconnect (they are in-memory, process-wide).
The Velta welcome IS core's `core-welcome` message (StockMessage 71), so core
adds it once, at the first configure only; already-configured accounts carry
that label and never get it; imported backups are skipped by core.
`_prepareFirstConfigure()` claims `core-welcome-image` (empty message) on
unconfigured accounts so the Delta Chat photo never lands. Tests:
`tests/velta-device-messages.test.mjs`.

### @mentions (no core change)

`app/js/mentions.js` + docs/mentions.md. Wire format is plain text
`@Name (XXXX)` (XXXX = first fingerprint group, from `avatar.js
fingerprintFor`). chat-view loads the open group's members + codes
(`_loadMentionMembers`, ≤600 ms before first paint), passes them to
`renderMarkdown(text, { mentions })` and the picker; `_mentionKey` is part
of the row-cache signature. Muted-chat notify exception: `app.js`
incoming-msg (`mutedChatAllows`) and Rust `bg_notify_incoming`
(`mentions_in_muted`, `text_mentions_name`, name only). Tests:
`tests/mentions.test.mjs`.

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

Regression suites (Node's built-in test runner, no dependencies). Run the
whole set — 143 files, 988 tests as of 2026-10-25 (1.4.82: languages #129,
app catalog #137, chats in common #171, invite-card swipes #87; New channel #155,
click-to-copy `` `code` `` spans #156, pin-tray permissions #157; 1.4.80: +link actions
(#161: menu Copy/Open, touch-only Share, mobile Show-links list), bubble
action bar with reaction row + tray, known-contacts filter; post-1.4.76: +reply threads / thread panel + live counts, Unread chip, Velta device messages, @mentions, msg-id cache race; 1.4.76: +group calls, call permissions,
network resume, contrast/token guards, webxdc tokens; 1.4.75: narrow-viewport CSS guards, device info,
chat appearance, hyphenation, settings export/apply, reactions scale):

```bash
node --test tests/
```

Chat-list time (`app/js/format.js` `formatListTime`/`formatDay`,
`tests/format-list-time.test.mjs`): LOCAL CALENDAR days, not a 24 h window —
today `HH:MM`, yesterday `Yesterday`, 2–6 days ago weekday, same year `Oct 3`,
older with year; future timestamps never get a weekday. Never pass
`hour12:false` together with `hourCycle:'h23'` (V8 renders 00:05 as 24:05).

Instant View research (AMP vs Readability vs JSON-LD, not implemented):
`docs/research/instant-view-research.md`.

Own-reaction toggle (`app/js/reactions.js`, `tests/reaction-toggle.test.mjs`):
core `send_reaction(acc, msgId, list)` REPLACES our whole reaction set, so
`[]` removes it and `[e]` replaces it; Velta keeps one emoji per sender.
`reactionToggle(reactions, emoji)` → `{send, removing, reactions}`: tapping
the emoji we already sent removes it, any other replaces it. All entry points
(chips under the bubble, desktop quick-reaction menu, phone sheet incl. the
emoji tray, message-info chips) go through `ChatView._toggleReaction`, which
patches chips optimistically via `onMsgUpdated` and rolls back + toasts on
error. `core.setReaction(chatId, msgId, list)` (rpc + mock) is the wire call;
`addReaction`/`clearReaction` stay for the battery marker. Chips are
`<button aria-pressed>`; our emoji is `.mine` / `aria-pressed="true"` in the
chips, the sheet (`showMessageSheet({selected})`, shown first if not in the
grid) and the context menu (`pressed` item → `.ctx-item.pressed`). Local P2P
chats (`chat.isP2p`, 1:1 and groups) carry no reactions (`reactions: null`,
`addReaction` not proxied), so the React entries and chip taps are off there.

Recent commands (#135, `tests/recent-commands.test.mjs`):
`app/js/recent-commands.js`. Sending a message whose first line starts with
`/` (not edits) records that first line, trimmed, ≤64 chars, into
localStorage `velta-recent-commands` = `{acc: {global: [...], chats: {chatId:
[...]}}}` — distinct, most-recent-first, capped 10 per list (≤200 chats per
account, oldest pruned). Lookup is PER-CHAT, falling back to the account-wide
global list when the chat has none. When composer text starts with `/` (single
line) a `role=listbox` `<ul id=recent-commands>` is appended inside
`#main-composer` (made `position: relative`), `bottom: 100%`, prefix-filtered
case-insensitively. Textarea gets `aria-autocomplete/aria-expanded/
aria-controls/aria-activedescendant`. ArrowUp/Down move, Enter/Tab insert the
active option (Tab with none = first), Escape/blur/send hide; Enter with NO
active option still sends. Selection inserts `cmd + " "`, never auto-sends.
Option taps `preventDefault` on pointerdown/mousedown so the Android soft
keyboard stays up. `_bindComposer` keydown calls `handleKey` FIRST. There was
no @-mention autocomplete to reuse; styles mirror `.ctx-menu`.

Attach menu apps and commands (#137, `tests/app-browser.test.mjs`):
the attach menu adds two `<details>` — Apps (10 most recent webxdc apps
this account sent or opened, plus Browse apps…) and Commands (the same
per-chat list; a tap inserts `cmd + " "`, never sends). Recent apps are
localStorage `velta-recent-apps`. Browse loads `{mirror}/xdcget-lock.json`
through core `get_http_response` (the page CSP has no https connect-src).
The default mirror is `https://apps.testrun.org`; extras are
`velta-xdc-mirrors` (≤8). The last mirror that returned a non-empty catalog
(`velta-xdc-mirror-ok`) is tried first; a throw or an empty index skips to
the next. A download is sent only when `isValidXdc` accepts it, from that
mirror's `cache_relname`.

UI language (#129, `tests/i18n.test.mjs`): English in the source is the
key. `app/locales/fr.json` and `ru.json` map that key to a translation; a
blank or missing value stays English. Settings → Language (also the
`language` line in a settings export) stores `velta-lang` as `fr` or `ru`
and reloads; English removes the key. `documentElement.lang` follows it
(`ui-scale.js` before first paint). `t()` runs in menus, toasts, modals
and footer buttons, and `translateTree` fills `data-i18n*` in `index.html`.
Drawer rows whose label is `Something: on/off` stay English. Picker names
are English, Français, Русский and are not translated. Velta, Velta Circle,
Velta Beam, QR, Delta Chat and chatmail stay as written.

Hashtags (#134, `tests/hashtags.test.mjs`): `app/js/hashtags.js` finds
`#tag` (Unicode letters/marks/digits/`_`, at least one letter, ≤64 chars,
`#` must start a word — `C#`, `&#123;`, `a#b`, `##x` stay text; `#123` is an
issue number, not a tag). markdown.js scans only the text left after
[label](url), bare and scheme-less links, so URL `#fragments` are never tags,
and renders `<button type="button" class="hashtag" data-hashtag="#tag">`
(native focus + Enter/Space). chat-view's row click dispatches
`velta-hashtag`; app.js `openChatSearch(prefill)` opens the existing
"Search in chat" modal prefilled (core `search_messages` scoped to the
chat; P2P chats filter loaded rows). `` `code` `` spans (#156,
`tests/code-span.test.mjs`) are taken out before links, emphasis,
hashtags and mentions: a paired same-line backtick span renders
`<button type="button" class="msg-code" data-copy-code>` and chat-view
copies its text on click. Unpaired, empty, or cross-line backticks stay
literal. There is no fenced code block.

The suites pin renderer logic without a browser: account isolation
(rpc/chat/app), event polling, message-update hardening, read tracking,
scroll restore, incremental chat list, category bar, local groups/media/typing,
plus the newer areas — relay-line connectivity parsing, the offline
escalation (`relay-offline-state.test.mjs`) and the #102
delayed-send state machine (`relay-send-error.test.mjs`), profile deletion
wrapper boundaries (`delete-account.test.mjs`), the sync-only-active IO
funnel (`sync-only-active.test.mjs`), wasm worker boot/checkpoint ordering
driven through the real worker script (`wasm-boot-order.test.mjs`), the
identity-backup crypto + restore-ordering pins (`identity-backup.test.mjs`),
the refresh lock wait (`wasm-session.test.mjs`),
numbered OPFS snapshots + sqlite export (`wasm-opfs-snapshot.test.mjs`),
identity-restore checkpoint-before-reload and SW update (`pwa-update-and-restore.test.mjs`),
backup export naming/gating + gzip round-trip (`backup-export.test.mjs`),
PWA notifications + wake-lock wiring (`pwa-notify-wakelock.test.mjs`),
the splash version line (`splash-version.test.mjs`), and
the modal-history
contract — join-invite confirms AND the add-relay reopen points
(`join-invite-flow.test.mjs`).

The local-chat suites (`local-*.test.mjs`) pin the adapter contract of local
groups (ids, ticks derived from per-member acks, system lines, member
management), group media (per-member transfer state, aggregated bar, Retry,
de-duplication) and the typing indicator (3 s repeat / 5 s idle sender, 6 s
expiry, the off switch, multi-name text). The engine side is covered by the
`p2p::tests` Rust unit/integration tests (`cargo test --lib p2p::` in
`velta-app/src-tauri`).

These cover the account-isolation contract: stale account results (A→B→A),
entry-account-pinned RPCs, view lifetime across close/reopen, per-account
drafts, popup settlement, attachment flows (the image preview modal is
settled by clicking its Send button in the stub DOM), and the event
long-poll contract: expired `get_next_event_batch` requests stay registered so
their late responses are dispatched (never dropped) and dispatched exactly
once, with account attribution still enforced; a batch re-polls immediately
(no per-event pause, #25), `velta_core_events` notifications (Android
batches forwarded by the Rust poller) are dispatched the same way,
handlers run in arrival order and a stuck handler
holds the queue for at most `eventHandlerStallMs`. The hardening suite pins the
event-storm defenses: duplicate message updates take the changed path at
most once (no repeated `onItemHeightDidChange` for unmounted rows), row
signatures survive unmounted updates, and `msgs-changed` bursts collapse
into one tail refetch per gap. The chat list refreshes incrementally
(#25): `chatlist-changed` refetches the entry ids (plus items only for new
chats), `chatlist-item-changed{chatId}` refetches that one item, bursts
coalesce into one trailing refresh, the archived count uses ids only,
Diagnostics appends patch their row locally without chat-list RPCs, and
local chat (`velta-p2p`) or cores without `chatlistEvents` keep the full
refresh. Opening a chat costs one `getChat` (a single chatlist item, never
the whole list), handed to `chatView.open(chatId, chat)`. Row mounting is
windowed (#44): the first `CHAT_ITEM_FULL_ROWS` (40) rows are full
`<velta-chat-item>`s, the rest are fixed-height `.chat-item-ghost` divs
(66px — one real row) that an IntersectionObserver (600px rootMargin)
upgrades as they approach the viewport; ghosts are never downgraded, and
environments without IntersectionObserver (the headless harness) mount
everything as before. Item data for every row is always in `state.chats`
(one bulk RPC), so an upgrade is pure DOM work. Run them after touching `rpc-core.js`,
`app.js`, `chat-view.js` or `ui.js`.

Known-broken (pre-existing, re-checked 2026-09-26 on v1.4.38): the DOM
stubs now implement `addEventListener`, so the chat/app suites run, but
`app-account-isolation` fails cases 10–14 (late getChat completion/rejection,
account-listener refresh) and `chat-account-isolation` fails 17 (attachment
send retarget) and 23 (close cancels settling). Compare against master
before blaming a change; every other suite, `read-tracking` included, is
green.

Beyond that, the primary verification path is manual:

1. Open `app/index.html` in a browser. Force demo mode with
   `localStorage["velta-mock"] = "1"` (or the drawer's "Demo mode"
   checkbox) to verify UI behavior without a backend; the mock ships demo chats,
   media, and a 2400-message chat for scroller testing.
2. Run a real backend (`deltachat-rpc-server`, the Tauri app, or the Android
   service) and confirm the transport switches from mock to real.

For end-to-end verification against a **real core** (message delivery,
deletion requests, SecureJoin), the setup used during development is:

1. Serve `app/` from any static server with `Cache-Control: no-store`
   (avoids stale module caching in the browser). The ready-made option is
   `python tools/serve-dev.py [port]` (default port 8747) — it serves `app/`
   with `Cache-Control: no-store`. Plain `python -m http.server` sends no
   cache headers, and Chromium will then keep serving heuristically-fresh
   modules for hours without revalidating them.
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

### Bounded in-memory caches (`app/js/lru.js`)

Renderer caches use the shared `LruCache` (Map-backed; evicts LRU while over
`maxItems` OR `maxBytes`; bytes = string length×2 or a `sizeOf` fn;
`canEvict` pins entries, `onEvict` hook). Don't add a plain `Map` cache that
grows per contact/URL/message, and don't use WeakMap for string keys.
Limits (agreed: ~2 MB or 100 items, whichever first): avatar `svgCache` /
`bgCache`, link-preview `CACHE` (in-flight promises removed on settle),
webxdc `infoCache` (also cleared on account switch). Exceptions:
chat-view `_rowCache`/`_rowSigCache` 300 rows, never evicting a row that
`isConnected`, eviction drops the signature too; avatar `fprCache` 1000
contacts (pending promises pinned); rpc-core `msgIdCache` 20 chats / 2 MB.
webxdc `serials` stays a plain Map on purpose: it is the delivered-serial
watermark, evicting it would re-post old updates; it is per-instance-delete
and account-switch cleared. Tests: `tests/lru-caches.test.mjs`.

## 8. Security considerations

- **Encryption is handled by the core.** The frontend must never touch private
  keys or plaintext mail credentials; it only speaks JSON-RPC to the core.
- **Loopback-only service.** The Android service bridge binds to `127.0.0.1:20808`.
  Do not expose it to other interfaces.
- **CSP.** The Tauri `tauri.conf.json` and `tauri.android.conf.json` set a
  restrictive CSP rooted in `default-src 'self'` with no `unsafe-inline` or
  `unsafe-eval` for scripts (inline scripts are blocked — that is relied on,
  e.g. by `boot-net.js`); `img-src`/`media-src` additionally allow the
  `blobfile:`/`webxdc:` custom-scheme origins and the loopback media server.
  The browser/PWA path (no Tauri header) carries the same policy as a meta
  tag in `app/index.html` (1.4.11) — Tauri-only scheme tokens (`ipc:`, `asset:`, …)
  are inert there and kept so the copies stay byte-identical. `diag.html`
  has its own looser dev policy (`unsafe-inline` for its single inline
  script). Keep it tight when adding new frontend capabilities, and update
  **all three** places together: both conf files and the meta tag.
  - `script-src` (1.4.40 cycle) carries ONE inline-script hash: the HTML
    viewer's link interceptor (`HTML_VIEW_LINK_JS` in chat-view.js) injected
    into the sandboxed srcdoc frame. The hash whitelists those EXACT bytes —
    change the snippet and the three CSP copies in one commit. Mail's own
    inline/remote scripts stay blocked.
  - `frame-src https:` is LOAD-BEARING: the in-app browser overlay
    (`open_webview_browser` fallback in inapp-browser.js) loads remote URLs
    in a sandboxed iframe. V-06's fix (#64) is elsewhere: the HTML viewer's
    `onFrameLink` now verifies `e.source === frame.contentWindow`, so only
    the srcdoc mail frame can hand links to the open chain — do not replace
    that check with origin string matching (the srcdoc frame's origin is
    opaque/null).
  - `connect-src` is loopback-only again (1.4.16): the github hosts that the
    update banner briefly added were removed — the version check runs
    shell-side (`get_latest_version` ureq command in lib.rs), and shell HTTP
    is not CSP-bound, so the renderer has NO GitHub reach. Do not re-add
    github hosts for it: release downloads 302 to a randomized CDN URL, so
    CSP path pinning can never scope them (CSP paths are not a security
    boundary), and the cross-origin page fetch fails on CORS regardless
    (GitHub's CDN sends no ACAO headers — that is what silently killed the
    banner in 1.4.14/1.4.15). The `ws://127.0.0.1:20808` entry stays: it
    is the service-APK transport, token-gated since #61; never re-widen
    connect-src beyond loopback without that same gating. The
    `http://127.0.0.1:20809` entry (V-02, #62: kept because Chrome blocks
    `ws://` to loopback from a secure-context page) went 10-17 with the
    service's HTTP bridge, which never answered an RPC (instant 504). If
    that block applies, an HTTPS-hosted page has no service path; the
    Tauri shells, the wasm PWA and pages served over http are unaffected.
- **Webxdc sandbox is opaque-origin.** `webxdc-manager.js` deliberately omits
  `allow-same-origin` from the iframe sandbox: every mini-app document gets a
  unique opaque origin and can reach neither the host page nor other apps'
  data. The shim's postMessage bridge works unchanged (`webxdc_serve`
  answers with `Access-Control-Allow-Origin: *`), and `webxdc-shim.js`
  shadows `localStorage`/`sessionStorage` with an in-memory store because
  real storage throws in opaque origins. Do not re-add `allow-same-origin`
  — all webxdc apps share the `webxdc.localhost` origin, so same-origin
  would let a malicious app read every other app's blobs.
- **webxdc blob serving is instance-gated** (V-05/#63): `webxdc_serve`
  refuses any non-icon blob whose `<account>/<msg>` prefix differs from the
  instance registered via the `webxdc_begin` command — the manager calls it
  right before setting the iframe `src` (never rely on an index request to
  set the open instance; that is the request an attacker could forge).
  ACAO `*` stays because opaque-origin frames need it for fetch(); the gate
  is what keeps cross-instance reads dead. Only `icon.*` files are exempt
  (chat-list cards load them for apps that are NOT open; icons are public
  to every chat member anyway).
- **Webxdc responses carry their own CSP** (`WEBXDC_CSP`, webxdc_serve.rs):
  the app CSP does not apply to custom-protocol responses, so without it
  mini-apps had unrestricted network access. KEEP it on every webxdc
  response; no remote hosts, webxdc origins + `data:`/`blob:` only. Do NOT
  add `webrtc 'block'` (Delta Chat desktop ships it): Chromium logs
  "Unrecognized Content-Security-Policy directive" for every webxdc app and
  ignores the directive anyway — WebRTC is instead disabled in the injected
  shim (RTCPeerConnection stubbed before app scripts run, webxdc-shim.js).
- **Blob/media servers answer only the app's own origin** (`media_cors`,
  lib.rs): no `Access-Control-Allow-Origin: *`; requests with a foreign
  Origin — including `null` from sandboxed frames (webxdc, HTML viewer) —
  are refused. The loopback media token is 128 bits from `OsRng`.
- **Peer-supplied ids never reach a path unchecked** — local-chat transfer
  ids go through `is_safe_transfer_id` (p2p.rs) before `partial-{id}`.
- **Message-derived strings are always escaped** before `innerHTML`,
  including reactions (the core accepts any short token as a reaction).
- **Deep links ask before doing damage** (1.4.28): a `dcbackup:` link (any
  web page or app can open one) confirms with the user before importing and
  switching to a profile — `handleDeeplinkFromUrl` shows a `confirmModal`
  and pins the account epoch across it. KEEP that confirmation. Note
  `chooseRelayOrNewProfile` renders no "new profile" button for `dclogin:`
  — the lookup must stay optional-chained or the flow dies on a TypeError.
- **PWA protocol handler.** `manifest.webmanifest` registers `web+dcaccount` as a
  protocol handler. Validate incoming `?qr=` parameters before passing them to
  the core.
- **Invite links.** `app/js/invites.js` parses invite links, mirrors custom hosts onto
  the canonical `https://i.delta.chat/#…` scheme the core accepts, and renders them as
  invite cards. Only links whose host is in the domain registry (drawer → "Invite link
  domains"; built-ins mirror the AndroidManifest intent filters) are treated as invites.
  Short invite links (`https://deltachat.id/<name>`, the username service) are detected
  and expanded to the full invite URL (the page JS-redirects, so it is a fetch + HTML
  extraction, not a 3xx follow): shell-side via the `expand_invite_link` command
  (renderer fetch is CORS-blocked), with a bare-fetch fallback and a localStorage cache
  (`velta-short-invites`). Until expanded, messages render a pending card hydrated by a
  document-level MutationObserver in `invites.js`. `openpgp4fpr:` QR text rides the
  same pipeline: the manifest scheme entry makes Android offer Velta, and
  `parseInviteLink` passes the text through to the core natively (1.4.26).
- **Trusted binaries.** The prebuilt `deltachat-backend/` binaries are static
  except for system libraries. If you rebuild them, prefer vendored OpenSSL and
  SQLite to minimize external runtime dependencies.
- **No unsafe code in the core.** The `deltachat` crate forbids `unsafe`; keep
  it that way.

---

## 9. Deployment and runtime architecture

### 9.1 PWA served statically

Plain `app/` is the UI smoke test (mock core, or loopback
`velta-core-service`). The wasm mail product is the C4 dist (§4.2.1);
how to host your own copy, including a PWA on origin A with the
WebSocket proxy on origin B, is `docs/pwa-self-host.md`. The deployed
dist precaches the app shell + wasm in a content-hash-named SW cache
and, since 10-09, posts OS notifications through that SW (§ notification
taps above). The vestigial-SW caveat below applies only to plain `app/`.

- Self-hosters clone `pwa-dist` (`docs/pwa-self-host.md` Quick start) and
  upload that tree except `.git`. From-source path: serve `build/dist-pwa/`
  over HTTPS (whole tree, including `sw.js` and the `.wasm.br`/`.gz`
  sidecars). Refresh `pwa-dist` after a dist rebuild: orphan commit,
  `git push --force origin HEAD:pwa-dist`. Never merge that branch.
- Plain `app/`: the service worker is unregistered at boot (stale-JS-upgrade
  incidents — see §4.2); nothing caches that tree.
- If `deltachat-rpc-server` or the Android service is running on the same
  device, plain `app/` connects over loopback WebSocket/HTTP; otherwise it
  falls back to the mock core. The wasm dist never uses that loopback path.

### 9.2 Tauri desktop/Android app

- The Tauri Rust layer embeds `deltachat-jsonrpc` as a library and exposes two
  paths: `invoke("rpc", { request })` and `emit("velta-rpc")`. Since #49 the
  desktop `rpc` command RETURNS the response line: it parks the request's
  JSON-RPC id in `RpcState.web_pending`, the sidecar reader thread resolves
  the parked waiter instead of emitting (`resolve_web_line`), and
  `tauriTransport.send` feeds the invoke resolution into the same receiver —
  rpc-core keeps its single-stream design. The broadcast now carries only
  what the core PUSHES (id-less event notifications); a response for an id
  no one waits on anymore (frontend timeout) still falls through to the
  emit path. Android keeps the write-only arm (its WebView speaks through
  the VeltaBridge; responses stay on the forwarder emit). The 180s Rust
  wait is only a leak guard — rpc-core's per-call timeouts fire first.
- Account data lives in the platform app-data directory:
  - Windows: `%LOCALAPPDATA%/org.velta/accounts` (identifier `org.velta`;
    pre-rebrand desktop builds left `%LOCALAPPDATA%/chat.delta.desktop.tauri`
    and `%LOCALAPPDATA%/deltachat-tauri` behind — dead, do not use)
  - Android: app-private storage.
- **Background sync (since 1.3.30, Android main APK).** `CoreService.kt` is a
  `remoteMessaging` foreground service started from `MainActivity.onCreate`;
  it keeps the process — and the in-process core — alive after the app is
  backgrounded. While the UI is hidden, Rust's `start_bg_event_poller`
  (lib.rs) drains `get_next_event_batch` itself (ids prefixed `bg-`, routed
  via `RpcState.bg_pending` like the `wxdc-` round-trips) and posts native
  notifications for IncomingMsg events. The frontend reports page visibility
  via `set_ui_visible`. `MainActivity.onStart`/`onStop` sets a second flag:
  Home often leaves `document.hidden` false and freezes the WebView, which
  kept the poller asleep while the page's parked poll held IncomingMsg until
  the next open. The page does not post its own Android
  notification — that second card doubled once the WebView kept running
  after Home. `onStart` calls
  `maybe_network` and emits `velta-foreground` so the page refetches.
  `CoreService` holds the default-network callback and NO wake lock (a
  permanent PARTIAL_WAKE_LOCK kept the CPU up all day; the IDLE socket wakes
  the CPU on incoming data, as in upstream's KeepAliveService).
  A `maybe_network` kick every 10 min (`bg_events::BG_KICK_INTERVAL_SECS`,
  was 90 s) while the activity is stopped interrupts a half-open IDLE; it is
  skipped while UnifiedPush delivers (endpoint set and a push within 6 h).
  The page asks for the battery-optimization exemption ONCE
  (`app/js/battery-prompt.js`, localStorage `velta-battery-opt-dismissed`
  remembers any answer), with a link to the dontkillmyapp.com page for the
  phone's maker (`device_maker` → `Battery.maker()` = Build.MANUFACTURER);
  the drawer keeps the same link under "Force background connection".
  Event-batch requests (ids `bg-ev-`, `src/bg_events.rs`) are never timed
  out: a parked request cannot be cancelled in the core, and the old 60 s
  timeout left it parked, so its next batch went to a caller that was gone
  and was dropped silently (#21/#22/#25). `PendingGuard` clears the
  `bg_pending` entry however a `bg_rpc` ends; a batch that arrives while
  the UI is visible, or with no waiter left, is emitted to the WebView as a
  `velta_core_events` JSON-RPC notification, which rpc-core dispatches like
  its own poll result. Unit tests: `cargo test --lib bg_events` in
  `velta-app/src-tauri` (desktop build; needs webkit2gtk-4.1 dev headers and
  a placeholder `binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe`).
  **Single reader (#40/#52):** the page's rpc-core asks
  `get_event_reader_mode()` once at poll start; on Android it answers
  `"rust"`, the page skips its own long-poll entirely and fires the
  `events_listener_ready { visible }` handshake, and the Rust poller becomes
  the ONLY reader — it no longer pauses while the UI is up, it routes every
  batch by visibility (forwarded as `velta_core_events` while visible,
  notified natively while hidden). The handshake exists so no batch is
  forwarded before the page's `listen()` is installed and so the first
  polls cannot notify while the app is foreground; the handshake is
  idempotent and re-runs on reconnects. Any probe failure falls back to the
  old dual-reader behavior. `bg_notify_incoming` skips muted chats via
  `is_chat_muted` (#52 L1) — a lookup failure still notifies.
  Notification titles: `bg_notify_incoming` defaults the title to "Velta" and
  replaces it with the chat name via `get_basic_chat_info` — the RPC surface
  has NO `get_chat` method, and a wrong method name here fails silently
  (`if let Ok`), leaving every push titled "Velta" (1.4.2 regression, fixed
  1.4.3 after a user report).

### 9.3 Android background service

- The APK has no UI; it starts a foreground service and links `librpc_core.so`.
- The WebSocket bridge is on `ws://127.0.0.1:20808` and supports multiple
  concurrent clients.
- **The loopback bridge is token-gated** (V-01/#61): the service generates a
  128-bit token per start (`BRIDGE_TOKEN` in the service's lib.rs). The WS
  bridge requires the client's FIRST message to be the token (10 s timeout,
  before the broadcast subscription — unauthenticated peers see nothing).
  Delivery: `RpcService.nativeGetBridgeToken`
  JNI (same process) + a pairing dialog in the service's launcher activity
  (copy → paste into the client's localStorage `velta-bridge-token`).
  transport.js sends the token when configured — without it the bridge
  fails closed by design.
- No HTTP bridge (removed 10-17): the old `127.0.0.1:20809` `/health` +
  `POST /rpc` server dropped its client and answered every RPC with 504.
  The WebSocket on 20808 is the only service transport.
- CI: none since the 2026-10-20 archive (`core-service.yml` removed). The
  crate links upstream core v2.62.0 by git tag, not `core/`.
- Boot receiver restarts the service after reboot.

### 9.4 UnifiedPush (Android, 1.4.27+ groundwork)

Push notification registration via [UnifiedPush](https://unifiedpush.org/) —
the user picks a distributor app (ntfy, NextPush, self-hosted); Velta never
talks to Google.

- **Flow:** `MainActivity.onCreate` → `UnifiedPushService.maybeRegister`
  (auto-registers only when a default distributor exists — no OS picker from
  nowhere) → distributor sends the endpoint → `UnifiedPushService.onNewEndpoint`
  serializes it as `webpush:<endpoint>|<pubkey>|<auth>` (the format the
  chatmail push relay parses, same as the upstream Delta Chat UnifiedPush
  flavor) → JNI `pushEndpointReceived` (lib.rs) applies it via
  `Accounts::set_push_device_token` → the core registers it with the relay
  automatically (IMAP METADATA `/private/devicetoken`, core `push.rs` +
  `imap.rs register_token`; token is OpenPGP-encrypted to the relay's
  "notifiers" key and space-padded to hide the platform).
- **Push wake-up:** `onMessage` → JNI `pushWakeup` → one bounded
  `background_fetch` RPC through the `bg-` round-trip → events surface
  through the background poller's parked `get_next_event_batch` → existing
  `bg_notify_incoming` notifications. No new notification plumbing.
- **Core surface** — the vendored core already exposed everything needed
  (`set_push_device_token`, `background_fetch`/`stop_background_fetch` in
  core + JSON-RPC); the shell calls the accounts Arc directly via the
  `ANDROID_ACCOUNTS`/`ANDROID_RPC_TX`/`APP_HANDLE` globals. A token arriving
  before the core initializes is parked in `PENDING_PUSH_TOKEN`. The only
  vendored-core edit (1.4.29) is the observability events below (core quilt
  op #13; dropped by the 2.63.0 re-vendor, restored 2026-10-10) — the push
  registration path itself is untouched upstream behavior.
- **Observability (1.4.29)** — the Diagnostics chat shows the whole chain:
  the shell emits `velta-push` when the distributor endpoint is applied, and
  the core (quilt op #13 in `imap.rs register_token`) emits `Info`/`Warning` events per transport — "push notifications
  registered" (relay accepted the token) vs "relay did not accept the push
  token". The rpc-core `Info`/`Warning` → diagnostic mapping surfaces both.
- **Relays modal "(U)" mark (#110)** — op #13's events name the relay
  (`Transport N (addr): …`, helper `velta_transport_addr`; list_transports
  carries no ids). `app/js/relay-push.js` parses them from onDiagnostic and
  caches per domain in localStorage `velta.relayPush`; the Relays modal marks
  a row `(U)` (title/aria-label "Supports UnifiedPush push notifications")
  only when the core confirmed SETMETADATA succeeded on a relay whose
  METADATA says supports_push. No probe, no guessing: desktop/PWA (no device
  token) and never-registered relays show no mark; a later rejection clears it.
  Does not prove the relay's notifier delivers, only that it took the token.
  Since 1.4.51 `push_wakeup_impl` also mirrors its start/done lines to
  logcat (`println!` → RustStdoutStderr): a wake can run while the process
  is half-frozen by an OEM where the buffered velta.log may never flush —
  `adb logcat -s RustStdoutStderr:*` is the reliable trace (verified: two
  natural `BackgroundFetchJob` fires, fetch done in ~0.5 s each).
- **Scheduled-fetch fallback (#52 L3, `BackgroundFetchJob.kt`)** — a
  periodic (15 min, persisted) JobScheduler job that calls the same wake
  path as a push (`Java_org_velta_BackgroundFetchJob_pushWakeup` →
  `push_wakeup_impl`), covering devices without a UnifiedPush distributor
  and OEM freezers that cut a backgrounded process's sockets — a job
  unfreezes the process for its duration (the official client delivers
  through the same pattern). `onStartJob` runs JNI `fetchBlocking` on a
  worker thread: it returns once the core's `background_fetch` resolved
  (after AccountsBackgroundFetchDone; 15 s core bound since 1.4.85, was 30 s; 55 s overall; skipped while the app is in the foreground — the live IO loop already fetches, and a fetch there restarted IO under a send) plus
  1.5 s for the poller to notify, then `jobFinished(reschedule=false)`.
  `onStopJob` calls JNI `stopFetch` (`Accounts::stop_background_fetch`),
  skips the late jobFinished and returns true (reschedule). Scheduled
  idempotently from `MainActivity.onCreate`.
- **Wake vs dead IDLE (#42/#25 P8, core quilt op #12)** — `Context::
  background_fetch` now bounds its `wait_for_work_done` at 10 s: if the
  post-interrupt fetch has not finished (a half-open IDLE socket read can
  block up to `net::TIMEOUT` = 60 s), it restarts IO so a push wake-up
  reconnects on fresh sockets instead of waiting out the stale one. Device
  evidence in #50: a backgrounded app sat 8.5 min silent because the OS
  cut the socket and nothing noticed until resume.
  NOTE: the 2.63.0 re-vendor dropped this (it was a hand edit, not a quilt
  op); v1.4.64 shipped without it. Restored as quilt op #12 on 2026-10-10.
- **Cold start without the activity (2026-10-26).** `VeltaApp`
  (Application) loads `velta_app.so` in every process and hands Rust the
  context (`VeltaCore.setContext`). Every background entry point —
  `CoreService.onStartCommand` (incl. the START_STICKY restart),
  `UnifiedPushService.onNewEndpoint/onMessage`, `BackgroundFetchJob`,
  `ScheduledAlarmReceiver` (alarm; boot/update also start CoreService when
  "Use background connection" is on) — calls `VeltaCore.ensureStarted`,
  i.e. JNI `startHeadless` (lib.rs): loads notify prefs from
  `dataDir/notify-prefs.json`, refuses when background connection is off,
  then `ensure_android_core` creates THE single core (`ANDROID_CORE`
  OnceLock: RpcState + runtime) and, when no MainActivity ran in this
  process (`ACTIVITY_LAUNCHED`), starts IO for all accounts itself. Tauri
  setup calls the same `ensure_android_core`, so the UI reuses a core a
  service already started (`app.manage(state.clone())`, `APP_HANDLE` set);
  nothing in the core path needs an AppHandle any more (emits go through
  `ui_app()`/`Host::emit`, tunnel/ws state through `crate::Host`). Push and
  alarm wake-ups wait up to 20 s for a still-initializing core
  (`android_core_tx`). The service notification says "Not syncing…" when
  the core did not start (or is not up 30 s later). Rust's state files
  live in `Context.getDataDir()` (Tauri app-local data), which Kotlin reads
  via `AppFiles.read` (dataDir, then filesDir). Init order: DNS tunnel boot,
  WS transport `boot_now` (awaited), `tunnel::reapply_proxy`, THEN the
  request channel is published (the page cannot start_io earlier) and a
  headless start_io runs. Health checks every minute restart a proxy whose
  local listener stopped answering (`tunnel::check_alive`,
  `ws_transport` keeper).
- ** ceilings:** (1) `CoreService` is NOT stopped when push registers —
  a push-only mode is possible now that a push can cold-start the core,
  but not built. A headless start ignores the page's "sync only the
  active account" (localStorage) and starts every account. (2) The VAPID
  key in `UnifiedPushService.kt` is the upstream chatmail notifier key — a
  self-hosted relay with its own notifier keypair needs it updated. (3) The
  relay must run a chatmail version whose notifier understands `webpush:`
  tokens (verify per deployment).
- **Settings → Push notifications (#140)** — Android-only native
  `<details class="drawer-details" data-push-section>` in the drawer
  (`app/js/push-settings.js`, filled on every `toggle` open). Shell
  commands `push_status` (JSON: distributors+labels, saved, optedOut,
  lastPush ms) / `push_select{package}` / `push_off` (lib.rs) call
  `UnifiedPushBridge.kt` via the cached-class JNI pattern. Prefs file
  `velta_push`: `opted_out` (explicit Off — `maybeRegister` returns early,
  never auto-registers over it; picking a distributor clears it) and
  `last_push_ms` / `last_endpoint_ms` written by `UnifiedPushService`.
  Auto-register still covers single/default distributor when the user never
  chose. Relay line reuses the relay-push.js `velta.relayPush` cache, so it
  stays "not confirmed" until a push app registered once. Gotcha: the drawer
  is rebuilt (rebuildDrawer) — the section re-wires itself per build, keep
  state in the shell, not in the DOM.
- Test with at least two distributors (ntfy + a second one) per the
  UnifiedPush developer guidance.

---

## 10. Quick reference for common tasks

| Task | Command |
|------|---------|
| Run core tests | `wsl -e bash -lc "cd /mnt/c/Users/pave/Velta/velta/core && cargo nextest run --workspace --locked"` (plain `cargo test` flakes on time-shift tests — see `COREUPDATE.md` §4) |
| Run core lints | `cd core && scripts/clippy.sh && scripts/deny.sh` |
| Build core RPC server | `cd core && cargo build -p deltachat-rpc-server --release` |
| Type-check the Android shell | `wsl -e bash -lc "cd /mnt/c/Users/pave/Velta/velta/velta-app/src-tauri && cargo check --target aarch64-linux-android"` (desktop `cargo check` compiles the `cfg(target_os = "android")` code OUT — it proves nothing about JNI/Rust-side Android code) |
| Run Tauri dev | `cd velta-app && cargo tauri dev` |
| Serve PWA locally | `cd app && python -m http.server 8080` |
| Self-host PWA (prebuilt) | `git clone --depth 1 --branch pwa-dist --single-branch https://github.com/pbuzdin/velta.git velta-pwa` — upload except `.git`; recipe `docs/pwa-self-host.md`. Refresh: orphan commit of `build/dist-pwa`, `git push --force origin HEAD:pwa-dist` (never merge) |
| Run Python CFFI tests | `cd core/python && pytest` |
| Run Python RPC tests | `cd core/deltachat-rpc-client && pytest` |
| Upgrade the core | Follow `COREUPDATE.md` |
| Contrast audit (UI changes) | `node scripts/e2e-contrast.mjs` (`--quick` in CI, `--shots DIR`, `--json FILE`) |
| Contrast audit (Beam / Circle) | `node scripts/e2e-xdc-contrast.mjs [--shots DIR]` |
| Rebuild built-in webxdc + tokens + trusted hash | `node tools/build-builtin-xdc.mjs` |

---

## 11. Notes for agents (operational rules)

Per-subsystem narratives live in `docs/agents/*.md` (webxdc, relays,
onboarding, p2p/local chat, android-shell, media, read-receipts, dns-tunnel) — read the
relevant one before touching that subsystem (calls: `docs/agents/calls.md`). The entries below are cross-cutting
do-not-regress rules; dates mark when the lesson was learned.

- **Phone modals keep the bottom bar; inner scroll is fine (2026-10-18,
  Pavel's decision)** — below 600px, non-compact modals opened from the chat
  list stop above the bottom action bar (`body:not(:has(.app.chat-open))
  .modal:not(.modal-compact) { height: calc(var(--dvh) - var(--list-bar-h)) }`,
  cee7084); the bar stays visible, dimmed under the scrim. Do NOT make them
  cover the bar / go "truly full screen" (ec910ce did, reverted). Nested
  scroll areas inside a modal (About's device-info `<pre>`, the chat-info
  member list) are allowed — do not add rules or checks that forbid them.
  Guarded by `tests/narrow-viewport-css.test.mjs` and
  `scripts/e2e-narrow-overflow.mjs`.

- **Chat appearance (2026-10-18)** — drawer section after Theme: message
  text size (10–22 px, step 0.5 because the stock size is 15.5), corners
  (0–14), accent (8 presets + `<input type=color>`), hyphenation switch.
  Stored per device (`velta-msg-font-size`, `velta-bubble-radius`,
  `velta-accent`, `velta-hyphens`) and applied pre-paint by the classic
  `js/chat-appearance.js` (also pins `data-theme` early). Rules: bubble
  sizes/radii go through `--msg-font-size` / `--radius-bubble|tail|quote|media`,
  never new literals (reaction chips: `.msg-reactions` font-size
  `calc(var(--msg-font-size) * 16 / 15.5)`, em spacing, `tests/reactions-scale.test.mjs`); accent-colored text/fills use `--accent`,
  `--on-accent`, `--accent-tint`, `--out-link`… (defaults = the old
  literals) so a custom accent reaches them — a new hard-coded
  `rgba(90,162,230,…)` is rejected by `tests/chat-appearance.test.mjs`.
  `deriveAccent` holds every text pair at 4.5 : 1; brutal keeps its own
  palette. Each `.msg-text` carries `lang` (`text-lang.js`) for
  `hyphens: auto`; machine text (links, e-mail spans, hashtags, code) stays
  `hyphens: manual`. Detail + platform hyphenation matrix:
  `docs/chat-appearance.md`.

- **Settings export / apply (2026-10-18)** — `js/settings-transfer.js` is the
  single whitelist (`SETTINGS`: export key → localStorage key, parse,
  write). Drawer "Export settings to Saved Messages" sends one
  `Velta settings v1 (YYYY-MM-DD)` text to the self-chat (chat-list
  `kind:"saved"`, else `createChatByContactId(1)`); manual only, never call it
  from a timer or on settings change. The bubble gets "Apply these settings"
  only in the saved chat, `from === 1`, not forwarded / not a saved copy, and
  only if `parseSettings` accepts it. Apply = diff modal (settle before close)
  → `applySettings` → `refreshAfterSettingsApply` (live: theme, scale,
  appearance, bar, categories, core `media_quality` / `download_limit` /
  `mdns_enabled`). Parser: no eval, header first, every line `key: value`,
  `(note)` or blank, else the whole block is rejected; limits 4096 chars /
  80 lines / 200 per line; unknown keys ignored, invalid values skipped,
  numbers clamped. Accent is written without `#` (it would become a hashtag
  button). A new pref is exported only if it is a UI choice that makes sense
  on another device: add it to `SETTINGS`, otherwise to
  `EXCLUDED_STORAGE_KEYS`; never relays, transports, push, proxy/tunnel,
  keys, addresses, bcc_self or device info. Tests:
  `tests/settings-transfer.test.mjs`; doc: `docs/settings-transfer.md`.

- **Read-receipt lifecycle (2026-10-02, #59 follow-up)** — a "stuck single
  tick" is almost always the peer never opening the chat on-screen: the only
  MDN trigger is the watermark `markseen_msgs` in the open chat, and
  notification replies do not fire it. Diagnose from the raw core state
  (`get_message`), never from the UI; the recipe + raw-RPC probe live in
  `docs/agents/read-receipts.md`. Related trap: after editing `app/` the
  debug exe can still serve OLD renderer assets until
  `cargo clean -p velta-app` (§4.3).

- **Event-storm hardening (1.3.23)** — the failure was a core event storm
  re-rendering chat history endlessly. KEEP: rpc-core `_onLine` runs the
  late-response hook only for entries the 240 s backstop already rejected
  (running it for live entries doubles every event); chat-view
  `onMsgUpdated` calls `onItemHeightDidChange` only for mounted rows and
  SETS the new row signature for unmounted ones (deleting it made every
  duplicate event retake the full changed path); `_renderItem` seeds
  `_rowSigCache` at build time (removing it makes the first duplicate
  update rebuild mounted rows); `onMsgsChanged` coalesces refetch bursts
  (`tailRefetchGapMs`) and self-heals delivery-state ticks (keep `state`
  in the condition — a dropped event left a sending spinner stuck for
  hours); `refreshRelayStatus` coalesces connectivity-driven polls. Tests
  shrink these via instance knobs, never by deleting the gates.
- **Boot error net (1.3.26+)** — `js/boot-net.js` loads before every other
  script and routes errors into the Diagnostics sink once app.js is alive,
  `#boot-error` before that; `boot()` is stage-isolated (`uiLive` — see
  §5.1 app.js bullet).
- **Audio calls (1.3.26+, calls.js)** — the core does encrypted call
  signaling (place/accept/end ride as messages; `place_call_info` is the
  caller's SDP offer, `accept_call_info` the answer — raw SDP, non-trickle
  ICE) and the WebView does media (RTCPeerConnection + getUserMedia, ICE
  from the core's `ice_servers()`); events map to incoming-call /
  outgoing-call-accepted / incoming-call-accepted (`fromThisDevice: false`
  = another device accepted — stand down) / call-ended. The WebRTC/DOM
  adapter is injected into CallManager so
  `tests/call-state-machine.test.mjs` runs headless — keep it injected.
  Desktop mic grant needs `--use-fake-ui-for-media-stream` (wry denies
  permission requests by default — only clipboard is allowed); Android
  needs RECORD_AUDIO in the gen manifest, granted by wry's
  RustWebChromeClient (CAMERA likewise for video calls). Video calls since
  2026-10-20 (next bullet + docs/agents/calls.md).
- **Calls: mic track + Android audio route (2026-10-19, #141)** — the
  "dead microphone" was never a permission problem: calls.js opened the mic
  but never called `pc.addTrack`, so every offer was recvonly and no RTP
  left the device on any platform. KEEP `addLocalTracks()` BEFORE
  `createOffer` (caller) and AFTER `setRemoteDescription(offer)` / BEFORE
  `createAnswer` (callee); mute = `track.enabled` only. Pinned by
  `tests/call-audio-route.test.mjs` and `scripts/e2e-call-audio.mjs` (two
  CallManagers over real WebRTC in headless Chromium, fake mic; fails on 0
  packets or a non-sendrecv SDP — run it after touching calls.js). Android
  route: `CallAudio.kt` via `call_audio_start/speaker/stop` (lib.rs, cached
  class like Battery): MODE_IN_COMMUNICATION, earpiece by default (headset
  wins), `setCommunicationDevice` on API 31+ / `setSpeakerphoneOn` below,
  proximity screen-off lock on the earpiece, MODE_NORMAL on stop. The
  WebView itself flips the mode to the loudspeaker when capture starts, so
  the route call MUST follow getUserMedia, and stop MUST follow the track
  stops (never "restore the saved mode" — it is already IN_COMMUNICATION).
  Speaker and Earpiece (`aria-pressed`, fixed labels, only the active one
  highlighted) show only where the route adapter is supported (Tauri +
  Android); desktop/PWA hide both. Video
  calls would default to the loudspeaker (`defaultSpeakerOn`). Call traces
  (`[call] …`) go to the Diagnostics chat only with VELTA_DEBUG; native
  lines are logcat tag `VeltaCallAudio`. Details: docs/agents/calls.md.
- **Video calls + Delta Chat interop (2026-10-20, #141)** — the core
  carries ONE offer and ONE answer (no renegotiation) and `has_video` is
  only a label. So, like deltachat/calls-webapp: every offer (audio calls
  too) has an audio AND a video transceiver, sendrecv; the camera toggles
  mid-call with `replaceTrack` on that video sender; negotiated data
  channels id 1 `iceTrickling` and id 3 `mutedState`
  (`{audioEnabled, videoEnabled}`) are created on both sides before
  offer/answer. KEEP all three — dropping the video transceiver makes the
  camera impossible later in the call, dropping mutedState makes DC show
  our frozen/black frames. Remote video shows only when its track is
  unmuted AND mutedState did not say videoEnabled:false. Camera on →
  loudspeaker, off → earpiece, as `auto` switches (a headset keeps the
  audio). The header video icon is hidden below 480px (the chat name had 0px
  at 320px @1.15 — `scripts/e2e-narrow-overflow.mjs` chatinfo-contact
  timed out); phones use ⋮ → Video call. The call screen is built once per
  call (the `<video>` elements must survive re-renders). Run
  `scripts/e2e-call-audio.mjs` after any calls.js change.
- **PWA calls (2026-10-20, #141).** The wasm core dispatches every call RPC. An empty `ice_servers` (no tunnel DNS) falls back to turn.delta.chat by hostname in `safeIceServers()`. The speaker button is hidden. Calls ring only while a tab is open. `scripts/e2e-call-wasm.mjs` needs outbound IMAP/SMTP or a C3 tunnel (see docs/agents/calls.md).
- **Call cards (post-1.4.38, issue #8)** — call messages (core viewtype
  `Call`, mapped to "call" in `_mapViewtype`) render as a call card in the
  chat instead of the stock text string: direction + state + duration from
  `rpc-core.callState` (`call_info`; state kinds Alerting/Active/Missed/
  Declined/Canceled/Completed{duration}), red tint for missed/declined.
  States are cached per msgId (`_callStateCache`, cleared on account
  switch) because rows re-mount on every scroll pass — a new per-call RPC
  per remount would multiply. Mock answers with Completed + the stored
  duration; a demo call message lives in the Ada chat.
- **Message id cache race (2026-10-22).** `RpcCore.getMessageIds` caches a
  chat's id list; an invalidation (IncomingMsg/MsgsChanged/…) bumps
  `_msgIdGen`, and an answer whose fetch started before that bump is
  returned but NOT cached. Caching it hid a new message from history, even
  across reopen, while the chat list showed it. Test:
  `tests/thread-counts-live.test.mjs`. The "row mNNN rebuilt" diagnostics
  line now logs only real content flips (reply count, mention, transfer
  changes go to debugLog).
- **Reply threads (2026-10-22, VENDORISSUES #14) — docs/reply-threads.md.**
  Counts come from the core (`get_reply_counts`, exact even with unloaded
  pages); without the #14 core only when `hasMore` is false (window counts
  would under-count). Each counted bubble shows a passive
  `.msg-replies-count` in the meta row (phones, ≤600px; plain meta color,
  never a tap target) and a round `.msg-thread-btn` beside the bubble
  (right of incoming, left of outgoing; 32px disc in a 44px hit box,
  `aria-label="Show N replies"`). The button and the bubble share
  `.msg-thread-line` (`flex-wrap: nowrap`, `flex: 1 1 0`) so a wrapping
  `.msg-row` cannot drop the button under the bubble on a phone. Shown
  from `THREAD_BUTTON_MIN_REPLIES`
  (chat-view.js, one constant — set 2 to require >1). The button and the
  menu's "Show replies" open the **thread panel**: a non-modal
  `role=dialog` bottom sheet after `#history-scroll` (70% of the chat view,
  own `.thread-body` scroll, header = "Thread · N replies" + the quoted
  original + close). History stays visible above it, the composer stays
  below, locked to the parent (quote re-locked after each send, quote-bar
  X hidden). Escape (panel or composer) and the close button close it;
  focus moves to the close button on open and back to the opener on close.
  Closes on chat switch and parent deletion. Rows inside the panel render
  with `{ inThread: true }` (no side button). Tests:
  `tests/reply-counts.test.mjs`.
- **Unread category chip (2026-10-22).** The chat list's category bar has
  an Unread chip that cuts across the kind chips (any kind can be unread),
  hideable like the others and part of the swipe cycle; its empty state
  reuses "No chats in this category". Tests: `tests/categories-bar.test.mjs`.
- **Chat open position + go-down (post-1.4.38, issue #14; read tracking
  1.4.40)** — open() lands on the manual read marker or the first unread
  message (`get_first_unread_message_of_chat`; the "Unread messages" line
  rides inside that row as `unreadFirst`), else the tail — see §5.1 "Read
  tracking". `_settleScroll(computeTop, reassert)` re-asserts the target on
  a 40 ms TIMER — rAF is unusable here (occluded windows never fire it, and
  that includes headless checks) and the target row may render late
  (computeTop returns null → hold position); `_settling` blocks seen-marking
  until it ends. The go-down button shows whenever the view is away from
  the bottom (it used to appear only on new arrivals — effectively never for
  manual scrolls); its click marks the chat read and settles to the tail
  (`_jumpToLatest`, which first reloads the tail page when the window was
  opened mid-history). Never replace the settling with a single scrollTop
  write: the virtual scroller's async layout wins and the jump silently
  lands mid-history.
- **Modal async flows (1.3.35)** — settle BEFORE close: `showModal`'s
  `onClose` resolves the flow's promise with null, so `close()`-first
  silently drops results (it swallowed every successful QR scan once).
  Always `finish(result); close();` — never the reverse.
- **Never open the Android soft keyboard over the camera** — any scan flow
  must `blur()` inputs while scanning and refocus only when returning to
  paste mode (`qr-scan.js` gates its initial `focus()` on the camera being
  unavailable).
- **CSS `display` beats the `hidden` attribute** — a styled element with
  `hidden` stays visible; add explicit `.foo[hidden] { display: none }`
  when toggling a styled container via `hidden` (bit the splash panes).
- **Never use native `prompt()`** — group creation asks via a `showModal`
  input (`askGroupName`).
- **Elena prop defaults** — keep every `static props` entry backed by a
  field or a constructor install, and keep defaults STRING-typed, never
  `null`: `typeof null === "object"` made Elena JSON-parse every attribute
  value (`VeltaChatItem` logged "Invalid JSON: c49" for string ids).
- **Message ids are numbers** — `_resendTail`/`onMsgsChanged` compare ids
  with `>`; string ids silently drop messages from the append-only filter.
- **Overlay/BACK conventions (1.3.36+)** — every fullscreen overlay (HTML
  viewer, webxdc, in-app browser, image lightbox) pushes ONE `{velta:…}`
  history entry on open; WryActivity's OnBackPressedCallback calls
  `mWebView.goBack()` when it can, so BACK pops the entry and a `popstate`
  listener tears the overlay down (app.js treats a revealed
  `{velta:"chat"}` as keep-the-chat). Close buttons and programmatic
  closes consume the entry via `history.back()`; reopening an already-open
  overlay REPLACES its entry (back-then-push races and loses it).
- **Update banner (1.4.14+, shell-side since 1.4.16)** — boot fires
  `checkForUpdate()` (ui.js, fire-and-forget); the latest version comes
  from the shell command `get_latest_version` (lib.rs, ureq, hardcoded
  version.txt URL, 5 s timeout) because the renderer's cross-origin fetch
  is CORS-blocked by GitHub's CDN — do not move it back into the page and
  do not re-add github CSP hosts (§8). Newer remote → drawer-bottom banner
  with Download APK + `.update` pulse on
  `#bar-menu` (box-shadow animation, no layout shift; disabled under
  `prefers-reduced-motion`). No banner when versions match, offline, or
  empty response (pre-1.4.14 releases carry no version.txt).
  Android (#60): the banner button downloads in-app —
  `download_update` (lib.rs, ureq streaming into the app cache dir,
  `update-download` progress events, URL built shell-side from the
  version so GitHub stays the only hardcoded reach; it first deletes older
  `Velta-*-arm64.apk` files from the cache dir so failed/old downloads do not
  pile up) — then
  `install_update` JNI → `UpdateInstall.kt` (FileProvider URI over the
  cache dir + ACTION_VIEW package-archive; needs the
  REQUEST_INSTALL_PACKAGES manifest permission). No browser detour;
  falls back to `plugin:opener|open_url` when the shell lacks the
  commands or the download fails. Desktop keeps the updater-plugin
  one-click path (`selfUpdate`).
- **Interface scale + theme (1.4.2+)** — `MainActivity` pins the WebView's
  `textZoom = 100` (system font scale otherwise applies text-only zoom
  that inflates text out of the px-sized boxes); scaling is app-owned via
  drawer radios (zoom on `<html>`, `velta-ui-scale`, applied pre-paint by
  the external `js/ui-scale.js` — the CSP forbids inline scripts). Root
  zoom multiplies viewport units but not percentages: the shell stays
  percentage-based (`100dvh` pushed the list bar off-screen, 1.4.14), the
  vendored virtual-scroller carries the `__vsZoom` rect normalization
  patch, and `applyUiScale` dispatches `resize` so the scroller re-measures
  (1.4.14). `text-size-adjust: 100%` on html neutralizes font boosting.
  Since 2026-10-18 `js/chat-appearance.js` also sets `data-theme` before
  first paint (from `dw-theme`); app.js `applyTheme` owns it after boot.
  Theme radios (auto/dark/light; auto is the default for fresh installs)
  and scale radios apply in place — never `rebuildDrawer()` on a radio
  change, it would close the drawer. Keyboard vs header: see
  docs/agents/android-shell.md (1.4.17).
- **Build environment** — core cargo commands run in WSL (native Windows
  cargo fails in openssl-sys: MSYS perl lacks
  `Locale::Maketext::Simple`); the Windows sidecar exe is built by
  `build-windows.yml` on tag push, so stale local binaries in
  `velta-app/src-tauri/binaries/` refresh only at release. Never build the
  Android APK with that directory present (Tauri bundles it verbatim:
  +22 MB of Windows PE in every APK); `tools/wsl-android-build*.sh` delete
  it as a guard.
- **WSL is the core + Android sandbox, NOT the desktop target** — the WSL
  checkout has no GTK/gobject dev libraries, so `cargo check`/`cargo build`
  of `velta-app`'s desktop target dies there with
  `Package 'gobject-2.0', required by 'virtual:world', not found`
  (gobject-sys pkg-config). Desktop Tauri builds/`cargo check` for
  `velta-app` run natively on Windows (vendored `tools/strawberry-perl` +
  `tools/nasm` on PATH, and kill a running `velta-app.exe` + its sidecar
  first — os error 32, §4.3).
- **PowerShell 5.1 mangles inline code — write scripts to a file.** Passing
  anything non-trivial inline (`node -e "…"`, multi-line JS, `&&`, `$`,
  embedded quotes) through a PowerShell command line gets re-parsed by
  PowerShell's grammar and fails with confusing parser errors — put the
  code in a temp `.mjs`/`.ps1` file and run that. Same grammar rule for
  calling executables: a QUOTED path must use the call operator —
  `& "C:/path/tool.CMD" args` — because `'path' args` alone is a string
  followed by tokens ("Unexpected token" parser error). Also
  cosmetic-but-noisy: `cargo check 2>&1 |` makes PowerShell print
  `NativeCommandError` walls for cargo's normal stderr progress — a
  `Finished` line means success; don't mistake the noise for failure.
  Encoding pitfalls are a separate rule (§11 "Encoding").
- **Scope guards** — `core/` is a large vendored upstream copy: avoid
  changing it unless the task is fixing/extending the core itself.
  `velta-app/src-tauri/gen/android` is generated EXCEPT the hand-maintained
  `AndroidManifest.xml`, Kotlin sources and
  `res/xml/network_security_config.xml` — edit those by hand, regenerate
  the rest. `archive/velta-core-service/` is archived — do not update it.
- **Version bumps** are one command: `node tools/bump.mjs <version>` — it
  rewrites the `velta-app` package version in `velta-app/src-tauri/Cargo.toml`
  (+`Cargo.lock`), regenerates `app/js/version.gen.js` (the PWA/mock
  fallback ui.js imports), and mirrors the version into `tauri.conf.json`.
  The conf field is load-bearing for Android: tauri-cli's Android build reads
  only the conf field for `tauri.android.versionName/Code` (no Cargo
  fallback) — a missing conf version ships the APK as versionCode 1 /
  versionName "1.0" (the v1.4.58 regression). Desktop builds and
  `release.yml` use Cargo.toml. Each release commit notes both.
  README/velta.cc download links are version-less and NOT bumped:
  `release.yml` also uploads stable-named copies `Velta-android-arm64.apk`,
  `Velta-macos-universal.dmg`, `Velta-windows-x64-setup.exe`, linked as
  `https://github.com/pbuzdin/velta/releases/latest/download/<name>`. The
  versioned assets, `.sig` files and `latest.json` (updater) are unchanged —
  never rename those.
  After the release, job `website-version` copies `version.txt` to the
  `website` branch and rewrites velta.cc's "Latest release: vX.Y.Z" text.
- **README convention** — every `##` section below "Screenshots" is wrapped
  in `<details><summary>…</summary>` with a blank line after `</summary>`,
  so the front page stays short.
- **Releases** — `release.yml` is the single tag→release path (`v*` tag
  push or manual dispatch; branch pushes build nothing — do not re-add
  `push:` triggers to the reusable workflows, and no per-job
  `concurrency` blocks: inside a reusable-workflow call `github.job` is
  empty at group-evaluation time, so android and windows collapse into one
  group and cancel each other — that killed the 1.4.6–1.4.8 releases). It
  publishes `Velta-<version>-<abi>.apk`, `version.txt` (the update-banner
  feed), `Velta_<version>_x64-setup.exe` and `latest.json` (the Windows
  self-update manifest — must stay the last-uploaded asset), writes
  `changelog.md` ("What's changed in Velta <tag>" + user-facing
  conventional commits only — feat/fix/perf/refactor/revert; the rest are
  skipped) and `announce.md` (same minus the compare link, plus a
  "Download" tag link; rides a workflow artifact to the notify
  job, which posts it to `ntfy.gluek.info/velta_changelog`). Hand-written
  highlights or thanks for a tag go in `.github/release-notes/<tag>.md`
  (optional); both texts print it above the commit list. The commit range
  starts at the newest earlier tag that HAS a published GitHub release
  (`gh release view`), so a tag whose run failed (v1.4.66: Windows/macOS
  dead-code error) is skipped and its changes land in the next notes. The keystore
  lives in `signing/`
  (gitignored) and the four `ANDROID_KEY*` repo secrets — losing both
  means installed APKs can never be updated again.
  `build-windows-cross.yml` is manual-dispatch only.
- **Windows self-update** — the desktop banner button drives
  `tauri-plugin-updater`: it fetches `latest.json`, verifies the minisign
  signature, runs the NSIS installer and relaunches (`tauri-plugin-process`).
  The updater keypair lives in `signing/velta-updater.key` + password file
  (gitignored) and the `TAURI_SIGNING_PRIVATE_KEY*` repo secrets — losing
  them kills the updater for every future release. Only installer installs
  self-update; a bare copied `velta-app.exe` does not.
- **JSON-RPC compatibility** — when changing the RPC surface, the PWA
  (`rpc-core.js`), the Python RPC client and any external consumers must
  stay compatible. WATCH: request-body field CASING is a silent trap —
  serde ignores unknown fields, so a renamed/renamed-back input field
  (`viewType` vs `viewtype`) vanishes without an error (see the Stickers
  bullet in §5.1; `sendMessage` now sends both casings). WATCH a second
  silent trap: ARGUMENT COUNT/SHAPE. The core answers a null where a Vec
  is expected with `invalid type: null, expected a sequence`, while
  `[accountId, [null]]` (null element) says `expected u32` instead — map
  a wire error to its exact position by probing the released rpc-server
  with hand-built params:
  `printf '{"jsonrpc":"2.0","id":1,"method":"delete_messages","params":[0,null]}' | DC_ACCOUNTS_PATH=<existing tmp dir> deltachat-backend/windows-x86_64/deltachat-rpc-server.exe`
  (deserialization happens before the account lookup, so no real account
  is needed). That recipe identified the local-chat Proxy's dropped `ids`
  argument (post-1.4.35 fix — docs/agents/p2p.md).
- **Core 2.60 relay removal** — relay removal is immediate (the core
  refuses only the last relay and re-elects sending, informing contacts
  via keyupdate); `set_transport_unpublished` no longer exists — never
  reintroduce it. Check COREUPDATE.md §7 on every core upgrade (example:
  mails the core fetches and ignores must still be marked seen on the
  server, or IMAP idle re-fetches them forever).
- **Privacy** — zero analytics/telemetry (verified against the codebase
  2026-09-15; the only documented exception is the Windows WebView2
  install bootstrap). Keep it true.
- **Frame theming (1.3.34)** — the HTML viewer and webxdc iframes are
  themed via `color-scheme`, injected per frame (srcdoc `<style>` /
  `?velta-theme=` + `documentElement.style.colorScheme`) because the
  iframe element's scheme only paints the canvas. Device chats
  (`kind === "device"`) hide the composer.
- **Error toasts go to Diagnostics (1.4.30)** — every error-path toast in
  app.js/chat-view.js routes through `errToast(text, ms)` (toast +
  `diagnosticsSink.append(`error`, ...)` → Diagnostics chat + velta.log). Toasts
  vanish in seconds; sink rows persist. New error toasts MUST use errToast,
  and plugin-invocation failures should include the resolved argument
  (e.g. the absolute path) in the message — that is what made the open_path
  bug diagnosable in one round-trip.
- **Frontend click/spacing plumbing (1.4.30)** — four failures hit in one feature;
  all four are permanent rules:
  1. `window.open`/target=_blank is silently swallowed by wry on desktop — nothing
  opens, no error. The working desktop path is the opener plugin (`plugin:opener|open_url`,
  `opener:default` capability; see `openExternal()` in chat-view.js and the update banner).
  2. Do NOT route desktop links through the in-app iframe overlay — it is the Android
  branch of `openInAppBrowser`; desktop links go to the system browser.
  3. DOM inserted ASYNC (link-preview cards) is invisible to per-anchor wiring
  done at row build — wire click handling by DELEGATION at the row level.
  4. The virtual scroller inline-writes `style.paddingTop/Bottom` onto `.history
  every layout pass; spacing rules must target `.history-scroll`, never `.history`.
  Also: inline `onclick` attributes die under the CSP (no `unsafe-inline`) — wire
  listeners in DOM code, never as HTML attributes.
- **Opening file attachments (1.4.30, three-step lesson)** — the tap on a
  downloaded non-media file failed three ways before it opened; all three
  layers must be correct together:
  1. COMMAND permission: `opener:default` does NOT include open_path —
  `opener:allow-open-path` must be listed in BOTH capability files
  (platforms rule, §4.3).
  2. PATH SCOPE: the bare permission ships ZERO scope entries; the plugin
  computes fs_scope.is_allowed(path) AND any(Entry.matches_path_program) —
  an empty allow list denies EVERY path (“Not allowed to open path”).
  The permission must be an object with an allow scope; Velta allows
  `$APPLOCALDATA/accounts` + `/**` (all attachment blobs live there).
  3. ABSOLUTE path: the scope matches absolute paths only. The core's
  `filePath` is relative to the accounts dir — `_openFile` resolves it
  against `window.veltaAccountsDir` (get_accounts_dir, set at boot) first.
  Debug order: reproduce → read the resolved `capabilities.json` under
  `target/<target>/release/build/velta-app-*/out/` → error toast now carries the
  resolved path. Verify with a REBUILT binary — config fixes never reach a
  running/installed app.
- **A section header can swallow functions (1.4.35)** — a duplicated
  `/* ---- deeplinks ----` divider whose `*/` was lost turned everything up
  to the NEXT divider's closer into comment text: `node --check` still
  passed, grep still "found" the definitions, and at runtime every
  fresh-install account creation died with "Setup failed:
  askNotificationPermission is not defined" (shipped in v1.4.34/1.4.35;
  addAccountFromInvite/deeplinks were dead the same way). After inserting
  dividers or moving top-level functions, run
  `node --test tests/app-source-integrity.test.mjs` — it comment-strips
  app.js and asserts the pinned definitions still exist outside comments.
- **Removed imports can kill untested UI paths in release (1.4.80)** — the
  action-bar rework removed `showContextMenu` from chat-view.js's ui.js
  import believing the message menu was its only caller, but the ATTACH
  menu still called it: every attach click died with "showContextMenu is
  not defined", the suite stayed green (no test walks the attach path),
  and it shipped. Two defenses since 1.4.81: the source-integrity suite
  asserts every ui.js export referenced in chat-view.js/app.js appears in
  that file's ui.js import (run the same file after ANY import pruning —
  it catches referenced-but-not-imported names), and the rule of thumb:
  grep the WHOLE consumer file for a name before deleting its import —
  the reworked feature is never the only place a shared helper is used.
- **Sending dashes can lose their terminal events (post-1.4.36)** — the
  relay line's send-activity bookkeeping (`rpc-core _trackSending/
  _untrackSending`) cleared only on MsgDelivered/MsgFailed, but the Android
  background poller consumes those events while the app is hidden, a
  transport reconnect drops mid-flight events, and a pending message deleted
  before delivery never emits one — the dashes stuck forever (user reports).
  Two defenses live in rpc-core: `reconcileSending()` (wired to visibility
  resume and velta-core-status connected) re-checks tracked ids via
  get_message, and a 90 s backstop (`sendingBackstopMs` knob) force-clears a
  stuck set. Any new send-like path (e.g. resendMessage) must re-track.
  Contract + pins: docs/agents/relays.md, tests/send-activity.test.mjs.
- **No built-in Yggdrasil, and the chatmail core stays mandatory** (#29 and
  #31, closed wontfix 2026-09-30). Mail already goes through one proxy URL
  (`proxy_url` in `core/src/net/proxy.rs`: HTTP CONNECT, SOCKS5, or
  Shadowsocks). A Yggdrasil node stays a separate app; do not vendor one,
  and do not add the Proxies drawer that issue asked for. The core is the
  database and the message model. `core/src/transport.rs` is one IMAP/SMTP
  relay, not a plugin slot. Local chat wraps the booted core and does not
  replace it. The opt-in Android DNS tunnel (#116/#119/#128) is not a Proxies
  drawer either: it reuses that one `proxy_url` and never overrides a
  proxy the user set; mode Off stops the tunnel library and removes our local proxy from every profile (before 1.4.85 Off only switched routing and the proxy stayed, so sends stalled ~60 s on a dead proxy, #175); Auto stays direct when the relays are down, not
  blocked (docs/agents/dns-tunnel.md). A profile with no relay is the welcome splash's "Enter local
  chat…". Detail: docs/agents/relays.md, docs/agents/p2p.md.
- **Encoding (2026-09-23)** — every text file is UTF-8 without BOM; no
  exceptions. On this Windows checkout the ANSI codepage is CP1251
  (Cyrillic), and tools that read or write with the default encoding —
  PowerShell 5.1 `>`/`>>`/`Out-File`/`Set-Content`/`Get-Content`, `cmd`
  redirection, some editors — silently turn `—` (U+2014, bytes `E2 80 94`)
  into `вЂ”`, `…` into `вЂ¦`, `→` into `в†'`, box-drawing into `в”‚`,
  and emoji into `рџ¤¦`. This corrupted ~570 runs across README.md,
  AGENTS.md, main.css, mock-core.js, sw.js, Cargo.toml and lib.rs (all
  repaired 2026-09-23). NEVER let a PowerShell 5.1 pipeline write a
  source or docs file: use `-Encoding utf8` explicitly, or write from
  WSL/bash, or use an editor/API that writes UTF-8 by default. If you
  ever see `вЂ`, `в”`, `В§`, `рџ` or any stray Cyrillic inside English
  prose, STOP and fix the encoding of the whole write path before
  committing — never "patch" the visible characters only. **Reading counts
  too**: `Get-Content` without `-Encoding` decodes as CP1251 and
  `Set-Content`/`Out-File` round-trips the damage back to disk — the v1.4.26
  version bump re-mojibaked `sw.js`/`Cargo.toml` exactly this way (the BOM
  check passed, the content was already corrupted; caught by an external
  PR). Read AND write with explicit UTF-8, or use the edit tools / WSL.
