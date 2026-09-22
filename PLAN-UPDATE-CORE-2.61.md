# Plan: Core 2.60.0 → 2.61.0 (+ Android service drift fix)

Velta is on vendored core **v2.60.0** (1.3.24). Upstream released **v2.61.0**
(2026-09-21). This plan migrates every core consumer to v2.61.0, migrates the
frontend off the APIs 2.61.0 removes, wires one previously unused core feature
(fulltext message search), and fixes a pre-existing drift: the
`velta-core-service` lock resolves the git dependency to **2.58.0-dev**
(`rev 137ac9a0`) — the Android service has been running two core versions
behind the app.

Test procedure (Phase 0–5, event-storm regression, acceptance criteria) is and
stays `COREUPDATE.md`; this file is the *change* plan. Build constraint from
COREUPDATE/AGENTS still applies: **core cargo commands run in WSL**; gate on
`cargo nextest run --workspace --locked` (plain `cargo test` flakes ~4
time-shift tests per run).

## Upstream changes that touch Velta (full changelog: core/CHANGELOG.md 2.61.0)

Breaking:
1. Contact verification tracking removed: JSON-RPC Contact object loses
   `isVerified`/`verifierId`; stock string 35 (`DC_STR_CONTACT_VERIFIED`)
   removed. SecureJoin itself is unchanged — only the persistent badge.
2. `Account` object loses the `addr` field (`Account::Configured` is now
   `id, displayName, profileImage, color, privateTag`). `list_transports()`
   is the documented replacement.
3. Contact object: `was_seen_recently` replaced by `freshness`
   (`"Normal" | "RecentlySeen" | "Old"`); `lastSeen` stays.
4. `is_chatmail` config key + XCHATMAIL capability removed (Velta never reads
   them), `protect_autocrypt` setting removed (unused), XDELTAPUSH removed.

New / changed behavior Velta benefits from:
- `init_transports()` — core-native multi-relay onboarding.
- `is_sending_finished()` — real send-state query.
- Background fetch from all transports; `AccountsBackgroundFetchDone` always
  emitted; background_fetch no longer waits on/triggers SMTP.
- No I/O restart when setting `configured_addr`; no sync message on that
  change; no configure-progress events during background relay additions.
