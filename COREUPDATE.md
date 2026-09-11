# Core Upgrade Test Plan

How to upgrade the vendored Delta Chat core (`core/`) — or swap a prebuilt
`deltachat-rpc-server` binary — without breaking Velta. This plan exists
because the frontend and the core are coupled through a wide, mostly
undocumented JSON-RPC/event surface, and because core behavior changes
(e.g. event emission rates, IMAP idle loops) surface as *frontend* symptoms:
re-render storms, log spam, and battery drain rather than clean errors.

Last updated for core `2.59.0` (see `core/Cargo.toml` `version` and the
statement in `README.md`).

## 1. Where the core is consumed

Every consumer must be rebuilt or swapped when the core changes:

| Consumer | Core form | Where it comes from |
|---|---|---|
| Windows desktop (Tauri) | sidecar process | `delta-web-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe` |
| Android (Tauri) | in-process Rust library | `core` workspace built into the APK by the gradle/NDK build |
| `delta-core-service` APK | JNI + WS bridge | separate APK, same core workspace |
| Browser/PWA / test rig | remote sidecar over WS/HTTP | `deltachat-backend/windows-x86_64/` and `deltachat-backend/android-arm64/` prebuilts |

## 2. The frontend contract (what must keep working)

`app/js/rpc-core.js` is the single integration point. An upgrade is only
compatible if all of the following hold:

**RPC methods actually called by the frontend** (grep `_call("` in
`rpc-core.js` for the authoritative list): `get_all_account_ids`,
`get_selected_account_id`, `select_account`, `start_io_for_all_accounts`,
`get_message_ids`, `get_messages`, `get_message`, `get_message_html`,
`send_msg`, `markseen_msgs`, `delete_messages`, `delete_messages_for_all`,
`forward_messages`, `save_msgs`, `send_reaction`, `download_full_message`,
`get_connectivity`, `get_connectivity_html`, `set_config`/
`set_config_from_qr`/`check_qr` (account + relay flows), `provide_backup`/
`get_backup_qr` + imex family, vCard family, chatlist methods. Payloads use
the JSON-RPC positional style; message loads expect the
`MessageLoadResult { kind: "message" }` tag.

**Event kinds the frontend maps** (`_handleCoreEvent`): `IncomingMsg`,
`IncomingMsgBunch` (no ids — frontend treats as "any chat"), `MsgsChanged`,
`MsgDelivered`, `MsgRead`, `MsgReadCountChanged`, `MsgFailed`,
`ChatlistChanged`, `ChatlistItemChanged`, `ChatModified`, `MsgsNoticed`,
`ConnectivityChanged`, `ConfigureProgress`, `ImexProgress`, and the
Info/Warning/Error family. Events arrive as `get_next_event` long-poll
responses shaped `{ contextId, event: { kind, chatId, msgId, ... } }`.

**Wire-format pitfalls:** the core serializes camelCase (`chatId`, `msgId`);
some transports deliver snake_case — `rpc-core.js` accepts both, but a new
renamed field silently breaks a feature with no error. `MessageState` and
viewtype enums are mapped in `_mapState`/`_mapViewtype`; new states arriving
for known messages will render as the fallback branch.

**Delivery contract:** every event must reach the frontend exactly once, and
`get_next_event` semantics (park until an event exists; each event handed to
exactly one waiter; response survives a client-side timeout) are load-bearing
— `tests/rpc-event-poll.test.mjs` pins the frontend side.

## 3. Phase 0 — Pre-flight

- [ ] Record the current core ref: `git -C core log -1`, `core/Cargo.toml`
      `version`, and the upstream version you are merging/upgrading to.
