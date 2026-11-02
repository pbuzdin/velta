# Phase status & gap ledger

Tracking issue #192. Updated 2026-11-02 after P5 slice 1. Every phase lists
what SHIPPED, how it was VERIFIED, and what is still MISSING — no "done"
without the gaps next to it.

## Remaining work at a glance

**Done since the last roadmap (all shipped, see per-phase sections):**
UnifiedPush receiver (slice 8), encryption at rest + 2 Tauri keystore bugs
found (slice 9), battery-allowance row (10), app lock — biometric /
device-credential (11), QR-camera scanner (12), release builds + size —
debug 135→69 MB, release 57 MB (P5 slice 1).

**P4 leftovers (small):**
1. Video/audio playback in bubbles (images already render).
2. Brand logo assets (app icon, in-app mark).

**P5 — release track (slice 1 done):**
1. Production keystore + distribution channel decision (release lane
   currently signs with the debug key by design); ABI splits if a channel
   wants them (~halves the APK again).
2. Crash reporting.
3. CI release lane (signed artifacts on tag).
4. `org.velta` switchover decision.

**Separate relay project (client side done):** end-to-end push needs
PLAN-UNIFIEDPUSH.MD items 1–3 (notifier keypair swap, ntfy, maildir hook).

**Standing (human-only):**
- The P3 live gate — a throwaway-account login, 7-step checklist below;
  the 🎟 invite-paste / 📷 scan paths make it a copy-paste job.
- #178 on-device re-verification for the TAURI shell (its VeltaKeystore
  regressed — see `../TAURI-IMPROVEMENTS.MD` §7b).

| Phase | State | Commit | CI |
|---|---|---|---|
| P0 Scaffold | ✅ done | `3e78085b` | green |
| P1a Core bridge (desktop) | ✅ done | `2ee90088` | green |
| P1b Android in-process core | ✅ done | `2cd1c8f2` | green |
| P2 Persistence + read paths | ✅ done | `cbb3809b` | green |
| P3 Write paths | ✅ code complete — live gate pending | `fd2a405c` + quote-restore | green |
| P4 Velta layer | 🚧 slices 1-12 done | — | — |
| P5 Release track | 🚧 slice 1 done (release builds + size) | — | — |

---

## P0 — Scaffold ✅

**Shipped:** `composeApp` KMP module (commonMain/jvmCommon/androidMain/desktopMain),
Gradle 8.14.3 wrapper lifted from the proven Tauri gen project, version catalog
(Kotlin 2.2.20 / AGP 8.13 / CMP 1.9 / compileSdk 36), `build-kmp.yml` CI,
README.

**Verified:** CI green on both targets (assembleDebug + desktop package).

**Missing / accepted gaps:**
- Debug builds only — no signing, no release config (P5).
- No static analysis (ktlint/detekt) anywhere in the pipeline.
- minSdk raised 24 → 26 for java.time; API 24/25 devices are left to the Tauri app.
- CI runs on ubuntu only; no mac/windows CI lane for the KMP app.

## P1a — Core bridge, desktop ✅

**Shipped:** `RpcClient` — JSON Lines RPC, positional params, id-correlation,
channel-driven reader (pure common Kotlin); `VeltaCore` typed facade;
Login → ChatList → Chat UI; desktop sidecar spawn
(`VELTA_KMP_RPC_SERVER` → `bin/` sibling → PATH); test suite.

**Verified:** WSL end-to-end vs a real `deltachat-rpc-server` 2.66.0 built from
the vendored core (handshake, add_account, empty chatlist); fake-transport
tests incl. out-of-order correlation and error mapping; CI green.

**Missing:**
- `call()` has no timeout — a wedged core hangs that call forever (needs a
  timeout + core-respawn story).
- No reconnect/respawn when the sidecar dies: UI just goes stale.
- Narrow RPC surface only — no contacts, QR, backup, config settings yet.
- Desktop sidecar binaries aren't produced/attached by CI (P5 item).

## P1b — Android in-process core ✅

