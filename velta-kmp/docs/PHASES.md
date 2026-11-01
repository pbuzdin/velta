# Phase status & gap ledger

Tracking issue #192. Updated 2026-11-01 after P2. Every phase lists what
SHIPPED, how it was VERIFIED, and what is still MISSING — no "done" without
the gaps next to it.

| Phase | State | Commit | CI |
|---|---|---|---|
| P0 Scaffold | ✅ done | `3e78085b` | green |
| P1a Core bridge (desktop) | ✅ done | `2ee90088` | green |
| P1b Android in-process core | ✅ done | `2cd1c8f2` | green |
| P2 Persistence + read paths | ✅ done | `cbb3809b` | green |
| P3 Write paths | 🚧 first slice done | this commit | — |
| P4 Velta layer | ⬜ | — | — |
| P5 Release track | ⬜ | — | — |

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
reply), reaction summary chips under bubbles, immediate reload after send.

**Verified:** scripted send-flow tests (plain + quoted + reaction params +
reload-after-send ordering), real-binary device-message round-trip IT
(the no-network write-path e2e), wire-casing regression test, full WSL
gate, CI.

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
- **The P3 exit gate itself**: a real message sent from the KMP client
  arriving in another client (needs a throwaway-account login on desktop or
  Android).
- Attachments (file picker is platform work; needs the blobdir copy dance).
- No optimistic fake rows — deliberate: after `misc_send_draft` returns the
  message is already in the db, so the immediate reload shows the real
  OutPending bubble with ⏳ (no fakery to reconcile later).
- Recipient/draft edge cases: quote restore after reopen (draft's
  quotedMessageId is not re-fetched), draft for non-open chats.

## P4 — Velta layer ⬜

Planned: relay management cards, invite/join flow, UnifiedPush + foreground
service, at-rest lock port, brand/theming, account switcher, media rendering
if not pulled earlier.

## P5 — Release track ⬜

Planned: signing, release builds with size work, distribution, crash
reporting, CI artifact wiring for sidecar + shims, switchover decision for
`org.velta`.
