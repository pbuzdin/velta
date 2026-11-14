# Velta KMP client

Native client for **Android + Desktop (Windows/macOS/Linux)** built with
Kotlin Multiplatform + Compose Multiplatform.

**Status (2026-11-13):** Android delivery track (Rust-UI flip, #314, #192).
N1 (Prism + fingerprint identity matrix), N2 (conversation notifications,
RPC timeout/recovery, shim teardown, chat paging), and N3 (glass on the
composer and header) are in, and the **#321 visual shell is complete —
all five steps shipped and audited against the code**: theme tokens from
main.css, 96 web-parity vector icons, the stable composer + header,
bubbles/quote/markdown/list rows, appearance settings + en/ru/fr
strings, the attach menu (photo/video/camera/file/stickers), and the
chat-list bottom action bar. N4 release signing is still open. The client
onboards from invites or QR scans, manages relays, switches accounts,
sends with attachments/quotes/reactions, renders images, encrypts its
database at rest, locks behind biometric/device-credential, and keeps
syncing in the background. Desktop tests gate every push, plus a
real-binary check when `VELTA_KMP_RPC_SERVER` is set. Debug APKs are
signed with the shared `composeApp/debug.keystore` and take epoch minutes
at build time as versionCode — one clock for CI and local builds, so the
newest build installs over any older one; ABI splits keep the phone APK
~28 MB, and every CI APK carries the core shim (#334). See [docs/PHASES.md](docs/PHASES.md)
for the per-phase ledger and what's left.

| Surface | Codebase | Status |
|---|---|---|
| PWA (`../app`) | build-less web UI | flagship, unchanged |
| Tauri shell (`../velta-app`) | wraps the PWA | unchanged until KMP parity |
| **KMP client (this dir)** | Compose UI + JSON-RPC core bridge | **work in progress** (Android delivery track), issue #192 |

## What works today

- **Onboarding** — stable's welcome splash (#334): Create an account
  (relay address, `dcaccount:`/`DCLOGIN:` code, relay invite link
  `https://<relay>/i/<token>`, or **Autopick the fastest relay** — the
  core's `init_transports` probes its built-in public relay pool and keeps
  the first that answers and configures), Add as a second device
  (`DCBACKUP` code), Restore from a backup (tar / gzip). Step list driven
  by ConfigureProgress, nickname ask, version line and App log footer.
  **Scan a QR** (📷, CameraX + ZXing, decoded on-device) and invite links
  (`dcaccount:`/`dclogin:`/`dcbackup:`/`openpgp4fpr:`, `i.delta.chat`)
  feed the same paths; a contact/group invite on a fresh install picks a
  relay near the inviter and joins after setup.
- **Relays** — ⚡ screen: one card per transport with C/I/P/D capability
  flags and relay-provided details; remove.
- **Accounts** — 👤 switcher; the core's selected account persists across
  restarts (probed), so the choice survives with zero local storage.
- **Messaging** — chat list with the #57 category chips (All / Unread /
  People / Groups / Channels / Bots / System, persisted selection, lazy
  bot flags), the full #329 bottom action bar and the side views it
  toggles: Contacts (`get_contacts` + "Show only known contacts"), Calls
  (local ended-call log), Your QR code (the Tauri look: per-domain tabs —
  velta.cc / i.delta.chat / i.deltachat.id / i.gluek.info — with the
  white branded square QR + dark V badge for velta.cc's `/join/?…`
  universal links and the core's invite card for i.delta.chat, copy/share),
  Search (live filter +
  Archived tab), and Start something (new chat / group / channel with
  real create flows, join invite, add relay, add account); chat view
  (day separators, sender names in groups, media, quote blocks with
  tap-to-jump, markdown: bold/italic/underline/code-click-to-copy,
  links, bare links, @mentions, hashtags, invite cards that route to
  the Join flow), composer with drafts, the attach menu (Photo / Video /
  Camera / File / Stickers — camera capture via FileProvider), quick
  reactions, sticker picker, and delivery-state glyphs. Chat rows carry
  the web anatomy: 22%-radius avatar tiles (identity matrix, saved/device
  gradient tiles, photos), list-time stamps, draft/request red previews,
  outgoing ticks, accent-2 unread badge pills (grey when muted). Media
  previews pass the core's own emoji through (no doubled 📷). **Touch
  gestures**: swipe the chat list left/right to step through the category
  chips, swipe a bubble right to reply (haptic at the commit line), swipe
  the history left to go back — thresholds ported from the web's touch
  handlers, touch form factors only.
- **Settings** — appearance: theme (Auto/Dark/Light/Brutal), the
  "Pure black (AMOLED)" flag, custom accent color (WCAG-checked
  derivation, 8 presets + custom hex), and language (English /
  Français / Русский, applied live). Settings persist per platform
  under the same keys the web app uses.
- **Security** — database encryption at rest (Keystore-wrapped DEK →
  `VELTA_DB_KEY`, patch #20 contract; on-disk db verified ciphertext);
  optional app lock (🔒 strong biometric/device-credential — locked = the
  core never starts, nothing decrypts; auto-lock after 1/5/15 min hidden,
  like stable's "Lock when hidden"). Port of #178, with two Tauri-side
  keystore bugs (undersized wrap blob, StrongBox fallback) fixed here.
- **Persistence** — resume straight into the chat list on every start;
  the core's accounts dir holds the data, app-level settings ride the
  platform prefs (SharedPreferences / java.util.prefs).
- **Background** — a remoteMessaging foreground service (like stable; no
  Android 15 dataSync time cap) holds the process (screen
  off); after a process kill the sticky service rebuilds the core
  headlessly (`am crash` verified); UnifiedPush receiver wired (relay-side
  notifier still pending); battery-allowance row for OEM savers.
- **Profile** — the contact sheet: fingerprint identity matrix (or Prism
  tile), media counts, profile key, last seen, notifications and
  disappearing-messages state, block/unblock.
- **Notifications** — one conversation card per account + chat on a
  Messages channel, for every account (events route by `contextId`);
  muted chats are skipped, and the open chat only while the app is
  visible; cards clear when the chat is opened or read elsewhere; a tap
  switches to the right account and opens the chat. Visible unseen
  messages get `markseen_msgs` (read receipts). Read/delivered/failed,
  reactions, chat and contact changes and chat-list events update live
  (#334). (Background delivery still needs the relay-side UnifiedPush
  notifier.)
- **Look** — `VeltaTheme` built from tokens generated from Velta
  stable's `app/css/main.css` (#318): dark, light, brutal and AMOLED,
  selectable in Settings; Prism person colors and fingerprint identity matrices are
  bit-identical to the PWA (vectors pinned in `PrismIdentityTest`).
  The chat list header has the logo, search, and a relay-status strip —
  one segment per relay in its own state color, with a pull-down detail
  bar (masked relay domains + the sending relay's envelope) and the
  bottom action bar (Chats / Menu) under the list. Bubbles carry the
  Tauri design: sender-side tail corner, in-bubble timestamps with
  per-side meta colors and read-tick blue, media bleeding through the
  padding, video/file/audio cards with size + duration chips, in-bubble
  reaction pills, mono service messages, and the .day-chip separators.
  The chat header is the web's velta-chat-head: 42dp avatar, name, and a
  status line (member count / last seen / bot), with the chat menu dots
  for every chat. All 96
  chrome icons are web-parity vectors generated from `icons.js` — no
  emoji buttons. The composer and the headers are glass on Android 13+
  (a blur on Android 12, a translucent plate otherwise). The header
  glass continues under the status icons.

## Theme, icons, and strings — all generated from the web source

Three generators keep the KMP client in the web's family; each has a
staleness test that fails CI when the committed file drifts:

```sh
node tools/gen-kmp-theme.mjs     # ui/VeltaTokens.kt   <- app/css/main.css
node tools/gen-kmp-icons.mjs     # ui/VeltaIcons.kt    <- app/js/icons.js (eval'd, no hand copies)
node tools/gen-kmp-strings.mjs   # ui/LangRu.kt, LangFr.kt <- app/locales/*.json
```

`tests/kmp-theme-tokens.test.mjs`, `tests/kmp-icons.test.mjs` and
`tests/kmp-strings.test.mjs` (part of `node --test 'tests/**/*.test.mjs'`)
fail when a generated file is stale; the strings test also fails when an
`L.t("…")` call site has no key in BOTH web packs (the English string IS
the key, per `app/js/i18n.js`; untranslated text stays English).
`Theme.kt` maps the tokens onto Material3 (`ColorScheme`, `Typography`,
`Shapes`); tokens Material has no slot for (bubbles, meta ink, read
ticks, quote names, chat ground…) come from `Velta.tokens`
(`LocalVeltaTokens`). The theme mode + AMOLED flag + custom accent
(WCAG-derived in `Accent.kt`, port of `chat-appearance.js`) are picked
in Settings; `color-mix()` tokens (hover/pressed, call screen) aren't
generated.

## Layout

```
composeApp/src/
  commonMain/    Compose UI + AppModel + VeltaCore facade (PURE Kotlin — no java.*);
                 ChatCategory.kt (#57 buckets) + QrEncode.kt (Nayuki port)
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
on every push touching this dir (or `core/`); the `shim` job builds the
Android core `.so` on every run, the APK job bundles it and refuses to
upload an APK without it, and `shim-test` runs the shim's `cargo test`.

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
connects with a plain socket transport. Every connection must open with a
per-launch random token the app hands the shim at start (#334) — other
apps on the device can reach loopback, but not the core. Same architecture as the Tauri
Android shell. Build recipe (WSL, NDK exports) is in [AGENTS.md](AGENTS.md);
the CI `shim` job publishes ready-made `.so` artifacts (`velta-rpc-shim-so`,
laid out as `jniLibs/<abi>/`) and every CI APK already bundles them. The files stay out
of git (same rule as the Tauri `binaries/`).