**Shipped:** `native/rpc-shim` Rust cdylib (Accounts + CommandApi + yerpc,
session per connection, JSON Lines on 127.0.0.1) loaded via JNI;
`SocketRpcTransport`; INTERNET permission; per-ABI shim build recipe; CI
`shim` job (dispatch-triggered artifacts).

**Verified:** Pixel_7 emulator — shim loads, core 2.66.0 handshake,
connected state; distinct shim error codes exercised during debugging.

**Missing:**
- Shim lifecycle is start-only: no `stopCore`/JNI teardown, no crash-restart,
  no guard against a second `startCore` spawning a second runtime.
- `.so` files are manual: fresh clones need the WSL build or a manual artifact
  download; no gradle wiring to fetch CI artifacts.
- No core logging on-device (stderr invisible; diagnosed via return codes).
- APK 130 MB debug (both ABIs unsplit); release needs LTO/`panic=abort`/ABI splits.
- Only x86_64 emulator verified — no real-device run yet.
- No background service / push (P4 endgame; today the core dies with the process).

## P2 — Persistence + read paths ✅

**Shipped:** resume-from-core (`get_all_account_ids` → first configured →
ChatList, unconfigured accounts reused by login retries — the core's accounts
dir IS the storage); day separators; group sender names (`get_contact`);
`marknoticed_chat` on open; media-type glyphs; Android system back
(expect/actual); per-platform connect hints; `ScriptedRpcTransport` test kit.

**Verified:** resume + fallback unit tests, real-binary IT, full WSL gate,
emulator regression (connected, zero failure logs), CI green.

**Missing:**
- **Media not rendered** — images/files/voice are glyph placeholders; blob
  paths are never loaded or displayed.
- Avatars ignored (letter chips only).
- No unread-divider, no search (chats or messages).
- Account switcher absent — first configured account wins.
- Chat view loads ALL message ids (no paging) — fine for small chats, unbounded
  for large ones.
- Sender names load once per chat open (no reactive refresh).
- Day-grouping and contact-name fetch have no dedicated tests.
- Emulator-only verification; no device run with a real account yet.

## P3 — Write paths 🚧 (first slice shipped)

**Shipped:** the draft-based send path — `misc_set_draft` → `misc_send_draft`
(text + quotes via `quotedMessageId`), composer UI (text field, reply chip,
send button), draft restore on chat open + save/remove on back, send-error
restores the typed text, outgoing delivery-state glyphs (⏳ pending / ⚠️
failed / ✓ delivered / ✓✓ read) from the core's real state numbers,
message action bar on bubble tap (quick reactions via `send_reaction` +
reply), reaction summary chips under bubbles, immediate reload after send,
**attachments** — 📎 picker (desktop `FileDialog` / Android SAF staged to a
cache file), the core dedups the file into its blobdir
(`set_file_and_deduplicate`), captions optional, attachment chip + draft
persistence + error restore.

**Verified:** scripted tests (plain + quoted + attachment params + reaction
params + reload-after-send ordering), wire-casing regression test, and the
real-binary IT round-trips BOTH a text and an attachment device message
through `add_device_message` → `get_messages` (file physically present in
the blobdir) — no account, no network, on every CI run.

**Finding — SOLVED (was a client bug, not a core limitation):** the missing
no-network write-path e2e traced to a wire-casing bug in OUR client:
`MessageLoadResult` is enum-level camelCase-tagged → real responses carry
`kind:"message"` (lowercase), while our filter expected `"Message"` — every
real message was silently dropped (the scripted fixtures shared the wrong
casing, which hid it). Fixed + pinned by `WireCasingTest`; the real-binary IT
now round-trips a device message through `add_device_message` →
`get_messages` on every CI run, no account needed. Lesson recorded in
AGENTS.md: fixture data must be probed from the wire, never assumed.
Also corrected: delivery-state numbers are 20=Pending, 24=Failed, 26=Delivered,
28=Read (core/src/message.rs), not 10/13/16/26.

