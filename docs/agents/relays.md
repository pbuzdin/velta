# Relays — agent notes

Extracted from AGENTS.md. Everything about the multi-relay UI in app.js.

## Relay status line (`#relay-line`)

Thin strip below the sidebar header; one equal-width segment per configured
relay (up to `MAX_RELAYS = 5` in the core, `configure.rs`), each colored by
that relay's own status — green connected / yellow connecting or retrying /
red unreachable / blue demo or local-chat mode. Per-relay status comes from
parsing the core's `get_connectivity_html` (the only per-transport status
the core exposes; ceiling noted in `parseConnectivityHtml`). With one relay
the line is the old single bar; the combined `get_connectivity` view drives
the 45 s NotConnected grace and the line's overall semantics. Animated
dashes while a message is in flight to the relay (driven by rpc-core's
`send-activity`).

## Relay detail bar (`#relay-detail`)

Absolutely positioned inside `.relay-zone` so it OVERLAYS the chat list
instead of pushing it down. Revealed by hovering the line (desktop) or
pulling down at the top of the chat list on mobile (touch listeners on
`#chat-list`); hides itself after a few seconds. One row per relay: state
dot, domain, status text, quota (usage/limit + percent) parsed from the
connectivity page's `quota-list` (same HTML-parsing ceiling as the
segments). The transport `<li>`s nest the quota `<ul>`, so
`parseConnectivityHtml` slices the transports section and matches each
transport to the next `<li class="transport">` / end of section — a
first-`</li>` match silently truncates the quota.

## Multi-relay manager (`openRelaysModal`)

Reached from the drawer's "Relays of this profile…" — the single entry
point (group/channel info sheets deliberately show no relay rows; the
account transports are identical on every group and relay management is
account-scoped). Previously the profile modal also carried relay row(s)
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
