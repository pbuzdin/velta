# Relays — agent notes

Extracted from AGENTS.md. Everything about the multi-relay UI in app.js.

## Relay status line (`#relay-line`)

Thin strip below the sidebar header; one equal-width segment per configured
relay (up to `MAX_RELAYS = 5` in the core, `configure.rs`), each colored by
that relay's own status — green connected / yellow connecting or retrying /
amber unreachable-for-new-connections (#76) / amber **delayed** (#102: relay
up, SMTP retrying — the combined title reads "Sending delayed — the relay is
retrying", raised by send-pipeline Warning/Error diagnostics via
`isSendFailureDiagnostic`, cleared on `smtp-message-sent` or connectivity
3000+, error toasts throttled to one per 60 s by
`createRelaySendErrorState` in diagnostics.js) / grey **offline** (probe
failing past the 10 min `RELAY_OFFLINE_AFTER_MS` grace — a relay down for
days is a fact, not an active problem; overrides every core state including
stale-green) / red down / blue demo or local-chat mode. Per-relay status
comes from parsing the core's
`get_connectivity_html` (the only per-transport status the core exposes;
ceiling noted in `parseConnectivityHtml`). With one relay the line is the
old single bar; the combined `get_connectivity` view drives the 45 s
NotConnected grace and the line's overall semantics. Animated dashes while a
message is in flight to the relay (driven by rpc-core's `send-activity`).

**The core's dot is a LAST-SESSION-STATE, not live reachability** (#76): an
established IMAP session keeps a relay green while the relay refuses new
connections — seen live with a relay dead for new TLS reported "Connected"
for hours. `refreshRelayStatusInner` therefore schedules a shell-side probe
per relay domain (`probe_relay`, lib.rs — a real TLS request via ureq, 6 s
timeout; a bare TCP connect is useless behind a fake-IP VPN, the local proxy
accepts instantly). Any HTTP response counts as reachable; a transport error
downgrades a core-green segment to `data-state="unreachable"` (amber, seg +
chip) with the tooltip suffix "not accepting new connections (web check
failed)". Probe entries carry `failedSince` (the first consecutive failure,
preserved across the 60 s re-probe cycles): once a relay keeps failing for
`RELAY_OFFLINE_AFTER_MS` (10 min), `relaySegmentDisplayState` drops the
segment to `data-state="offline"` (grey seg + chip, tooltip "offline (not
accepting connections for a while)") — including core-red, since the probe
is ground truth for reachability. A passing probe clears `failedSince` and
the segment recovers on the next render. Probes run at most once per domain
per 60 s (`relayProbeCache`);
a 60 s `setInterval(refreshRelayStatus)` drives them while the core is
silent. `parseConnectivityHtml` now also captures the SMTP dot the core
renders OUTSIDE the transport `<li>`s ("Outgoing messages" section — the
per-transport loop can't see it) and the sending relay's segment inherits
it worst-of. The HTML
parsing (segments + SMTP dot + smtp-via) is pinned by
`tests/relay-connectivity-parse.test.mjs`, and the offline escalation by
`tests/relay-offline-state.test.mjs` — both run the production functions
via the slice harness.

## Relay detail chips (`#relay-detail`)

Reworked in 1.4.52 from a stacked detail bar into one chip per relay-line
segment. Absolutely positioned ABOVE the line (`bottom: 100%` inside
`.relay-zone`, z-index over `.sidebar-head`) so it covers the sidebar
header — never the chat list or the category chips below the line (the old
below-the-line bar covered them on desktop hover and mobile pull-down).
The chip row reuses the line's flex template (equal widths, same gap), so
each chip sits directly above its own segment.

Chip content is info-only: the masked domain plus the quota percent —
`chat.example.uk` renders as `cha*.uk · 55%` (`maskRelayDomain`: first
3 chars, one asterisk, TLD visible); the old `<meter>` gauge is gone and
the percent text carries its warning colors instead (green < 70, amber
70–90, red > 90 via `data-level`). Status text ("· connecting") appears
only when the relay has no quota line to show. Unmasked domain, status text and the
full quota line ride the `title` tooltip; chip borders mirror the segment
state — red down, amber #76 unreachable, grey offline.
The relay SELECTED for sending is the transport the SMTP loop is actually
bound to (#79): the vendored core exposes it as `<span class="smtp-via">`
in the connectivity HTML's Outgoing section (VENDORISSUES entry 10 —
re-apply on core upgrades); `parseConnectivityHtml` surfaces it as
`smtpVia` and the envelope + dashes key to its domain. On failover the
marker follows the messages and moves back on reconnect. **Rotation is
covered too**: the core re-elects a transport on disconnect/failure (2.63
made it deterministic — #8797 resets the loop's `transport_id`, and it
reconnects to the most recently successful transport first), and the
marker keeps telling the truth because `smtpVia` is re-read on every
relay-status refresh (ConnectivityChanged, boot, account switch, and the
60 s probe interval — a fully silent rotation can show the old envelope
for up to a minute; the next refresh is always exact). When the marker's
domain differs from the configured address the diagnostics log tags the
send line with "(failover)". Old cores report
nothing and the envelope falls back to `configured_addr`
(`state.account.addr`'s domain, or the only relay when unmatched) — the
wasm core's patch series has no #10 equivalent yet (fold into #112), so
the PWA runs on that fallback. Demo/
local mode is never marked. The envelope marks identity, not activity — the
line's animated dashes stay the messages-in-flight signal — but its color
reports SMTP-loop health via `data-smtp`: green ok, amber retrying
(`connecting` or the #102 delayed state), red down, grey unknown (old core
without the #79 patch). Revealed by
hovering the line (desktop) or pulling down at the top of the chat list on
mobile (touch listeners on `#chat-list`); hides itself after a few
seconds. Quota comes from the connectivity page's `quota-list` (same
HTML-parsing ceiling as the segments — the transport `<li>`s nest the quota
`<ul>`, so `parseConnectivityHtml` slices the transports section and
matches each transport to the next `<li class="transport">` / end of
section; a first-`</li>` match silently truncates the quota).

## Multi-relay manager (`openRelaysModal`)

Reached from the drawer's "Relays of this profile…" — the single entry
point (group/channel info sheets deliberately show no relay rows; the
account transports are identical on every group and relay management is
account-scoped). The GROUP INFO MEMBERS list shows each member's relay
domain as the row subtitle with the full address in the tooltip (#72 —
the "which relay is everyone on" read; core 2.62 exposes one address per
contact via `get_full_chat_by_id` + `get_contacts_by_ids`). Previously
the profile modal also carried relay row(s)
— a single `Relay:` row for one transport, a collapsed `Relays (n)`
details list for several (`showChatInfo` renders them; 1:1
contact profiles instead show the contact's own relay from their address,
since the core exposes no per-contact relay list; the self profile keeps
its transports list). `list_transports` for
the list; `delete_transport` for
removal — immediate since core 2.60.0: the core refuses only the *last*
relay, re-elects the sending transport as needed and informs contacts via
keyupdate messages; `transports-modified` events refresh the modal and the
status line live. `add_transport_from_qr` with `check_qr` validation and
`configure-progress` step UI for adding.

Demo mode: MockCore carries a relay surface (`relayDomains` +
`listTransports`/`setSendRelay`/`deleteTransport`/`getConnectivityHtml`),
so the Relays modal is fully demoable — the second demo relay renders
as unreachable, which exercises the stale-transport hint.

## Deep links

`addRelayFlow` also takes a preset code, so a clicked/pasted `dcaccount:`
deeplink (`handleDeeplinkFromUrl` → `chooseRelayOrNewProfile`) can offer
"add the relay to this profile" alongside the legacy "create a new profile"
path (`addAccountFromInvite`). Android registers the raw
`dcaccount:`/`dclogin:`/`dcbackup:` schemes as intent filters; raw scheme
URLs are opaque (no query/hash to parse), so `extractInviteLink` matches
them with a regex and `extractBackupLink` routes `dcbackup:` deep links
into `receiveSecondDeviceProfile` (presetCode).

## Sending relay

Sending always goes through the primary relay (`configured_addr`). The
Relays modal offers **"Use for sending"** per non-primary relay
(`rpc-core.setSendRelay` → core `set_config("configured_addr", …)`), which
republishes/re-signs the key. Since core 2.61.0 this no longer restarts I/O
and no longer sends a device-sync message of its own — other devices learn
via `TransportsModified` when transports actually change, and the SMTP queue
is handled by the core's pre-encryption queueing. The segmented status line
marks only the sending relay's segment with the sending dashes.

**Demotion (post-1.4.37, issue #11):** the core re-elects the sending
transport only when the pinned one VANISHES
(`maybe_update_sending_transport`) — so a slow sending relay needs an
explicit user action. The sending relay's own row offers **"Stop using for
sending"** (enabled only when another relay exists): it confirms, then calls
`setSendRelay` on the chosen remaining relay. Do not try to *unset*
configured_addr — the core forbids it (`config.rs` bails).

**Stale-transport hint (post-1.4.37):** each modal row shows the relay's
live state from `parseConnectivityHtml` — "unreachable — messages queue
until it's back" while down, "connecting…" while yellow. Best effort by
design: the connectivity page is HTML the core formats for humans (parsing
ceiling above), and the modal stays fully useful without it.

## Do-not-regress

- The drawer's saved-relays bookmark list was removed — profile = identity
  (drawer), relay = property of a profile (Relays modal). Do not resurrect.
- The `transports-modified` listener in app.js (relay status line + any
  open Relays modal) must stay — it is the only signal for relay changes
  synced from another device.
- `refreshRelayStatus` keeps its coalescing: its own `get_connectivity`
  RPCs emit further ConnectivityChanged events, and the unguarded handler
  multiplied storms.

## No built-in Yggdrasil (#29, wontfix)

Closed 2026-09-30 as not planned. Do not embed a Yggdrasil node, and do not
add the "Proxies" drawer that issue asked for.

`core/src/net/proxy.rs` already sends all mail except local chat through
one proxy. `ProxyConfig` accepts HTTP CONNECT, HTTPS, SOCKS5 (`socks5://`),
and Shadowsocks (`ss://`). The keys are `proxy_url` and `proxy_enabled`.
The settings drawer does not read or write them, and that is intentional
after this close: a node on the device (yggstack, or the official Android
VPN) is the mesh endpoint. One proxy is global. A mesh-only SOCKS listener
breaks clearnet chatmail unless it also dials ordinary internet.

There is no small Rust crate that joins Yggdrasil and returns a TCP socket.
Every library that speaks the protocol is a node (key, `200::/7` address,
peers). Research: https://github.com/pbuzdin/velta/issues/29#issuecomment-5886901455.
- Sending dashes (`send-activity`, rpc-core `_trackSending`/`_untrackSending`):
  the terminal MsgDelivered/MsgFailed events can be LOST — the Android
  background poller consumes events while the app is hidden, a transport
  reconnect drops mid-flight events, and a pending message deleted before
  delivery never emits one — each stuck the dashes on until the next send
  or account switch (user reports: "stuck on sending animation"). rpc-core
  now force-clears after 90 s (`sendingBackstopMs` instance knob) and
  `reconcileSending()` re-checks the tracked ids against the core; app.js
  calls it on visibility resume and on `velta-core-status` connected.
  Pinned by `tests/send-activity.test.mjs`.