**Missing:**
- **The P3 exit gate** — the one step that needs human hands, everything else
  is CI-tested. Checklist (15 min):
  1. Desktop: `VELTA_KMP_RPC_SERVER=<deltachat-rpc-server> ./gradlew :composeApp:run`
  2. Sign in with a **throwaway** account (invite creds, not a daily account)
  3. Chat list loads; open any 1:1 chat
  4. Send a text → bubble appears ⏳ → flips ✓ when the relay takes it
  5. Send an attachment → arrives in the receiving client with the right name
  6. React 👍 to the reply → chip appears under the bubble
  7. Quote-reply → quote renders in the receiving client
  Then tick the gate in this file and the issue.
- Attachment DISPLAY in the chat view — sending works (picker → core
  dedup into blobdir), but bubbles show only the 📎 glyph; rendering and
  opening blob files is the media-rendering item.
- Attachment pickers are verified by tests + compile only — no device run yet.
- No optimistic fake rows — deliberate: after `misc_send_draft` returns the
  message is already in the db, so the immediate reload shows the real
  OutPending bubble with ⏳ (no fakery to reconcile later).

## P4 — Velta layer 🚧 slice 1 done

**Slice 1 — theming (shipped):** `VeltaTheme` lifted from the PWA's tokens
(`app/css/main.css`): dark bg `#0f0f14`, elev `#1c1c26`, accent `#5aa2e6`,
outgoing bubble `#2b5278`; light bg `#f4f4f4`, accent `#3390ec`, out-bubble
`#e1f0fb`. Follows the system setting; verified on the emulator in BOTH
modes via screenshots.

