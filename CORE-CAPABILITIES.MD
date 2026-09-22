# CORE-CAPABILITIES.MD

What the newest Delta Chat core release gives Velta, how much each item is
worth to us, and what (if anything) we have to change to use it. Companion to
`COREUPDATE.md` — that document is *how* to ship a core upgrade through the
test gates; this document is *what the upgrade buys* and *what it breaks*.

Snapshot: **2026-09-14**, written against vendored core **2.59.0**
(2026-08-14) with upstream **2.60.0** (2026-09-11, tag `v2.60.0` in
[chatmail/core](https://github.com/chatmail/core), commit `a2d8ced1`) as the
review target. **Shipped in release 1.3.24**: Velta now vendors 2.60.0 and
the migration in §1 has been applied.

**Verdict: yes, we can and should update.** One breaking change touches Velta
code (the relay-removal API), two wording blocks go stale, everything else is
additive or automatic. See §1 for the migration, §2 for the feature ratings,
§3 for capabilities already vendored in 2.58/2.59 that Velta does not use yet,
and §4 for optimizations.

Rating legend — **Velta value**: how much the item matters for Velta's
product direction (multi-relay, PWA, lean frontend). **Effort**: work needed
in Velta to benefit. ★★★★☆ = 4 of 5.

---

## 1. Update 2.59.0 → 2.60.0: what breaks, what to change

### 1.1 Breaking: relay removal is now immediate (`delete_transport`)

2.60.0 removes `set_transport_unpublished()` and the soft "unpublish +
listen for ~90 days" model. The new rules:

- Removing a relay means calling `delete_transport()`; the core stops using
  it **immediately**.
- `delete_transport()` no longer refuses to remove the *sending* transport —
  it refuses only to remove the **last** one, and re-elects a sending
  transport when needed. Velta's "Use for sending" guard
  (`primary ? "" : …` in the relays modal, `app.js` `openRelaysModal`) can
  stay — showing *Use for sending* on the sending relay is now redundant but
  harmless — but the Remove button no longer needs to hide on the sending
  relay.
- `list_transports_ex()` / `TransportListEntry` are gone; Velta already uses
  plain `list_transports` (`rpc-core.js:628`) — **no change needed**.
- `TransportsModified` is now emitted **also on the device that made the
  change**, not only on devices applying the synced change (see §2 item 9).

Velta code that must change:

| File | What | Change |
|---|---|---|
| `app/js/rpc-core.js:651-655` | `setTransportUnpublished()` wrapper | Replace with `deleteTransport(addr)` → `this._call("delete_transport", this.accountId, addr)` |
| `app/js/app.js:1915` | Remove button calls `core.setTransportUnpublished(t.addr, true)` | Call `core.deleteTransport(t.addr)` |
| `app/js/app.js:1908-1921` | Confirm dialog: "keeps listening on it for about 90 days … deleted automatically" | New copy: removal is immediate; contacts learn the new address via keyupdate messages (§2 item 2); the core refuses to remove the last relay |
| `app/js/app.js:1842-1846` | Comment block describing the 90-day unpublish model | Rewrite to the immediate-removal model |
| `app/js/mock-core.js` | Mock transport surface | Mirror `delete_transport` (drop `set_transport_unpublished` if mocked) so the frontend suites exercise the new shape |

The old multi-relay sync warning (`RELAYS_WARNING`, "make sure all your
devices run at least version 2.47.0") has been removed from the relays
modal as outdated — removal now also syncs as an immediate change — older *Velta*
builds calling `set_transport_unpublished` against a 2.60.0 core will get a
method-not-found error on every Remove press, so **frontend and core must
ship together** (no mixed versions within one backend — which matches how
Velta already ships: core is vendored/bundled per release).

Suggested defensive wrapper so a half-updated backend degrades gracefully:

```js
// rpc-core.js — removal path for the 2.60.0 core
async deleteTransport(addr) {
  await this._call("delete_transport", this.accountId, addr);
}
```

### 1.2 Semantic changes with no code change but test impact

- **Primary transport is no longer synchronized between devices** (landed in
  2.58.0, worth re-testing here): each device keeps its own sending relay.
  Velta's account drawer and "sending" segment highlighting are per-device —
  verify the two-account/two-device pass in `COREUPDATE.md` §6 still reads
  correctly.
- **`get_webxdc_blob()` may refuse oversized webxdc icons** — Velta has no
  webxdc app support (only a viewtype name mapping, `rpc-core.js:426`), so
  this is a non-issue today; note it if webxdc support is ever added.
- **Configuration now reliably completes with progress=1000 or progress=0**
  — Velta's onboarding splash watches `ConfigureProgress`; the fix removes a
  real stuck-at-configuring failure mode. Re-run the `dcaccount:` create flow
  (COREUPDATE.md §5) and confirm the splash always resolves.

### 1.3 Free wins that ride along (no action, verify in log)

- rpc-server no longer hangs when requests race a dying rpc-server process —
  directly relevant to Velta's desktop sidecar and the browser WS bridge.
- Legacy SecureJoin key requests are sent as `multipart/mixed` so chatmail
  relays stop rejecting them — fixes real SecureJoin stalls; test the QR
  invite flow (§6 of COREUPDATE.md) with fresh accounts.
- Contact avatar unchanged → `set_profile_image()` no longer emits events
  (event-storm hygiene; Velta's hardening in AGENTS.md §11 stays necessary
  but should see less churn).
- `version_string` from the wire is sanitized (a remote peer can no longer
  feed Velta arbitrary bytes via a version field), and the `h2` dependency
  bump closes RUSTSEC-2026-0258 (unbounded empty HTTP/2 DATA frames,
  low-severity DoS in the core's HTTP stack). Both land via `Cargo.lock`.

---

## 2. Feature ratings — what 2.60.0 gives Velta

Ordered by Velta value. "How to use in Velta" is the concrete integration.

### 2.1 Keyupdate messages: contacts learn about relay changes ★★★★★ (effort: none)

When a relay is removed or the sending relay changes, the core now sends
keyupdate messages so contacts update their state for the changed identity.
This is the replacement for the deleted 90-day unpublish grace period and is
the single biggest reason the immediate-removal model is safe for Velta's
multi-relay users: change your relays and the people you write to converge
on the new address set without a 90-day overlap window.

**Use in Velta:** no code. Update the Remove confirmation copy (§1.1) to say
contacts are informed automatically. Optionally show a one-line info toast
"Contacts will be notified" after a successful removal — it is the honest UX
for what the core now does.

### 2.2 SecureJoin links carry all published relay addresses (#8591) ★★★★★ (effort: none)

`dcaccount:`/invite QRs now include every published relay address, so
someone who scans a Velta user's invite QR sets up against *all* their
relays. For a multi-relay-first client this closes a real gap: previously a
joiner effectively anchored on one address and multi-relay reachability
depended on later gossip.

**Use in Velta:** no code. In the two-account pass (COREUPDATE.md §6),
verify that after SecureJoin both sides can reach each other with one of the
relays disabled — the whole point of the feature. Velta's `invites.js`
mirror-domain registry is unaffected (it operates on link parsing, not on
transport setup).

### 2.3 SecureJoin key requests as `multipart/mixed` ★★★★☆ (effort: none)

Legacy securejoin key requests were `singlepart` and could be **rejected by
chatmail relays**, silently stalling SecureJoin mid-handshake. Now sent as
`multipart/mixed`. For Velta — whose onboarding funnel *is* a QR scan — this
removes a failure we have probably been attributing to flaky relays.

**Use in Velta:** none; add "SecureJoin completes on first scan" to the
Phase 2 checklist expectations.

### 2.4 rpc-server race fix (requests vs dying process) ★★★★☆ (effort: none)

Velta's browser/WS path and the desktop sidecar both kill and restart
`deltachat-rpc-server` (transport failover in `transport.js`, app updates).
Requests that raced a shutdown could **hang** instead of erroring; the
frontend's timeout/salvage logic (tested in `rpc-event-poll.test.mjs`) had to
paper over it. The fix is in the core.

**Use in Velta:** none. Watch for fewer "Event polling failed" /
stale-transport lines in `velta.log` during sidecar restarts.

### 2.5 Configuration progress reliably reaches 1000/0 ★★★★☆ (effort: none)

`add_transport_from_qr` and account creation drive Velta's splash progress
UI off `ConfigureProgress`. The fix removes a hang where configure never
signaled completion.

**Use in Velta:** none; re-test the create-account and add-relay flows so
the splash's "done" path is exercised against the fixed core.

### 2.6 `TransportsModified` also emitted locally ★★★★☆ (effort: small)

Before: a device *changing* transports got no event; Velta compensated by
manually calling `refresh()` / `refreshRelayStatus()` after every relay
operation (`app.js` relays modal). Now the modifying device is notified like
any other, which enables a reactive relay UI:

```js
// rpc-core.js _handleCoreEvent — new case
case "TransportsModified":
  this._emit("transports-modified", { contextId });
  break;
```

```js
// app.js boot — refresh the status bar + any open relays modal on change,
// including changes synced from the user's other devices
core.addEventListener("transports-modified", () => {
  refreshRelayStatus();
  document.querySelector("[data-relays-modal]")?.dispatchEvent(
    new CustomEvent("relays-refresh"));
});
```

Then the manual `refresh()` calls after `setSendRelay`/remove/add become
belt-and-braces instead of the only mechanism, and cross-device relay
changes (previously invisible until the modal was reopened) show up live.

### 2.7 Event hygiene: no `set_profile_image()` events on unchanged avatar ★★★☆☆ (effort: none)

Velta's history with event storms (AGENTS.md §11) makes every reduction in
core event volume a gift: avatar re-sets that change nothing no longer emit
`MsgsChanged`-family events. Automatic; the DOM-budget watchdog
(COREUPDATE.md §7) should confirm it.

### 2.8 `sys.msgsize_max_recommended` raised to the chatmail limit ★★★☆☆ (effort: none)

The core's recommended-size threshold now matches what chatmail relays
actually accept, so Velta users get fewer false "this file is too big"
discouragements for large attachments and the oversized/"tap to download"
path triggers only when it is really needed. Automatic; re-test the
oversized-download row (COREUPDATE.md §6 media checklist).

### 2.9 No device message for IMAP auth errors ★★★☆☆ (effort: none)

Failed IMAP logins no longer spawn device-chat messages (they remain in
events/logs, which is where Velta surfaces them via diagnostics). Less
device-chat noise in the chat list; connectivity bar + `velta.log` carry the
signal.

### 2.10 Autocrypt-Gossip keys imported without address check ★★★☆☆ (effort: none)

Improves key discovery for contacts whose mail passes through relays that
rewrite addresses — marginal for pure-chatmail Velta users, useful at the
edges (self-hosted relays, forwarding setups).

### 2.11 Encryption info uses display names ★★☆☆☆ (effort: none, cosmetic)

`get_contact_encryption_info` (which Velta already calls,
`rpc-core.js:674`) now renders contact display names instead of bare
addresses. Free polish in Velta's encryption sheet.

### 2.12 MDN cleanup: no `Final-Recipient`/`Original-Recipient`, trash unreferenced MDNs early ★★☆☆☆ (effort: none)

Slightly leaner MDNs (less address leakage in read receipts) and early
trashing of MDNs referencing no known message (less IMAP work per session).
Automatic.

### 2.13 `estimate_deletion_cnt` respects `timestamp_rcvd` ★☆☆☆☆ (effort: n/a today)

Corrects the "how many messages would autodelete remove" estimate. Velta
does not expose a deletion-count UI yet; if/when it adds a retention
settings screen, this is already correct underneath.

### 2.14 Items with no Velta impact

JSON-RPC headers generated at build time and Qt bindings (#8330/#8350),
`create_send_msg_jobs` privatized, KML/location cleanup (Velta has no
location sharing), missed-call notification suppression for blocked users
(Velta has no calls UI), export filenames without email addresses (nice
privacy touch, applies to core-internal export), broadcast-channel
refactors, CI/test-infrastructure changes, dependency bumps.

---

## 3. Already vendored (2.58/2.59) — capabilities Velta is not using yet

The vendored `core/` already ships these; they are "new features we got"
that the frontend leaves on the table. Worth a place on the roadmap.

### 3.1 Pinned messages API (2.58) — ★★★★☆ (effort: medium)

The core gained a message-pinning API (distinct from chat pinning, which
Velta maps via `setChatFlags` → visibility `Pinned`). Pinning important
messages to the top of a chat is a natural chat-view feature: long-press →
"Pin", pinned strip above the composer, pinned state synced by the core.

**Use in Velta:** add `pin_message`/`unpin` wrappers in `rpc-core.js` (the
JSON-RPC method family landed with 2.58 — check `core/deltachat-jsonrpc`
for the exact names when integrating), a context-menu entry in
`chat-view.js`, and a pinned-messages strip rendered from the chat's
pinned ids. Defer until after the 2.60.0 upgrade to keep the upgrade diff
clean.

### 3.2 Client version information (2.59) — ★★★☆☆ (effort: small)

Contacts now publish their client/app version (PR #8557). Velta's profile
sheet (the drawer's self-profile and contact `showChatInfo`) could show
"Velta 1.3.x / core 2.60.0" for contacts — useful for the multi-relay
compatibility warnings ("all your devices run at least 2.47.0") and for
support triage.

**Use in Velta:** read the version field from the contact/contactinfo RPC
response and render one line in the profile sheet; also feed Velta's own
version into the core's client-version config so *other* users see ours.

### 3.3 Broadcast channel reactions (2.58) — ★★☆☆☆ (effort: small)

Reactions are allowed in broadcast channels (default-reaction set only) and
pinned state resyncs in channels. Velta maps `OutBroadcast`/`InBroadcast`
to the "channel" chat type already; if channels are part of the product
plan, reactions come almost for free via the existing `sendReaction` path.

### 3.4 Sending to 5 relays (2.58) / ICE servers from all relays (2.58) — ★★☆☆☆ (effort: none)

Outgoing messages fan out to up to 5 relays and WebRTC ICE candidates are
collected from all relays. Both are automatic today (5-relay fan-out is
already benefiting Velta's delivery reliability); the ICE pool matters only
if Velta ever adds calls/P2P WebRTC on top of `p2p.js` local chat.

---

## 4. Optimizations

### 4.1 Enabled by the upgrade (automatic, verify only)

| Optimization | Where | Expected effect in Velta |
|---|---|---|
| Early trashing of unreferenced MDNs | core IMAP loop | Less fetch work per idle cycle — the ignored-mail loop class of storms (COREUPDATE.md §7) gets cheaper |
| No events for unchanged avatars | core event bus | Fewer `MsgsChanged` bursts; DOM budget watchdog stays quiet |
| rpc race fix | sidecar / WS bridge | Fewer hung transports after sidecar restarts |
| h2 RUSTSEC-2026-0258 bump | `Cargo.lock` | Closes a low-severity remote DoS in the HTTP/2 stack |

### 4.2 Velta code changes to make *with* the upgrade

1. **The §1.1 migration** (`delete_transport` + copy) — required, small.
2. **Reactive relay UI via `TransportsModified`** (§2.6) — replaces manual
   `refresh()` choreography; also picks up cross-device relay changes that
   are invisible today. Add a test to the frontend suites mirroring
   `rpc-event-poll.test.mjs` style: event → single coalesced refresh.
3. **Mock core parity** — update `mock-core.js` in the same commit so
   `node --test tests/` exercises the new transport shape; the mock is the
   contract twin that keeps the frontend suites meaningful across upgrades.

### 4.3 Standalone Velta optimizations (no core dependency)

- **`markseen_msgs` slice** (`rpc-core.js:817`) already caps at 50 ids —
  fine as is; do not raise it without measuring, the cap is load-bearing
  for the event-storm budget.
- **`getMessages` pagination (40/page) and tail-refetch coalescing** are
  already tuned (1.3.23 hardening). Leave them alone this cycle: the
  upgrade diff should stay frontend-light so regressions are attributable
  to the core (that is the whole point of COREUPDATE.md §3 baselines).
- **Defer new features** (pinned messages, client-version line) to a
  separate release after the core swap — same reasoning.

---

## 5. Bottom line

- **Update target:** upstream tag `v2.60.0` (commit `a2d8ced1`), one release
  of drift, changelog-reviewed above.
- **Required Velta changes:** `deleteTransport` wrapper + call site,
  removal-dialog copy, 90-day comment rewrite, mock-core parity — a
  frontend-only diff of roughly four files, no schema/state migration, and
  (per COREUPDATE.md §9) account downgrade across 2.60.0 must be tested via
  db-open-on-old-core before shipping since the transports table gains
  bookkeeping (`transports.add_timestamp`).
- **Best wins:** immediate + safe relay removal with contact notification
  (keyupdate), SecureJoin deliverability and multi-relay invite links, the
  rpc hang fix, and config-completion reliability for onboarding.
- **Roadmap picks from already-vendored features:** pinned messages API
  first, contact client-version second.

---

## 5. Update 2.60.0 → 2.61.0 (2026-09-21, shipped in 1.3.25)

Snapshot: 2026-09-22, written against vendored core 2.61.0. Full change plan:
`PLAN-UPDATE-CORE-2.61.md`. Same verdict pattern as §1: one breaking cluster
touches Velta code, the rest is additive or automatic.

### 5.1 Breaking: verification tracking removed

The core no longer tracks contact verification at all: the JSON-RPC Contact
object loses `isVerified`/`verifierId`, stock string 35 is gone. SecureJoin
handshakes still work — only the persistent badge/status does not exist
anymore. Velta migration: verified rosette removed (components.js), profile
"Verified" row removed (app.js), `_mapContact` no longer maps the field.
Rating: Velta value n/a (upstream product decision), effort low, done.

### 5.2 Breaking: `addr` removed from the JSON-RPC Account object

`Account::Configured` is now `id, displayName, profileImage, color,
privateTag`. Upstream's replacement is `list_transports()`; Velta sources the
sending address from `get_config("configured_addr")` instead — the same key
`setSendRelay` writes, one extra RPC per account row. Rating: low effort, done.

### 5.3 Breaking: `was_seen_recently` → `freshness`

Contact object now carries `freshness` (`"Normal" | "RecentlySeen" | "Old"`)
plus the unchanged `lastSeen`. Velta maps `online: freshness === "RecentlySeen"`
in `_mapContact`; a future UI could dim "Old" contacts (not done — no demand).

### 5.4 Worth adopting later (not done in 1.3.25)

- `is_sending_finished()` — real send-state query for the chat view.
- `init_transports()` — core-native multi-relay onboarding; could replace
  parts of the addAccountWithQr flow.
- Background fetch from all transports + always-emitted
  `AccountsBackgroundFetchDone` — already automatic for the Android
  CoreService poller; a future "sync finished, release service" signal.
- Better image recoding, MDN From fix, NDN/read-receipt failed-state fixes,
  fastest-relays-first configure — automatic wins, no code.

### 5.5 Pre-existing drift fixed in the same pass

`velta-core-service/rust` resolved the git dependency to a 2.58.0-dev rev and
its code had latent build breaks (yerpc 0.6 vs 0.7 trait bounds, ambiguous
`StreamExt::next`, JNI `JValue` borrow shape). Now pinned to tag `v2.61.0`
with `yerpc = "0.7"` and compiles clean.
