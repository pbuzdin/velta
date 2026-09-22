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

Reached from the drawer's "Relays of this profile…" and the profile modal's
relay row(s) — a single `Relay:` row for one transport, a collapsed
`Relays (n)` details list for several (`showChatInfo` renders them; 1:1
contact profiles instead show the contact's own relay from their address,
since the core exposes no per-contact relay list). `list_transports` for
the list; `delete_transport` for
removal — immediate since core 2.60.0: the core refuses only the *last*
relay, re-elects the sending transport as needed and informs contacts via
keyupdate messages; `transports-modified` events refresh the modal and the
status line live. `add_transport_from_qr` with `check_qr` validation and
`configure-progress` step UI for adding.

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

## Do-not-regress

- The drawer's saved-relays bookmark list was removed — profile = identity
  (drawer), relay = property of a profile (Relays modal). Do not resurrect.
- The `transports-modified` listener in app.js (relay status line + any
  open Relays modal) must stay — it is the only signal for relay changes
  synced from another device.
- `refreshRelayStatus` keeps its coalescing: its own `get_connectivity`
  RPCs emit further ConnectivityChanged events, and the unguarded handler
  multiplied storms.