- Correct `From` address for MDNs; correct Bcc-self for unencrypted mail.
- Better image recoding quality (#8682); configure tries fastest relays first;
  messages queued for SMTP before encryption.
- A single NDN, or a read receipt that already arrived, no longer marks a
  message failed (fewer false "failed" ticks in relay-hopping setups).
- rustls 0.23.45.

## Phase A — Swap vendored core to v2.61.0

1. `core/` is pristine upstream (git history: only whole-tree release swaps).
   Delete `core/`, extract
   `https://github.com/chatmail/core/archive/refs/tags/v2.61.0.tar.gz` in its
   place. Rollback = `git checkout -- core/`.
2. Confirm `core/Cargo.toml` `version = "2.61.0"`.
3. WSL: `cargo nextest run --workspace --locked` (the gate; run at Phase F).

## Phase B — Fix velta-core-service drift (same pass, pre-existing)

`velta-core-service/rust/Cargo.toml` uses
`deltachat-jsonrpc = { git = "https://github.com/chatmail/core" }` and the
lock sits on a 2.58.0-dev rev.

1. Pin the dependency to the release tag: `tag = "v2.61.0"`.
2. Refresh the lock (`cargo update -p deltachat-jsonrpc` or equivalent) so the
   service and the app run the same core version.
3. Grep the service crate for removed APIs (`is_verified`, `addr` on account,
   `was_seen_recently`) — 2026-09-22 audit found none; re-check after pin.

## Phase C — Frontend migrations (app/)

| # | File(s) | Change |
|---|---|---|
| C1 | `app/js/rpc-core.js` `_mapContact` | `online: c.freshness === "RecentlySeen"` (was `wasSeenRecently`); drop the `verified` field |
| C2 | `app/js/rpc-core.js` `getAccount`/`getAllAccounts` | `addr` no longer on the Account object — source it via `get_config("configured_addr")` (the sending address Velta's relay UI already keys on). One extra RPC per account; acceptable at Velta account counts |
| C3 | `app/js/components.js` | Remove verified rosette (`chatVerified`, `VERIFIED_SVG`) and its render site — core no longer tracks verification |
| C4 | `app/js/app.js` | Remove verified readers: chat-list compare (`prev.verified`), self-profile `verified: true`, profile-sheet "Verified" row, contacts-view `verified:` mapping |
| C5 | `app/js/rpc-core.js` `setSendRelay` | Comment update: 2.61.0 no longer restarts I/O and no longer sends a device-sync message on `configured_addr` changes |
| C6 | `app/js/mock-core.js` | Demo parity: expose `freshness` on mock contacts (`RecentlySeen` when online); keep `addr` (Account objects in mock are Velta-shaped and unaffected) |
| C7 | `docs/agents/relays.md` | Note: `configured_addr` change no longer syncs to other devices via a sync message; multi-device relay-status propagation relies on `TransportsModified` from actual transport changes |
| C8 | `CORE-CAPABILITIES.MD` | Append 2.61.0 section (rating per feature) |

Not affected, verified by grep: stock-string registration (none),
`is_chatmail`/`protect_autocrypt` reads (none), `nameAndAddr` usage (none),
`velta-core-service` frontend-facing RPC surface (no removed methods called).

## Phase D — Wire fulltext message search (feature, uses existing core API)

Core has had `search_messages(account_id, query, chat_id?) → Vec<msgId>`
(SQLite FTS over message text; works for every chat type **including group
chats**; chat-scoped search unlimited, global capped at 1000) — Velta never
wired it. Today Velta only filters chat *names* (side view) and already-loaded
messages in the open chat.

1. `rpc-core.js`: `searchMessages(query, chatId = null)` → `_call("search_messages", accountId, query, chatId)`.
2. `mock-core.js`: counterpart — case-insensitive substring filter over demo
   message texts (KEEP rule: every rpc-core method needs a mock twin).
3. UI (minimal, reuses the existing "Search in chat" modal): when the modal
   opens on a real core chat, query the core instead of filtering loaded rows;
   render result rows (sender + snippet + time); tapping a result closes the
   modal and jumps to that message (existing `openChat` + scroll-to-message
   path). Mock mode uses the mock twin.
4. 🐴 Ceiling: result snippets come from the stored message text (no
   highlight-of-match ranges from core); jump-to-message reuses the existing
   scroll path, which needs the row loaded — acceptable for now, upgrade path
   is `get_message_html`-backed preview or loading the target page first.

## Phase E — Version / docs bump (release 1.3.25)

1. `velta-app/src-tauri/tauri.conf.json` version → 1.3.25; Tauri `Cargo.toml`
   + lock; UI fallback version string; SW cache constant (v162) — same set as
   the 1.3.24 bump.
2. `AGENTS.md` / `README.md` core version statements 2.60.0 → 2.61.0
   (incl. §4.3.1 sidecar note "v2.61.0 since …").
3. Sidecar + prebuilt rebuilds (manual, after this plan): Windows sidecar per
   §4.3.1 (Strawberry Perl/NASM or WSL), `deltachat-backend/` prebuilts, and
   the `velta-core-service` JNI `.so` — all must report 2.61.0
   (`get_system_info` check).

## Phase F — Verification

1. Frontend suites (healthy set): `rpc-event-poll`, `rpc-account-isolation`,
   `call-state-machine`, `local-chat-transfer-progress`; the DOM-stub-broken
   suites (`app-account-isolation`, `chat-account-isolation`,
   `chat-msg-update-hardening`) are known-broken, pre-existing.
2. Demo smoke: serve `app/` (mock mode), verify account rows keep
   name/relay, contacts render, no console errors from removed fields.
3. Core gate: WSL `cargo nextest run --workspace --locked` in `core/`.
4. COREUPDATE.md Phase 2–4 (live relay, two accounts, event storm) before
   release, per that document.

## Acceptance criteria

- All core consumers report 2.61.0 (app lock, service lock, sidecar, prebuilts).
- No frontend code reads `isVerified`, `wasSeenRecently`, or `Account.addr`.
- Verified rosette fully removed; presence works via `freshness`.
- Relay UI unchanged behaviorally (status line, send-via, remove).
- "Search in chat" hits core FTS on real chats (group chats included) and the
  mock twin in demo mode.
- `cargo nextest run --workspace --locked` green in WSL.
