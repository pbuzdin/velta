# Core Upgrade Test Plan

How to upgrade the vendored Delta Chat core (`core/`) — or swap a prebuilt
`deltachat-rpc-server` binary — without breaking Velta. This plan exists
because the frontend and the core are coupled through a wide, mostly
undocumented JSON-RPC/event surface, and because core behavior changes
(e.g. event emission rates, IMAP idle loops) surface as *frontend* symptoms:
re-render storms, log spam, and battery drain rather than clean errors.

Last updated for core `2.62.0` (see `core/Cargo.toml` `version` and the
statement in `README.md`; feature-by-feature notes per release live in
`CORE-CAPABILITIES.MD`).

## 1. Where the core is consumed

Every consumer must be rebuilt or swapped when the core changes:

| Consumer | Core form | Where it comes from |
|---|---|---|
| Windows desktop (Tauri) | sidecar process | `velta-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe` |
| Android (Tauri) | in-process Rust library | `core` workspace built into the APK by the gradle/NDK build |
| `velta-core-service` APK | JNI + WS bridge | separate APK, same core workspace |
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
`set_config_from_qr`/`check_qr` (account + relay flows), `list_transports`/
`add_transport_from_qr`/`delete_transport` (multi-relay; since core 2.60.0
removal is immediate via `delete_transport` — `set_transport_unpublished`
no longer exists), `provide_backup`/
`get_backup_qr` + imex family, vCard family, chatlist methods,
`search_messages` (chat fulltext search),
`set_pinned_message_state`/`get_pinned_messages` (pinned messages),
`get_chat_contacts` (single-chat contact for out-of-list chats).
Payloads use
the JSON-RPC positional style; message loads expect the
`MessageLoadResult { kind: "message" }` tag.

**Event kinds the frontend maps** (`_handleCoreEvent`): `IncomingMsg`,
`IncomingMsgBunch` (no ids — frontend treats as "any chat"), `MsgsChanged`,
`MsgDelivered`, `MsgRead`, `MsgReadCountChanged`, `MsgFailed`,
`ChatlistChanged`, `ChatlistItemChanged`, `ChatModified`, `MsgsNoticed`,
`TransportsModified` (relays changed — mapped to `transports-modified`;
2.60.0+ emits it on the modifying device too, so it drives the reactive
relay status line and any open Relays modal), `MessagePinned` /
`MessageUnpinned` (mapped to `pinned-changed`; drives the chat-view pinned
strip), `ConnectivityChanged`,
`ConfigureProgress`, `ImexProgress`, and the
Info/Warning/Error family. Events arrive as `get_next_event` long-poll
responses shaped `{ contextId, event: { kind, chatId, msgId, ... } }`.

**Wire-format pitfalls:** the core serializes camelCase (`chatId`, `msgId`);
some transports deliver snake_case — `rpc-core.js` accepts both, but a new
renamed field silently breaks a feature with no error. `MessageState` and
viewtype enums are mapped in `_mapState`/`_mapViewtype`; new states arriving
for known messages will render as the fallback branch. Real 2.61.0 victims
of exactly this class: `BasicChat` lost `dmChatContact` (single-chat
contacts now come from `get_chat_contacts` — losing this silently emptied
the chat-head presence subtitle), the `Account` object lost `addr`, and
`Contact.was_seen_recently` became the `freshness` enum.

**Delivery contract:** every event must reach the frontend exactly once, and
`get_next_event` semantics (park until an event exists; each event handed to
exactly one waiter; response survives a client-side timeout) are load-bearing
— `tests/rpc-event-poll.test.mjs` pins the frontend side.

## 3. Phase 0 — Pre-flight

- [ ] Record the current core ref: `git -C core log -1`, `core/Cargo.toml`
      `version`, and the upstream version you are merging/upgrading to.
- [ ] Update the hardcoded core version in `app/js/ui.js` (`CORE_VERSION`,
      drawer footer + about modal) and `README.md`'s core-version mentions —
      the drawer footer also self-corrects at runtime via `get_system_info`.
- [ ] Clean working tree; note the app version you will release with.
- [ ] Baseline on the OLD core, so failures later are attributable:
      core tests under nextest in WSL (§4) and `node --test tests/` (both
      must pass before you start; don't chase pre-existing failures
      mid-upgrade).

