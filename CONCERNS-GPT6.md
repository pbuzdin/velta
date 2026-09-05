# Velta Code Review Concerns

Reviewed: 2026-09-05

## Scope And Assessment

This review covers Velta's client code in `app/` and `delta-web-app/`, including
the current uncommitted changes. It is not an audit of the vendored Delta Chat
core, a penetration test, or a certification of the shipped Android/Windows apps.

The architecture is worth keeping: Delta Chat owns messaging and cryptography,
Tauri provides the native shell, and a small transport/RPC layer supports a shared
web UI. Plain ES modules, virtualized history, and limited frontend dependencies
are appropriate. A framework migration or a new service abstraction is not the
priority. The main concern is cross-component reliability and ownership.

## 1. Account Isolation

**Priority: High. Status: Implementation underway; final verification pending.**

The reviewed code allowed an account switch to leave the previous conversation
actionable. Subsequent sends used the newly selected account with the old numeric
chat ID. Event handling discarded the event's account identity, and pending
requests could write old-account IDs into the new account's message cache.

Numeric chat, contact, and message IDs are account-local. Comparing those IDs
alone does not establish ownership. Comparing account IDs alone also misses a
switch from A to B and back to A while an old request is pending.

Relevant code: `app/js/rpc-core.js` (`switchAccount`, `_pollEvents`,
`_handleCoreEvent`, `getMessages`, multi-step mutations), `app/js/app.js`
(account transitions and navigation), and `app/js/chat-view.js` (view lifetime).

Required behavior:
- Close account-owned views and dialogs synchronously at the transition boundary.
- Pin already-started RPC operations to their original account.
- Reject stale cache writes and UI results using account/view lifetime identity.
- Filter account events before applying them, including after async decoration.
- Keep drafts and reply references associated with their original account/chat.
- Test identical IDs across accounts, A-to-B-to-A races, failed switches, and
  switching while loading, sending, confirming deletion, or picking attachments.

Focused regression suites are being added under `tests/`. Native-device and
real-core integration testing remain necessary even when these tests pass.

## 2. Local P2P Pairing Consent

**Priority: High. Status: Resolved (2026-09-05) — engine and UI consent flow implemented; on-device verification still recommended.**

The reviewed code broadcast the current pairing token in every LAN beacon and
auto-persisted any unknown peer that presented it, so a reachable LAN
participant could pair without recipient approval.

Implemented in `delta-web-app/src-tauri/src/p2p.rs` and `app/js/p2p.js`:

- Beacons no longer carry the pairing token — discovery lists names and
  addresses only. A LAN listener learns nothing pairable.
- The invite-ticket token remains the out-of-band QR proof: a hello presenting
  the current token (the joiner scanned our QR) is accepted automatically.
- A Nearby tap now sends an empty-token request. The engine queues a pending
  request, emits a `pair-request` event, and only completes the handshake after
  the receiving user approves (UI modal, `p2p_approve_pair`, 120 s window).
  Denial or timeout fails the pairing without persisting the peer.
- A wrong (stale/forged) token is still rejected outright, without prompting.

Regression coverage: `nearby_pairing_requires_approval` (request → deny → no
peer; request → approve → paired + chat round-trip), plus the existing QR and
queue tests. A two-device on-network check (request, deny, approve, stale
token) is still worthwhile on real hardware.

## 3. Event Polling And RPC Timeouts

**Priority: High. Status: Resolved (2026-09-05) — long-poll with late-response salvage implemented; live-backend verification still recommended.**

`JsonRpcCore._pollEvents` used the ordinary 30-second RPC timeout for
`get_next_event`, although the backend (`core/deltachat-jsonrpc/src/api.rs`)
parks the request on the event channel until an event exists and hands each
event to exactly one waiter. Expiring the frontend request did not cancel the
backend waiter; its eventual response arrived for a pending entry the frontend
had already deleted, silently dropping the event (lost UI notifications after
idle periods).

Implemented in `app/js/rpc-core.js`:

- Event polling uses a dedicated `_callEventPoll` with a 240 s backstop
  instead of the 30 s default — the backstop bounds a parked request's
  lifetime below transport/proxy stall limits without making healthy long
  polls time out.