**Slice 2 — relay cards (shipped):** ⚡ entry on the chat list → Relays
screen with one card per configured transport: address, capability flags
**C**alls (TURN) / **I**roh / **P**ush / **D** instant-delivery (green =
advertised, grey = not offered or not known yet), relay-provided details
(comment, admin, recipients-per-message, compression), Remove action.
Data: `list_transports` (sending transport first, quilt #11) merged with
`get_server_metadata` (#15) by address. Scripted test pins the merge,
ordering, "not known yet" fallback and delete params; the real-binary IT
covers both RPCs on a fresh account.

**Slice 6 — foreground service (shipped):** a `dataSync` foreground service
holds the app process — and with it the in-process core shim — while the
screen is off. Started on activity stop, stopped on resume; MIN-importance
"Background sync" notification; POST_NOTIFICATIONS requested at launch.
Verified on the emulator: `dumpsys` shows the ServiceRecord with
`isForeground=true`, dataSync type, ongoing notification, process held.
Because the shim and the event loop live at process scope, holding the
process IS the sync story — no extra plumbing.

**Slice 12 — mobile QR-camera (shipped):** the Join screen gains
"📷 Scan a QR instead" (Android only; hidden on desktop where the callback
is null). `ScanActivity` = CameraX preview + `ImageAnalysis` frames →
ZXing `QRCodeReader` over the luma plane (pure-Java decode, no Google
services — fits the privacy posture). On the first decode the payload
goes **straight to the process-wide model** (`onQrScanned`) and the
activity finishes — no ActivityResult: FragmentActivity's legacy
`startActivityForResult` rejects the registry-generated request codes
("lower 16 bits" crash, caught live on the emulator and routed around).
The Join screen then pre-fills, checks, and routes as usual.
`QrRoundTripTest` pins the encode→decode pipeline.

**Slice 11 — app lock (shipped, phase-4 port; biometric/device-credential):**
🔒 row on the Accounts screen enables/disables the lock (each tap runs the
system prompt). With the lock on: cold start does NOT start the core —
`getOrCreateDek` refuses, the platform reports locked, and the whole app is
replaced by a lock screen; the DEK exists only in the auth-window wrap
(`dbkey.bio`, 30 s Keystore validity after a successful prompt, biometric or
device credential). Unlock: prompt → `unlockDek` inside the window →
`spawnRpcServerWithKey(dir, dek)` → core opens the encrypted databases. The
Foreground service while locked holds a process with NO core (nothing
decrypts without auth — the correct trade-off). MainActivity migrated to
`FragmentActivity` (BiometricPrompt requirement). Scripted test: locked
platform blocks every RPC and the plain spawn path; unlock spawns exactly
once with the DEK. **PIN fallback (Argon2id wrap, the Tauri phase-4 shape)
is deferred** — biometric/device-credential only for now; the on-device
enable→restart→prompt→unlock walk joins the gate checklist (needs a
configured account to reach the Accounts screen).

**Slice 10 — battery allowance (shipped):** a Battery row on the Accounts
screen — restricted/exempt state from `PowerManager.isIgnoringBatteryOptimizations`,
tap fires the system `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` dialog
(the app holds the permission; adb shell cannot resolve the activity, which
is why the row's tap-through is verified in the gate checklist rather than
by script), state re-read on resume. Whitelist effect proven via
`dumpsys deviceidle whitelist`.

**Slice 9 — database encryption at rest (shipped, Android):** the #178 port.
`VeltaKeystore` (androidMain) is a faithful port of the Tauri wrap format —
non-exportable "velta_kek" (StrongBox → plain fallback) wrapping a random
256-bit DEK into `noBackupFilesDir/dbkey.wrap` (v1+iv+GCM(ct), atomic
write), DEK handed to the shim as 64-hex; the shim sets `VELTA_DB_KEY`
before any thread exists (patch #20 reads it at account open; empty =
keyless = upstream). **Verified**: fresh start creates the wrap (61 bytes);
the real-core headless check shows the on-disk db is ciphertext (random
header), restart with the key opens the account, restart without it stays
locked ("no SQL connection"); app restart unwraps (no new key).
**Two Tauri bugs found and fixed in the port** (see
TAURI-IMPROVEMENTS.MD §7b): the StrongBox fallback was dead code
(generateKey outside the fallback try) and the wrap blob was sized without
the GCM tag (copyInto overflow on every device) — net effect: Tauri
Android installs have been running keyless, encryption inert.

**Slice 8 — UnifiedPush receiver (shipped):** `VeltaPushService : PushService`
(connector `org.unifiedpush.android:connector:3.3.4-rc1`, PUSH_EVENT filter)
mirrors the Tauri shell's contract: `onNewEndpoint` serializes the webpush
token (`webpush:<url>|<pubkey>|<auth>`) → `velta_set_push_device_token` (a
**shim-only RPC** — `Accounts::set_push_device_token` is not on the JSON-RPC
surface, so the shim intercepts that one method before dispatch and calls
the accounts manager directly; Rust test pins the interception),
`onMessage` → ensure-connected → `start_io_for_all_accounts` +
`background_fetch(30)` (a JSON-RPC method — the fetch results surface
through the event loop). Auto-registration follows the Tauri rules
(single/resolved distributor, VAPID key constant, no-distributor = silent
skip). Token registration lands via IMAP METADATA on next io.
**End-to-end push still needs the relay side** (notifier keypair swap,
ntfy, the maildir hook — PLAN-UNIFIEDPUSH.MD items 1-3, a separate
relay-side project).

**Slice 7 — restart-on-kill (shipped):** `AppHolder` makes the AppModel a
process-wide singleton shared by the UI and the service; `connect()` is
idempotent (a guard plus a re-entrancy flag — one core, one event loop,
whichever call wins). When the system kills the process, the sticky
service restarts into a fresh process and its `onStartCommand` bootstraps
everything headlessly: shim respawns, client reconnects, handshake +
resume run without the UI. **Verified live on the emulator**: `am crash`
→ new pid, service foreground again, and the service-side
`velta-kmp: connect ok — core v2.66.0` in logcat.

**Slice 6 — foreground service (shipped):** a `dataSync` foreground service
holds the app process — and with it the in-process core shim — while the
screen is off. Started on activity stop, stopped on resume; MIN-importance
"Background sync" notification; POST_NOTIFICATIONS requested at launch.
Verified on the emulator: `dumpsys` shows the ServiceRecord with
`isForeground=true`, dataSync type, ongoing notification, process held.
Because the shim and the event loop live at process scope, holding the
process IS the sync story — no extra plumbing.

**Epic remainder:** the UnifiedPush receiver (token registration +
message-triggered fetch) and the battery-allowance onboarding UI.

**Slice 5 — account switcher (shipped):** 👤 entry on the chat list →
Accounts screen listing every account (`get_all_accounts`), current one
badged, tap to switch (`select_account` → composer/reply/attachment state
reset → chat list reload). The core's own selection **persists across
restarts** (probed: select 2 → restart → still 2), so resume now prefers
the core-selected account when it's configured — the switch survives
restarts with zero local storage. "Add account" routes to the login
screen; unconfigured accounts show "not set up" and are not switchable
(their fixture: sign in on them).

**Slice 4 — invite/join (shipped):** 🎟 entry (chat list ⚡ + "Have an invite
code?" on the login screen) → paste a QR payload → `check_qr` parses it
OFFLINE (kind + domain/group name shown in plain language) → routed:
`account` QRs onboard a relay (`add_transport_from_qr` → configure → io —
this IS the throwaway-login path, paste instead of typing),
`askVerifyContact/Group/Broadcast` QRs run `secure_join` (the protocol
proceeds in the background; the chat appears), anything else says so.
The live-binary IT pins `check_qr` on garbage (kind "text") and a real
`DCACCOUNT:` string (kind "account" + domain) — no network needed.

**Slice 3 — media rendering (shipped):** image viewtypes (Image/Gif/Sticker)
render the blob file inside the bubble — dependency-free expect/actual
decoders (Android `BitmapFactory`, desktop `ImageIO` →
`toComposeImageBitmap`), decoded on Dispatchers.IO with a loading
placeholder; captions still render; non-media viewtypes keep their glyphs.
`DecodeImageTest` covers the JVM decoder against a real PNG (dimensions)
and junk paths. Note: platform files for expect/actual must not share a
FILE NAME across source sets — the JVM facade collides (Media.kt →
MediaAndroid.kt/MediaDesktop.kt).

**Slice 2 not included (deliberate):** per-relay enable/disable toggle —
`set_transport_enabled` does not exist in the core yet (proposed quilt
patch #24, issue #189). The W flag (C3 websocket probe) is browser/Tauri
specific and skipped.

**Next slices (planned):** account switcher, QR-camera scanning on mobile,
video/audio playback, UnifiedPush + foreground service, at-rest lock port,
brand logo assets.

## P5 — Release track 🚧 slice 1 done

**Slice 1 — release builds + size (shipped):**
- **Shim size profile**: `lto + codegen-units=1 + opt-level="s" + strip` in
  the shim's Cargo.toml — per-ABI `.so` from **56/64 MB → 25.9/28.7 MB**.
  panic stays unwind (an abort would take the whole app process down; the
  sticky service recovers anyway, but no added failure modes).
- **R8 minify + resource shrink** on the release build type, with keep
  rules for the JNI surface (`RpcShim` native methods — R8 renaming would
  break symbol resolution), kotlinx.serialization wire models, and the
  UnifiedPush connector dispatch. A latent lint failure surfaced: biometric
  1.1.0 drags in fragment < 1.3 which breaks the ActivityResult API — fixed
  with an explicit `fragment-ktx` 1.8.6 dependency.
- **Signing config**: `keystore.properties` (gitignored) when present,
  falling back to the debug key so release APKs stay installable — the
  production keystore decision remains open.
- **Verified**: minified release APK (57 MB) installed on the emulator —
  StrongBox fallback, DEK creation, and the handshake all green through the
  minified code.

**Measured**: debug 135 MB → **69 MB**, release **57 MB** (universal,
both ABIs). Further cuts available if needed: ABI splits (~halves again)
for Play delivery.

**Remaining in P5**: production keystore + distribution channel, crash
reporting, CI release lane (signed artifacts), the push-epic relay side,
and the `org.velta` switchover decision.