## 4. Phase 1 — Offline gates (no network, no accounts)

```bash
wsl -e bash -lc "cd /mnt/c/Users/pave/Velta/velta/core && \
  cargo nextest run --workspace --locked"   # core tests, process-per-test
cd core && scripts/clippy.sh && scripts/deny.sh   # CI quality gates
node --test tests/                   # frontend contract suites (repo root)
```

`deny.sh` needs `cargo-deny`, which is not installed in the WSL distro
(as of the 2.62.0 upgrade). Either install it once
(`cargo install cargo-deny --locked` in WSL) or skip it with a stated
justification — "zero dependency changes in `git diff core/Cargo.lock`"
is a valid one, since licenses/advisories can only change through deps.

Native Windows `cargo` cannot build the core: `openssl-sys` (SQLCipher
bundled) needs a perl with `Locale::Maketext::Simple`, which the MSYS perl
lacks — always run core `cargo` commands in WSL.

Plain `cargo test` is **not** a reliable gate: 2.60.0's suite has known
cross-test pollution via the process-global `SystemTime::shift()` test
helper (the tests print this warning themselves) — a varying set of ~4
time-dependent tests (`test_maybe_warn_on_outdated`, blob dedup, calls,
pinned-messages, …) fails per run, and every one of them passes in process
isolation. This is why upstream CI gates on `cargo nextest run --workspace`
(process-per-test). If nextest is not installed, re-run failed tests each
in its own `cargo test -p deltachat --lib <name>` process and require those
to pass.

- [ ] Core tests green under nextest / process-isolated reruns (skip
      `--ignored` slow tests unless the
      upgrade touches their area).
- [ ] Frontend suites green: `rpc-event-poll.test.mjs` (event long-poll
      contract: exactly-once dispatch, late-response salvage, account
      attribution), `rpc-account-isolation.test.mjs`,
      `chat-account-isolation.test.mjs`,
      `chat-msg-update-hardening.test.mjs` (duplicate-update short-circuit,
      tail-refetch coalescing), `app-account-isolation.test.mjs`.
- [ ] Frontend compiles clean against the new core's shapes: run
      `cd velta-app && cargo tauri dev` and boot past the splash.

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
      to load → seeking works — a past regression had the sidecar mis-serve
      HTTP Range requests, which killed seeking; verify seeking in the
      DevTools network panel shows 206 responses), voice/audio, file
      download flow, oversized download ("Tap to download" path).
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
- [ ] `velta-core-service` APK still pairs and bridges (secondary, but same
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
`velta-app/src-tauri/binaries/` binaries (or the previous release tag)
and re-swap; the frontend has no schema migration state (accounts live in the
core's account dir — downgrade across a core that migrated the database is
NOT safe; test db-open-on-old-core before shipping a risky upgrade).

## 10. Build recipes

```bash
# Core RPC server (Windows sidecar / test rig) — native Windows build,
# needs tools/strawberry-perl + tools/nasm first on PATH (AGENTS.md §4.3.1);
# the recipe below writes to a separate target dir so it never fights the
# WSL test runs over core/target:
cd core && CARGO_TARGET_DIR=target-win cargo build -p deltachat-rpc-server --release
# → copy target-win/release/deltachat-rpc-server.exe into
#   velta-app/src-tauri/binaries/ (renamed with the target triple, and as
#   plain deltachat-rpc-server.exe) and deltachat-backend/windows-x86_64/

# Android (aarch64) prebuilt for deltachat-backend/android-arm64/ (Android
# PWA test rig only — the shipped APK builds the vendored core itself via
# gradle/NDK, and CI's build-android.yml handles releases):
# must be built in WSL with a Linux NDK. Windows-native cross-compile fails
# in openssl-sys (perl Configure exits 255) even with strawberry-perl on
# PATH and cargo-ndk driving the NDK wrappers (verified on the 2.62.0
# upgrade, 2026-09-26). Until rebuilt, that binary stays on its old core —
# acceptable: its consumer is the test rig, and core RPC changes so far
# have been additive for what the frontend calls.
```