- [ ] Clean working tree; note the app version you will release with.
- [ ] Baseline on the OLD core, so failures later are attributable:
      `cd core && cargo test --all` and `node --test tests/` (both must pass
      before you start; don't chase pre-existing failures mid-upgrade).

## 4. Phase 1 — Offline gates (no network, no accounts)

```bash
cd core && cargo test --all          # core unit/integration tests
cd core && scripts/clippy.sh && scripts/deny.sh   # CI quality gates
node --test tests/                   # frontend contract suites (repo root)
```

- [ ] `cargo test --all` green (skip `--ignored` slow tests unless the
      upgrade touches their area).
- [ ] Frontend suites green: `rpc-event-poll.test.mjs` (event long-poll
      contract: exactly-once dispatch, late-response salvage, account
      attribution), `rpc-account-isolation.test.mjs`,
      `chat-account-isolation.test.mjs`,
      `chat-msg-update-hardening.test.mjs` (duplicate-update short-circuit,
      tail-refetch coalescing), `app-account-isolation.test.mjs`.
- [ ] Frontend compiles clean against the new core's shapes: run
      `cd delta-web-app && cargo tauri dev` and boot past the splash.

## 5. Phase 2 — Single-account live check (desktop, real relay)

Use the AGENTS.md §7.2 setup: `tools/serve-dev.py` for the no-store static
frontend, a fresh sidecar binary, one throwaway chatmail account
(`dcaccount:` QR). Keep `velta.log`
(`%LOCALAPPDATA%\Velta\logs\velta.log`) open in a tail.

- [ ] Boot: transport switches mock → real; no "Event polling failed" lines
      (long-poll parks silently for minutes when idle).
- [ ] Receive: incoming message appears once (one pair of `onIncoming` log
      lines per message is normal for the polled event + bunch; two pairs is
      a duplication regression — see §7).
- [ ] Send: state walks pending → sent → delivered → read via `msg-state`
      events; ticks update in place.
- [ ] Read receipts: `markseen_msgs` produces no visible churn; the chat list
      unread counter clears.
- [ ] Connectivity bar: settles green; `get_connectivity_html` parses (per-
      relay segments + quota render in the drawer's detail bar).
- [ ] Idle 10+ minutes with the app open: log stays quiet (no repeating
      lines every few seconds).

## 6. Phase 3 — Functional pass (two accounts)

Two throwaway accounts SecureJoined to each other, one side driven by raw
RPC (`deltachat-rpc-client` or the test rig bridge), the other by the UI.

- [ ] Text, reply/quote, forward, reactions, edit if supported.
- [ ] Media both directions: image (aspect-box reveal), video (poster → tap
      to load → seeking works — Range correctness regressed once, §CONCERNS
      #4), voice/audio, file download flow, oversized download ("Tap to
      download" path).
- [ ] Delete for me / delete for everyone propagates and removes the row.
- [ ] Group: create, invite via QR (SecureJoin), member list, outgoing to N.
- [ ] Second-device backup transfer (`DCBACKUP2`), vCard share/import.
- [ ] Account switch A→B→A while a send is in flight (isolation contract).
- [ ] Muted/archived/pinned chat list behaviors; drafts survive switches.

## 7. Phase 4 — Event-storm regression (the reason this plan exists)

A core upgrade can change how often events fire; the frontend is now
hardened (coalesced relay refresh, throttled tail refetch, duplicate-update
short-circuit — see AGENTS.md §11) but the failure mode is subtle and worth
re-checking on every upgrade:

- [ ] **Ignored-mail loop:** leave the account idle at the inbox for ~10 min
      with `velta.log` tailed. A repeating pattern of
      `chat-view onIncoming chatId=N current=N` pairs every ~2 s with the
      polls reporting `found 0 new` means the core is re-fetching an ignored
      mail each idle cycle (observed with `receive_imf.rs: Fetched
      unencrypted message, ignoring` — the mail was never marked seen on the
      server). Check the core diff for changes in `receive_imf.rs` /
      `imap.rs` seen-flag handling before blaming the frontend.
- [ ] **Console hygiene:** with DevTools open, no repeating
      `[virtual-scroller] The item is no longer rendered onscreen
      (onItemHeightDidChange)` warnings during idle or scrolling.
- [ ] **Event dedup:** a known event produces exactly one UI reaction —
      duplicate `onIncoming` pairs 1-5 ms apart indicate either double
      dispatch (frontend regression — `tests/rpc-event-poll.test.mjs`
      catches it) or the core emitting the same event twice (core regression).
- [ ] **DOM budget:** leave the app open ~15 min; the once-per-10-min DOM
      watchdog (`DOM budget: +N nodes…` in the Velta Diagnostics chat / log)
      must not fire.
- [ ] **Relay feedback:** during a send, the connectivity bar animates and
      settles; `relay: sending via …` diagnostics appear in short bursts, not
      continuously.

## 8. Phase 5 — Device checks

- [ ] Android APK with the in-process core: boot, receive while foreground,
      notification shows sender + snippet, tap-through works.
- [ ] `delta-core-service` APK still pairs and bridges (secondary, but same
      core workspace).
- [ ] Deep links (`velta://`, `dcaccount:`, `dclogin:`, `dcbackup:`) still
      route.
- [ ] Local chat (P2P) still works with the upgraded core in the same APK
      (it shares the tokio runtime and account dir).

## 9. Acceptance criteria & rollback

Ship the upgrade only when: all Phase 1 gates pass, Phase 2-4 have no open
finding that changes user-visible behavior, and `velta.log` over a 30-minute
idle+active session shows no repeating-line storms.

Rollback: the prebuilts are per-release artifacts — keep the previous
`deltachat-backend/*/deltachat-rpc-server*` and
`delta-web-app/src-tauri/binaries/` binaries (or the previous release tag)
and re-swap; the frontend has no schema migration state (accounts live in the
core's account dir — downgrade across a core that migrated the database is
NOT safe; test db-open-on-old-core before shipping a risky upgrade).

## 10. Build recipes

```bash
# Core RPC server (Windows sidecar / test rig)
cd core && cargo build -p deltachat-rpc-server --release
# → copy target/release/deltachat-rpc-server.exe into
#   delta-web-app/src-tauri/binaries/ (renamed with the target triple) and
#   deltachat-backend/windows-x86_64/

# Android cross-compile for the prebuilt dir: see tools/ and
# deltachat-backend/android-arm64/ provenance notes in git history.
```
