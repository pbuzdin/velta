# Phase status & gap ledger

Tracking issue #192. Updated 2026-11-14 after the review-fix round,
touch-gesture port, and chat-header port. Every phase lists what SHIPPED,
how it was VERIFIED, and what is still MISSING — no "done" without the
gaps next to it.

## Remaining work at a glance

**Done since the last roadmap (all shipped, see per-phase sections):**
UnifiedPush receiver (8), encryption at rest (9), battery-allowance row
(10), app lock (11), QR-camera scanner (12), release builds + size (P5
slice 1), N1 Prism + identity matrix, N2 conversation notifications +
RPC timeout/recovery + shim teardown + chat paging, N3 glass, the
**#321 visual shell, ALL FIVE STEPS** (2026-11-13, verified against the
code by audit): theme tokens from main.css, 96 web-parity vector icons,
stable composer + header, bubbles/quote/markdown/list rows (+ the
markdown-pipeline completion: bare links, mentions, invite cards,
click-to-copy, quote thumbs, sticker picker, attach menu with camera
capture), appearance settings + en/ru/fr strings, and the chat-list
bottom action bar (#329 partial: Chats + Menu). Invite handling was
corrected to invites.js semantics (canonical i.delta.chat links, 40-hex
on both forms, safe percent-decode). **2026-11-14: the main screen now
matches web stable end to end — #57 category chips + the full #329 bar
with Contacts / Calls / QR / Search / Start-something side views (see
the 2026-11-14 entry).**

**#321 fidelity follow-ups (filed, open):**
- #323 mention @-autocomplete picker + mentionsMe notify gate.
- #324 invite surface: short links, relay chips, domain registry, card
  copy/share.
- #325 markdown: `> ` quote blocks, hashtag rules, trimLinkEnd, nested
  emphasis, `+` bullets, list grouping.
- #326 sticker save flow, quote attachment on sticker sends, visibility
  rules.
- #327 quote-tap fetch-then-jump beyond the loaded window.
- #328 chat-appearance extras: text size, bubble corners, hyphenation,
  stickers-in-attach, glass toggle.
- #329 CLOSED 2026-11-14 — the full bar + Contacts / Calls / QR /
  New-chat side views shipped (see the 2026-11-14 ledger entry).

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
  the 🎟 invite-paste / 📷 scan paths make it a copy-paste job (#221).
- #178 on-device re-verification for the TAURI shell.

| Phase | State | Commit | CI |
|---|---|---|---|
| P0 Scaffold | ✅ done | `3e78085b` | green |
| P1a Core bridge (desktop) | ✅ done | `2ee90088` | green |
| P1b Android in-process core | ✅ done | `2cd1c8f2` | green |
| P2 Persistence + read paths | ✅ done | `cbb3809b` | green |
| P3 Write paths | ✅ code complete — live gate pending (#221) | `fd2a405c` + quote-restore | green |
| P4 Velta layer | 🚧 slices 1-12 done | — | — |
| UI visual shell (#321) | ✅ all 5 steps done + audited | `f98f8808`..`3dfadecd` | green |
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
- `call()` bounds ordinary RPCs (60s, 180s for configure / join / fetch).
  `get_next_event` stays a long-poll. A timeout or a dropped connection
  respawns the desktop sidecar. On Android a timeout kills the process
  (the in-process shim cannot be restarted beside a wedged one); a dropped
  socket reconnects to the same port. A second `startCore` is refused.
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

**Slice 1b — generated theme (#318):** the hand-copied palette above had
drifted (light chat ground and incoming bubble swapped, dark chat
`#0f0f14` instead of `--bg-chat #0b0b10`, dark text `#e8eaf0` instead of
`#f2f2f5`, dark outline brutal's `#45434f`). `tools/gen-kmp-theme.mjs` now
generates `ui/VeltaTokens.kt` from main.css for dark, light, brutal and
AMOLED; `tests/kmp-theme-tokens.test.mjs` fails when it's stale. Bubbles,
chat ground, meta ink and read ticks use the tokens; message text is
15.5sp / 1.36. Next: icons as ImageVectors, Velta header/bar/composer,
custom bubbles and rows, appearance settings, en/ru/fr.

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
**Two Tauri bugs found and fixed in the port:** the StrongBox fallback was
dead code (`generateKey` outside the fallback try) and the wrap blob was
sized without the GCM tag (`copyInto` overflow on every device). Both are
fixed in `velta-app/.../VeltaKeystore.kt` (`pack()`, `setIsStrongBoxBacked`).

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

## 2026-11-12 — KMP back in work, N0/N1

KMP is back in active work as a work in progress (the Rust UI preview
stays a separate experiment, #314). Shipped:

- **Design port (N1)** — Prism person colors + the fingerprint identity
  matrix, bit-identical to the PWA (vectors pinned in PrismIdentityTest,
  including a real profile's legend); chat-list tiles, group sender
  colors, and the contact-sheet profile screen (identity matrix, media
  counts, profile key, last seen, block/unblock).
- **Conversation notifications** — IncomingMsg events post per-chat cards
  (Messages channel, notification id = chat id), muted chats and the
  on-screen chat skipped, tap deep-opens the chat (singleTop +
  pendingOpenChatId).
- **Timestamp fix** — RPC timestamps are unix seconds; day headers and
  bubble times rendered Jan 1970 (TimestampTest guards it).
- **CI** — build-kmp.yml unfrozen: builds/tests on every master push
  touching velta-kmp/**, and uploads the debug APK as an artifact.

**Missing / next (N2, N3):** background delivery of notifications still
needs the relay-side UnifiedPush notifier; RPC `call()` has no timeout and
no core respawn; shim lifecycle is start-only; Storage and
Chats-in-common profile rows; AGSL glass on the composer/header;
ktlint/detekt.

## 2026-11-12 — N2 slice 2: connection hardening + join repair (#316)

The audit's must-fix bugs and the vivo max-relays fallout, in one pass:

- **Dead core no longer hangs the UI** — when the transport exits, RpcClient
  fails every in-flight call, marks itself dead (new calls throw fast), and
  fires `onDead`; the deliberate `close()` path does NOT count as a death.
  The event loop stops after 5 consecutive failures instead of hot-spinning.
- **No more double-spawn split-brain** — `RpcShim.startCoreOnce` caches the
  shim's loopback port per process (the shim is a long-lived accept-loop
  server, so the port stays valid for reconnects); `connect()` tears a
  failed handshake down (client close, core/transport released) before a
  retry, and `onCoreDead` drops the UI to "core connection lost" + one
  self-heal reconnect after 2 s.
- **Reload coalescing** — MsgsChanged/IncomingMsg/MsgsNoticed/MsgDelivered
  bursts mark chats dirty and flush ONE list/chat reload 200 ms later
  (scope is Dispatchers.Default, so the dirty set is lock-guarded).
- **Join replaces, not stacks** — an account/login invite first deletes an
  existing same-domain transport, so broken-flow retries can no longer pile
  duplicates up to the core's per-account cap.
- **Max-relays routes to the Relays screen** — the error attaches as
  `relaysNotice` (red line on top) and opens the relay manager, where a
  slot can be freed; previously a dead end.
- **Tests** — transport-death (pending fails, post-death calls throw,
  onDead fires, close doesn't false-fire), repeat-join replaces
  (delete before add), max-relays routing (Relays screen + notice);
  ScriptedRpcTransport gained `ERROR:` results for error responses.

**Still open in N2**: RPC `call()` has no timeout (a wedged-but-alive core),
paging for big chats (#223), shim stop/teardown, relay-side UnifiedPush.

## 2026-11-12 — N2 slice 3: call timeout, shim teardown, chat paging (#222/#223/#224)

The three skipped audit items, in one pass:

- **`RpcClient.call()` timeout** — 30 s default; a wedged-but-alive core
  (accepts the request, never answers) now fails with
  `RpcException(method, -2, "no response within 30000ms")` instead of an
  eternal spinner. Long-running calls opt out with `timeoutMs = null`:
  `get_next_event` (long-poll with no server-side timeout — an idle account
  may sit silent for minutes), `add_transport_from_qr` (probe + I/O
  restart), `add_transport`, `delete_transport`, `configure`,
  `secure_join`, `background_fetch` (has its own timeout parameter).
- **Errors name the method** — the pending map carries the method next to
  the deferred, so RpcException reads `add_transport_from_qr failed (…)`
  instead of `id=27 failed (…)`.
- **Shim stop/teardown (#224)** — Rust `stop_core`: a per-start Notify
  (fresh instance installed by every start — a stale permit can never kill
  a later session) ends the accept loop; live client sessions are aborted
  so nothing keeps the Accounts/sqlite handles alive; databases close with
  the process still up, so the next start spawns clean. Kotlin
  `RpcShim.stopCoreOnce()` clears the cached port; `AppModel.shutdownCore()`
  closes the client (deliberate close — no onDead) + stops the platform
  core; `VeltaForegroundService.onDestroy` calls it, so swiping the app
  away releases the core and a sticky restart rebuilds it via connect().
  The second-start guard from N2 slice 2 (startCoreOnce) stays.
- **Chat paging (#223)** — opening a chat fetches only the LAST 200 message
  ids (`get_message_ids` stays a single cheap call, `get_messages` carries
  the window); scrolling near the older end fetches the page before the
  window (`loadOlderMessages`). The chat list is now a `reverseLayout`
  LazyColumn (index 0 = bottom = newest): prepends add at the END of the
  data so the viewport stays anchored — jump-free history loading, and the
  auto-scroll only fires when the user is already at the bottom (no more
  yanking to the newest message while reading history). Event-driven
  reloads PRESERVE a wider window the user pulled in (loadedForChatId +
  loadedFromIdx). Sender names merge instead of replace (a prepend only
  passes the older page).
- **Tests** — call timeout (prompt, code -2, method named), error method
  name, open-fetches-last-page + loadOlder-fetches-remainder +
  hasMoreMessages transitions, reopen-preserves-window; Rust: stop-signal
  is per-start, stop-without-shim is a no-op.

**Still open in N2**: relay-side UnifiedPush notifier (push epic), shim
logcat visibility, `RpcException` codes could distinguish timeouts in UI.

## 2026-11-12 — N2 RPC hardening, chat-list header, N3 glass

- **RPC** — superseded by the slice-3 design above (30 s default with
  explicit opt-outs, dead-state fail-fast, shim stop + in-process
  reconnect — no process kill; the shim proved restartable via
  `startCoreOnce`/`stopCoreOnce`).
- **Resume** — a configured account calls `select_account` and
  `start_io_for_all_accounts`. `get_account_info` is read from kind
  `"Configured"`, not a missing `isConfigured` field.
- **Identity colors** — `identityFingerprintFromEncrInfo` follows web
  `parseFingerprint`: blank-line blocks first, then the 40-hex window
  inside the peer block.
- **Chat-list header** — logo, search, overflow menu, relay strip. The
  mark is `v_logo.png` (Android `painterResource` rejects SVG). The strip
  is one segment per transport, colored by account `get_connectivity`.
- **N3 glass** — composer and both headers sample one backdrop layer.
  API 33 is an AGSL Snell bevel (IOR 1.5, bevel 46% of the short side,
  peak shift 18% of the short side), clipped to the plate. API 31 blurs.
  Older APIs and desktop stay translucent. The header plate includes the
  status-bar inset. The lens is off while a reply, attachment, or
  message-action bar is showing. The composer sits on the keyboard:
  `adjustNothing` plus one `ime` union `navigationBars` padding.

**Missing / next (N4):** background delivery of notifications still needs
the relay-side UnifiedPush notifier. Still open on the client: Storage
and Chats-in-common profile rows, video/audio playback, the brand app
icon, ktlint/detekt, and N4 (release keystore, `org.velta` switchover).

## 2026-11-12 — #321 step 2: web-parity icons, emoji buttons dropped

- `tools/gen-kmp-icons.mjs` reads the REAL `app/js/icons.js` module
  (export-stripped eval, no hand copies) and emits
  `ui/VeltaIcons.kt` — 96 ImageVectors with the house style (24 grid,
  stroke 2, round caps + joins, black ink that Icon() tints). The
  generator parses SVG path d-strings (M/L/H/V/C/S/Q/T/A/Z + packed arc
  flags like `0 012-2`), circles, rects (rounded via 4 quarter arcs) and
  polylines into Compose PathBuilder calls; S/T reflective commands pass
  only the explicit args (Compose derives the reflected control).
- `tests/kmp-icons.test.mjs` fails CI when the generated file is stale.
- App.kt: every glyph button is now a vector — ‹ Back → arrowLeft,
  ✕ → close, ⓘ → info, 📷 → camera, ↩ → reply, 📎 → attach, Send →
  send, + → plus, 🔒/🔓 → lock/lockOpen, battery ✓/! → tick1/warn,
  bubble ticks ⏳⚠️✓✓✓ → clock/warn/tick1/tick2 (14 dp, meta-tinted),
  media chips → photo/video/sticker/mic/fileLarge/webxdc.
  Reaction emojis and the composer text remain content, not chrome.
- RelaysScreen notice race fixed: relaysNotice clears on
  backFromRelays, not on refresh (openRelays' refresh was nulling the
  max-relays reason it was given).

## 2026-11-12 — #321 step 3: composer + chat header to stable's structure

The composer is Velta stable's footer.composer now: 48dp circular icon
buttons (icons at --ico-5 = 26px), a 48dp-min 16dp-radius input wrap on
bgSidebar with a 1dp border, a naked BasicTextField (15.5sp / 1.3 line
height — the .msg-text ladder) with the textDim "Message" placeholder,
and the send icon tinted accentText when armed, textDim otherwise. No
Material chrome left in the composer. The chat header's back/info are
chevronLeft/info at textDim per .chat-head. The sticker button (inside
the wrap's right edge on the web) is skipped until a KMP sticker picker
exists. GLASS DEFERRED by user decision: the header's refraction
artifacts + rim line stay as-is for now (#321 step 5+ revisit).

## 2026-11-12 — #321 step 4: bubbles, quote block, markdown, list rows

- **Quote block** — MessageObject carries the core's MessageQuote now
  (JustText | WithMessage, camelCase fields); bubbles render the web's
  .msg-quote: 2.5dp accent bar, 6dp radius, measured WCAG text colors
  (#9aa3b5 in / #cfe0f2 out / #4d5a68 light; names accent / #d9e9fa),
  single-line ellipsis. Quote image thumbs not rendered yet.
- **Bubbles** = .bubble CSS: radius 14 with the 6px tail corner on the
  sender side, bgBubbleIn/Out tokens (were Material containers), 1dp
  shadow, 7/10/6 padding.
- **Markdown** (ui/Markdown.kt, port of app/js/markdown.js subset):
  bold/italic/underline/code, [label](https://…) + bare https links as
  URL-annotated spans, #hashtags, -/* bullets and numbered lines.
  Nearest-marker dispatch; the text between markers still parses
  emphasis (appendEmphasis). MarkdownTest pins spans, URLs, hashtags,
  lists, and that non-https is never a link. Not ported: invites,
  mentions, bare-link buttons, code-click-to-copy.
- **Chat-list rows** — photo avatar (decodeImage of avatarPath, 48dp
  crop) over the Prism tile, timestamp, mute/pin icons, counter badge.

## 2026-11-12 — step 4 completion: the skipped web behavior, ported

The rest of the markdown pipeline, no longer skipped: bare-links.js
(BareLinks.kt — TLD tier rules, boundaries, trimLinkEnd), mentions.js
(Mentions.kt — coded @(Name A1B2) + bare @Name forms, members cached per
chat via get_chat_contacts + fingerprints), code spans click-to-copy
(CODE annotation → clipboard), invite links (parseInviteLink → INVITE
annotation → the bubble renders the web's .invite-card; tapping routes
to the Join flow), quote image thumbs + quote-tap-to-jump (scrolls when
the quoted message is in the loaded window), and the sticker button +
picker (misc_get_stickers packs, send_sticker). Tests pin bare-link
tiers, mention resolution (both forms), invite annotation, and that
non-https never links.

<<<<<<< HEAD
## 2026-11-13 — step 4 fidelity fixes: invites.js semantics pinned

The web-parity audit of the step-4 completion found three places where the
invite port drifted from invites.js, now fixed and pinned by tests:

- **Canonicalization before the join** — invites.js normalizes every https
  invite onto `https://i.delta.chat/#<fp><payload>` because the core only
  parses that scheme; the KMP port passed the raw typed URL, so mirror
  links (velta.cc/#fp, i.gluek.info) rendered a card but could not join.
  parseInviteLink now RETURNS the canonical link and openInviteLink/
  markdown annotations carry it (AppModel, Markdown, App tap handler).
- **40-hex on BOTH forms** — web rejects `openpgp4fpr:junk`; KMP accepted
  it and routed it to Join. Now validated like invites.js:103.
- **Safe percent-decode** — java.net.URLDecoder crashed the composition on
  `?invite=%zz` and turned '+' into space (web decodeURIComponent does
  neither); replaced with a faithful decodeUriComponent (invalid escapes
  kept raw, '+' literal — the core's qr.rs reads '+' as space at the param
  level). The builtin invite-host list (velta.cc, i.delta.chat,
  i.deltachat.id, i.gluek.info) is restored: a 40-hex URL on another host
  (a git commit permalink!) is a plain link, not an invite card.
- **md-link invites stay anchors** — web markdown.js renders
  [label](invite) as a plain anchor (cards are bare-URL-only); the bubble
  tap handler intercepts invite hrefs (bindInviteInterception parity).

Still dropped (tracked as issues, see #321): the user-registered
"Invite link domains" registry, invite short links, velta://ws|proxy +
relay /i/ chips, invite-card copy/share + parsed labels, the composer
@-autocomplete picker, `> ` quote blocks and emphasis-nested markdown
tokens, the sticker save flow, and fetch-then-jump beyond the loaded
window.

## 2026-11-13 — #321 step 5: appearance settings + en/ru/fr strings

The web drawer's Settings section, as a screen (chat-list ⋮ menu →
Settings): Theme radios (Auto/Dark/Light/Brutal), the "Pure black
(AMOLED)" flag shown only while the effective theme is dark (app.js
applyTheme — AMOLED layers on dark, never its own value;
veltaEffectiveMode() pins that), accent presets + custom hex with the
FULL chat-appearance.js WCAG derivation ported (Accent.kt: luminance/
contrast/HSL math, soft-ink range, tintStable mention-chip convergence;
every derived pair >= 4.5:1, ticks 3:1, accent text 4.6:1 — pinned by
tests), and the language radios with NATIVE names (i18n.js LANGS).

- **Strings** — the English string IS the key (i18n.js:41-47);
  tools/gen-kmp-strings.mjs reads the REAL app/locales/{ru,fr}.json and
  emits LangRu.kt/LangFr.kt filtered to this client's 39 L.t("…") call
  sites; tests/kmp-strings.test.mjs fails CI on staleness AND on any used
  key missing from a pack. 39/39 keys covered by both packs. Keys with no
  web equivalent (App lock, Battery optimization, Refresh, …) stay English
  by the same rule the web uses for untranslated text.
- **Persistence** — SAME localStorage keys (dw-theme / velta-amoled /
  velta-accent / velta-lang) through the CorePlatform pref seam
  (SharedPreferences on Android, java.util.prefs on desktop); "en" and the
  stock accent store by REMOVING the key, like the web.
- **Deliberate deviations (documented, not silent):** the web reloads to
  switch language (DOM strings stamped at parse) — KMP applies live via
  compose state, so the reload hint became "Untranslated text stays in
  English."; the chat-appearance extras (message text size, bubble
  corners, hyphenation, stickers-in-attach, liquid-glass toggle,
  interface scale) are OUT of #321 step 5's checkbox text and tracked as a
  follow-up issue.

Tests: SettingsTest pins effective-mode AMOLED layering, normHex rules,
the full derived-contrast guarantees on the dark palette, brutal
BRUTAL_KEYS restraint, prefs round-trip through a NEW model, and the
translation fallback chain.
## 2026-11-13 — #321 step 5 + the attach menu

- **Attach menu** (web chat-view.js parity): the attach button opens
  Photo / Video / Camera / File / Stickers. Camera = ACTION_IMAGE_CAPTURE
  via FileProvider (manifest provider + res/xml/file_paths.xml); the
  pickers pre-filter image/* / video/* per kind. The sticker trigger
  moved OUT of the input wrap (#278 parity) into this menu.
- **Settings screen** (Accounts → Settings): Theme (System / Light /
  Dark / Brutal / AMOLED — the generated VeltaTokenSets), Accent color
  (default + 5 swatches; the override recolors accent + accentText, so
  links, quote bars, send, mentions all follow), Language (System /
  English / Français / Русский). Persisted via SettingsStore
  (expect/actual: SharedPreferences / java.util.prefs).
- **i18n** — I18n.t() port of app/js/i18n.js (English IS the key; fr/ru
  packs); tools/gen-kmp-locales.mjs emits ui/Locales.kt with only the
  keys the KMP references, from app/locales/*.json; staleness test
  tests/kmp-locales.test.mjs. Visible static strings swapped
  (attach menu, composer placeholder, settings, join card).

## 2026-11-13 — #329 partial: the chat-list bottom action bar (ListBar)

The web sidebar's `.list-bar` (index.html:60-79), shipped with only the
buttons whose targets exist: Chats (the only view — rendered per
.bar-btn.active: accent ink + 2px inset bottom accent line) and Menu (the
drawer trigger; the KMP items — Settings/Relays/Accounts/Invite/Refresh —
ride a DropdownMenu). Bar anatomy = the CSS: solid bgSidebar + 1dp top
border (in-flow, NOT glass — the web bar is solid), stretch-aligned 46dp
buttons, icons at --ico-4 (22dp), gap 6, padding 8/10/10. The header's ⋮
moved into the bar (the web sidebar-head carries only logo + search —
MenuMark dropped; the header now matches index.html:41-45). Contacts /
Calls / QR / New chat land with their views (#329 stays open for them).

## 2026-11-14 — main screen = web stable: #57 chips + #329 complete

User ask: "I want Velta KMP main screen look like our Velta Tauri stable
version" (two screenshots: stable vs KMP). Ported the whole main screen
against the web source, faithful per the standing rule.

**SHIPPED**
- **#57 category chips** (`CategoryChips`, `ui/ChatCategory.kt`): All /
  Unread / People / Groups / Channels / Bots / System, equal-flex pills
  under the relay strip. `chatKindOf`/`chatCategoryOf` port rpc-core.js
  (chatType drives group/channel; saved/device/deaddrop → system; single
  → bots via ContactObject.isBot / people). Unread = filter, not bucket.
  Selection persists under `velta-chat-category` (web key); bot flags
  ride ONE lazy `get_contacts` (web ensureContactBots; failure keeps old
  flags). Model fields added: `chatType`, `summaryStatus`,
  `lastMessageType`, `dmChatContact`, `Contact.isBot`.
- **#329 bottom bar COMPLETE** (`ListBar`): all six buttons —
  Chats/Contacts/Calls/QR toggle side views (`toggleListView`, web
  setListView toggle semantics; active = accent ink + 2dp inset underline,
  squared top corners), "+" = .bar-accent square → Start-something view,
  Menu = dropdown. Android back inside a side view returns to chats
  (`PlatformBackHandler` grew an `enabled` param).
- **Side views** (in place of the list, web sideViewShell): Contacts
  (rows + `velta-known-contacts-only` toggle, tap →
  `create_chat_by_contact_id`), Calls (LOCAL `velta-call-log` capped 30,
  fed by the core `CallEnded` event; rows = phone tile + chat name +
  timeAgo), Your QR code (`get_chat_securejoin_qr_code_svg` → link text
  → **`ui/QrEncode.kt`** = port of app/js/qr-encode.js (Nayuki, optimal
  segmentation) → Canvas matrix + copy/share (ACTION_SEND via injected
  `shareText`); Scan tab reuses ScanActivity, hidden on desktop), Search
  (live name filter min 2 chars first 30 + Archived tab =
  `get_chatlist_entries` listFlags=1) and the "Archived chats (N)"
  list-end link row. Sync strip "Fetching messages…/Updating…" ported
  (renderSyncBar rules).
- **Start something + creation flows** (web newChatOptions): contact
  picker screen (single/multi, selection highlight), group = multi-pick +
  name dialog + Admin-group switch → `create_group_chat` /
  `create_group_with_admin` + `add_contact_to_chat` loop, channel =
  `create_broadcast`. New wrappers in VeltaCore: `contacts`,
  `createChatByContactId`, `createBroadcast`, `createGroupChat`,
  `createGroupWithAdmin`, `addContactToChat`, `inviteQr`,
  `chatlistEntries(listFlags)`.
- **Row restyle** (`ChatListRow` + `AvatarTile`): web .chat-item anatomy —
  22%-radius tiles (identity matrix / saved+device gradient with
  avatarStar+device icons / photos / Prism+contact-color initials),
  ci-top name+formatListTime, ci-bottom ticks-from-summaryStatus + preview
  (media emoji prefixes; red "Draft:" untranslated + red "Contact
  request:"), right slot unread>pin>mute, accent-2 badge pill w/ muted
  variant, 999+ cap. i18n regenerated (88 keys × 2 packs); kmp-strings
  gate green.

**VERIFIED**: WSL gate green (desktopTest + assembleDebug + assembleRelease
arm64); new tests `ChatCategoryTest` (kind/category/state/preview vectors)
and `QrEncodeTest` (ZXing round-trips incl. astral payload — rasterized at
8 px/module, HybridBinarizer cannot read 37 px symbols). The Kotlin matrix
diffed BIT-IDENTICAL against the real `app/js/qr-encode.js` output.

**MISSING / deviations (named, not silent)**: per-relay strip state
colors (KMP RelayLine stays account-wide), typing-indicator previews
(KMP has no typing events), drawer config toggles for bar buttons/chips
(all always visible), the core QR SVG's card/logo decoration (KMP draws a
plain matrix), P2P "New local group" option (no P2P flag in KMP).

**PORT-BUG POSTMORTEM (qr-encode.js → Kotlin)**: three bugs cost a debug
cycle — rsMul masked inside the loop (JS masks only on return; `z >>> 7`
reads different bits), the zigzag loop must MUTATE `right` at the timing
column (6→5, next pair is (3,2) not (4,3)), and byte-mode `numChars`
counts bytes not UTF-16 units. Diagnosis recipe that worked: dump the
reference matrix via node (the real js module), dump the Kotlin matrix
via a throwaway test, diff rows; decode-side failures were the test's own
raster (scale to 8 px/module).

## 2026-11-14 (2) — design-system QA pass per velta.cc/design

User: "maybe velta.cc/design can help you" — the generated token
reference (built from app/css/main.css, staleness-gated). An audit of its
contracts against the main-screen port found one real bug + four gaps,
all fixed:

- **Muted badge ink (light theme)** — web `.ci-badge.muted` ink =
  `--on-badge-muted` (#f4f4f4 in light, main.css:129,1829); KMP always
  used onBadge (#10131a on #5d626d ≈ 2.6:1). Generator now emits
  `onBadgeMuted`; badge uses it when muted.
- **Single-contact photos on the matrix** — web avatar.js pads a 1:1
  contact's photo onto the identity matrix (inset 19.17%, 2.5% padding,
  #1c1c1c ring, radius 24.3%); KMP photos were full-bleed. `AvatarTile`
  now renders the photo-on-matrix variant; group photos stay full-bleed.
- **Dialog contract** — `VeltaDialog` (web .modal): radius-16 bgSidebar
  card ≤420dp over a 45% scrim on desktop widths, FULL-SCREEN under 600dp
  (web's ≤600px breakpoint); ONE filled accent confirm + text cancel;
  placeholder hints instead of floating labels. GroupName/Channel dialogs
  swapped onto it; picker "Add" is now the filled action (web footButtons).
- **onAccentChip** emitted + used by chips/search/QR tabs (value-identical
  to onAccent today; the contract names it).
- **Hover/focus surfaces** — `Modifier.rowSurface` (shared interaction
  source, indication = null): hover = bgHover, keyboard focus = 2dp
  focusRing outline (the token existed but was used ZERO times), chips
  pass hover=false (their hover changes ink).

Verified: node kmp-theme-tokens 4/4, WSL gate green. Deviations noted:
focus ring draws inside bounds (Compose drawBehind can't go outside like
CSS outline-offset 2px); AttachMenu popup rows and picker rows keep plain
clickables (popup/touch surfaces).

## 2026-11-14 (3) — the four "no KMP counterpart" features, part 1: strip + QR card

User: "you skipped Velta exclusive features… but why? lets just make them."
Recon verdict: per-relay strip + QR card are app-layer work (shipped here);
typing previews + P2P local groups BOTH depend on the Velta Loop engine
(velta-app/src-tauri/src/p2p.rs, 7023 lines + groups.rs — Tauri-coupled but
headless-runnable per bin/p2p-hub.rs) — that lift is tracked as its own
slice (issue #330), started after this commit.

**SHIPPED**
- **Per-relay strip states** (web renderRelayLine + parseConnectivityHtml +
  #76 probe + #79 SMTP attribution): `VeltaCore.connectivityHtml` (the HTML
  page is the ONLY live per-transport source — 🐴 ceiling noted on the web
  too), pure `ui/RelayStates.kt` port (worst-dot-wins parse, quota text,
  unpublished skip, SMTP dot outside the list, smtp-via span), `RelaySegDisplay`
  state in AppModel with the probe loop (`probeRelayReachable` expect/actual —
  HTTPS GET 6 s, the web's shell probe_relay semantics; 60 s min gap, ≥10 min
  failing = offline grey, failing-while-green = unreachable amber), and the
  RelayLine UI: one segment per relay with its own state color (ok #2ecc71 /
  connecting+unreachable+delayed #e6a23c / offline #9aa0a6 / down #e05252 /
  local #4c8dff), the send-relay segment running animated data-sending
  dashes while a send is in flight, per-segment titles (incl. quota) as
  contentDescription. Empty parse → the single combined account segment as
  before. RelayStatesTest pins the parse + downgrade vectors against a
  core-shaped fixture; ScriptedRpcTransport gained a
  `get_connectivity_html: ""` default so scripted tests never hang the strip.
- **QR card** (core qr_code_generator.rs card, web mounts it and re-encodes
  the module path): `InviteQrCard` draws the 515×630 card in Compose —
  #f2f2f2 rx40 card w/ #c6c6c6 border, optimally-encoded matrix at
  (57.5,255) scale 400/size, the bold caption ("Scan to chat with {name}"
  — the core stock string, wrapped 32 chars, 27px or 19px), the center
  identity disc (ring #f2f2f2 r56.2 + disc r47.2 in the self contact color
  + white letter 61.36px) and the footer slot (the core inlines a DC
  wordmark image KMP doesn't ship — the Velta mark stands in, height 35).

**MISSING (named)**: #102 "delayed" amber state rides a send-failure event
feed KMP doesn't have yet (the branch is coded in the web port; KMP's
sending-dashes key off the composer's sending flag); caption/footer
branding deviation on the QR card noted above. ~~relay-detail chips row
not ported~~ — SHIPPED 2026-11-14 (see the gesture/header entry below).

**2026-11-14 — review-fix round, gestures, and the chat header (d149c3ce,
6227d862, 44c76aa4, 122a3b87, 48be46fb, ff5cc63b, d164c6d3, 32d21bf8; all
CI-green; phone-verified on the vivo):**

- **Bubble design port** (web = spec, main.css + chat-view.js): width
  min(480dp, 90%), 42dp group avatars + 13.5sp sender names inside the
  bubble, 11.5sp meta with textMetaIn/Out + tick tints, sticker
  transparency, media bleed (`mediaBleed`) + 320/450 caps + radiusMedia +
  dims-reserved placeholders, video/audio/file cards with size/duration
  chips (`MessageObject` fileBytes/duration/dimensions), isInfo mono
  pills, .day-chip restyle, reactions inside the bubble (accent border on
  the own reaction), 4dp gap. MediaMetaParseTest pins the wire fields.
- **Review fixes**: chat-list stamps (ChatListItem.lastUpdated is
  MILLIS — the "+58838" bug; af46d1d4 call-site fix + FormatTimeTest),
  side-view type ladder (search hits = full chat-item rows 15.5/14,
  archived subs 12 per .archived-sub), WCAG sweep (light out-quote text
  was 1.05:1 → #4d5a68 per main.css:912; light service pill 1.56:1 →
  white-80% + #464b55 per :855; brutal out-quote #3d3410 per :3393;
  LocalVeltaThemeMode exposes the resolved mode), doubled 📷 previews
  (core summary.rs embeds the emoji — pass-through, ChatCategoryTest
  pins), menu Refresh item dropped (web has none; reloads are
  event-driven).
- **Relay zone**: meter-only tap target (padding-before-clickable — the
  invisible bands ate category chips' taps), pull-open detail chips
  (masked domains via maskRelayDomain + envelope on the sending relay),
  gestures on the ChatsView container so they survive empty categories.
- **Touch gestures** (web thresholds, `touchGesturesEnabled`
  android-on/desktop-off): category swipe (48px, 1.4× axis ratio, one
  step per gesture), bubble reply swipe (12dp engage / 48dp commit /
  64dp clamp, live offset, haptic), history back swipe (−12dp engage /
  −min(72dp, 28%) commit, live pane follow). Web slide animations
  skipped (noted deviation).
- **Chat header** = velta-chat-head: 42dp avatar, 16px/600 name, status
  line ({n} members / {n} subscribers / your personal space / local
  device messages / bot / last seen {when}) via AppModel.chatHead (sync
  list-item data + async fullChat/contact), info zone + menu dots open
  the Profile for ALL chats. Still missing vs web: typing indicator
  (#332), online flag (no KMP contact field), in-chat search.

## 2026-11-14 (4) — QR view = Tauri look (domain tabs + branded square) + Loop lift M1

User: "Velta Tauri has a better design, pls make Velta KMP screen looks
same good for this fucking Your QR code screen" (screenshot: white square
QR + dark V badge + domain pills + velta.cc/join link). Recon verdict: the
Tauri look is NOT the core's SVG — web invite-domains.js builds the white
square LOCALLY (brandedQrSvg) per invite domain, and only the i.delta.chat
tab mounts the core card.

**SHIPPED**
- **Domain tabs** (`AppModel.INVITE_HOSTS` = web BUILTIN_HOSTS; selection
  persisted under `velta-invite-domain`, default = velta.cc stores by
  REMOVING the key).
- **`rewriteInviteHost`** (invite-domains.js:20-27 port): slices the
  canonical `https://i.delta.chat/#` prefix, re-hosts the payload
  byte-identical — velta.cc → `https://velta.cc/join/?payload` (the
  universal form with fp/v/i/s/a/r/n), mirrors → `https://host/#payload`.
- **`BrandedQrSquare`** (web brandedQrSvg port): white 512² square, 48px
  quiet zone, the optimally-encoded matrix scaled 416/size, the
  VELTA_QR_LOGO badge dead-center (white ring r56, #1c1c1c disc r48, the
  V mark 84×84) — for velta.cc + mirror domains.
- **i.delta.chat tab keeps `InviteQrCard`** (the core's 515×630 card —
  see the 2026-11-14 (3) entry). Link chip + Copy/Share ride the selected
  domain's link.

**FIXED en route** (cost two verify cycles): the first card render used a
MISREAD geometry spec (QR y=255 vs the real translate y=75; disc at 455 vs
the real QR-center 275) — read the generator source, never a summary; and
the module size was computed from `cx(400)`, which includes the letterbox
cardLeft offset — positions leaked into a size, modules ~14% oversize.
Both lessons in AGENTS test conventions.

**Velta Loop lift M1** (branch `kmp/p2p-loop`, 63c77f1e, issue #332):
p2p.rs (7023 lines) + groups.rs compile IN the shim after mechanical
edits (spawn swap, Sink::Events, Tauri glue stripped); the engine's own
70 tests pass in the shim incl. real-engine typing + group delivery.
M2 = p2p JSON-Lines socket bridge; M3 = KMP surfaces (typing previews +
P2P local groups — the two remaining "no KMP counterpart" features).

**MISSING (named)**: extra user invite domains (web drawer registry,
`velta-invite-hosts`) — builtins only; #102 "delayed" strip state (no
send-failure feed); relay-detail chips ported by the parallel session's
gesture round (documented in AGENTS).