- On backstop expiry the entry is kept registered with an `onLate` hook; the
  poll loop re-issues, and when the late response eventually arrives it is
  dispatched through the same account-attribution filtering as live events
  (`_dispatchPollResult` → `_handleCoreEvent`), never dropped. `reconnect()`
  clears salvaged entries with the dead transport.
- Salvaged responses still respect `contextId` attribution and the account
  epoch, so an idle-period event can no longer be lost and cannot cross an
  account boundary either.

Regression coverage: `tests/rpc-event-poll.test.mjs` (late-response salvage,
re-poll after backstop, foreign-account/epoch filtering of salvaged events,
reconnect recovery); the polling tests in `tests/rpc-account-isolation.test.mjs`
continue to pass. A live-backend check — quiet account idle past the old 30 s
timeout, then an incoming message — remains worthwhile on a real device.

## 4. Media Ranges And Memory Use

**Priority: High. Status: Open; range error confirmed in source.**

The loopback media handler in `delta-web-app/src-tauri/src/lib.rs` reads the whole
file and truncates the buffer to the requested range length without advancing to
the requested starting offset. A request for bytes 100-199 therefore receives
bytes 0-99 labelled as 100-199. This undermines seeking and video metadata reads.

`app/js/poster.js` also checks its 128 MiB limit after `read_media_bytes` has
already read and transferred the entire file. The check does not prevent the
large native/IPC allocation. An actual out-of-memory failure was not tested.

Serve the correct byte interval with bounded reads. Enforce poster limits before
allocation/IPC. Test nonzero offsets, suffix ranges, invalid ranges, and oversized
files. Preserve the existing serialized poster jobs and graceful fallback.

## 5. Android Background Delivery And Release Continuity

**Priority: High before everyday use or public releases. Status: Open.**

The Tauri Android app runs the core in its own process. The inspected manifest and
activity do not provide an integrated background service/notification path; the
separate `delta-core-service` APK is not wired into that lifecycle. Reliable
delivery under Doze or process reclamation should not be assumed. Device effects
were not tested.

Relevant code: `delta-web-app/src-tauri/src/lib.rs`, the generated Android
`AndroidManifest.xml` and `MainActivity.kt`, and `delta-core-service/`.

Separately, `.github/workflows/build-android.yml` generates a fresh signing key
on each run and publishes the resulting APK on release tags. Those APKs cannot
normally update one another in place. Uninstalling as a workaround risks deleting
local accounts and messages. Use a persistent, securely managed release key and
verify an upgrade between two builds without uninstalling.

## Additional Findings

- **Draft recovery on send failure:** `ChatView._send` clears text and the reply
  before awaiting a send. A rejected send can lose the user's recovery path.
  Account-separated drafts do not by themselves solve failed-send recovery.
- **Modal dismissal:** `ui.js` previously removed popup DOM without consistently
  invoking close callbacks, leaving confirmation promises pending. This is being
  addressed as part of the account-isolation work because switching must cancel
  account-owned confirmations.
- **Frontend privileges:** Tauri filesystem and asset scopes include broad
  app-local storage. Narrow them to required files/directories where practical.
  This increases the impact of compromised frontend code; no injection exploit
  or unrestricted whole-disk access was established.
- **Vendor internals:** `components.js` accesses Elena implementation details
  for remount recovery. Keep the dependency pinned and test remount/playback
  behavior before upgrading it; do not replace the rendering stack just for this.
- **Test coverage:** deterministic mocks help UI development but do not establish
  real-core contract parity. Existing packaging workflows are not client
  regression tests. Commit focused tests for the boundaries above and retain
  Android/Windows smoke tests with a real core.

## Recommended Order

1. Complete and verify account isolation.
2. Settle P2P authorization, repair long polling, and fix media ranges/limits.
3. Establish Android background delivery, notifications, and upgrade-safe signing.
4. Protect those behaviors with small regression tests before expanding features.

The earlier over-engineering review identified smaller cleanup opportunities,
but reducing wrappers or line count should not displace these reliability and
security tasks. Keep validation, synchronization, error handling, and compatibility
where they protect real behavior.
