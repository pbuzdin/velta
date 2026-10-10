# Upstream tracking — chatmail/core

What Velta's vendored-core patches (quilt `tools/apply-core-patches.py`,
VENDORISSUES.MD) wait for upstream, and the texts we filed. Velta never
posts in chatmail/deltachat repos from automation; filing is Pavel's call.

## Status (2026-10-10, core 2.63.0)

- **#7 animated WebP — DONE upstream, patch retired.** chatmail/core
  **#8777** ("fix: do not reencode animated WebPs into JPEG") merged
  2026-10-09 as 81140d51 and ships in 2.63.0. Our unfiled draft PR
  (`0001-*.patch`, branch `fix/animated-webp-byte-exact`) is deleted.
- **#10 sending transport — FILED: chatmail/core#8798** (2026-10-04,
  "Client-facing signal for which SMTP transport actually sent a
  message"; text below). Open; a maintainer asked for the use case
  (2026-10-06), answered the same day (user-facing "Sent via <relay>" +
  delivery debugging); no API shape agreed yet. When a core carries it,
  port Velta's `relaySmtpVia` consumer and drop quilt patch #10.
- **#8771 — MERGED 2026-10-06, in 2.63.0:** the SMTP loop connects to the
  most recently successful transport first (`smtp_success` table). Velta
  patch #11 keeps this as the failover order behind the user's pin.
- **#8711 — open DRAFT** ("refactor: remove ConfiguredAddr"; removes
  `Config::ConfiguredAddr` and `maybe_update_sending_transport`;
  `get_primary_self_addr` becomes "first transport by id"). Velta patch #11
  was re-keyed to the ui key `ui.velta.send_transport` (2026-10-10) so this
  cannot break it; rpc-core tolerates `configured_addr` becoming an unknown
  key. Watch it at every re-vendor.
- Removal series context: #8619, #8705, #8703, #8709, #8797 merged
  (#8797, in 2.63.0, resets `transport_id`/`from` in `Smtp::disconnect`);
  umbrella #8572.
- Not filed: #11 (user-chosen send transport), #12 (bounded
  `background_fetch`), #13 (push-token events). Candidates if upstream
  wants them.

## Issue text — expose which transport the SMTP loop is bound to

**Title:** `Expose the transport the SMTP loop is currently bound to (client UIs need it for multi-relay)`

**Body:**

With the send-transport authority moving into the SMTP loop (#8619), the
loop tries every configured transport on (re)connect — newest first — and
uses whichever connects. Two gaps follow for client UIs:

1. **Failover is invisible.** `configured_addr` is only re-elected when a
   transport is *removed* (and #8797 just fixed `transport_id` not being
   *reset* on disconnect — same family). When the configured relay goes
   down and the loop silently binds to another transport, a client marking
   "the relay your messages are sent through" has no way to know: the
   stale `configured_addr` says one thing, the SMTP connection says
   another. We hit this live in Velta: a relay was down for hours while
   the core kept reporting it connected, and messages actually flowed
   through the other transport.

2. **The connectivity HTML can't express it.** `get_connectivity_html`
   renders per-transport IMAP dots and one account-global SMTP line, but
   SMTP's bound transport is known only inside the loop
   (`Smtp::transport_id`), unreachable from the connectivity state.

### Proposal

Expose the bound transport (its transport_id and/or addr) whenever the
SMTP loop has a live connection, in whichever shape the maintainers
prefer — options from least to most structured:

- a. A dedicated read-only RPC, e.g. `get_sending_transport()` →
  `{ transport_id, addr } | null` (null = nothing bound = nothing is
  sending right now).
- b. Extend `get_connectivity` (or its detailed variant) with the field.
- c. An event emitted on SMTP (re)connect/disconnect, so UIs update
  without polling.

(a) is sufficient for our use case: Velta marks the sending relay in its
relay-status UI and needs the marker to follow failover and move back on
reconnect; between sends (no bound connection) we fall back to
`configured_addr`.

Happy to implement once the shape is agreed — we carry a local stopgap
(emitting the addr inside the connectivity HTML) that we would delete in
favor of the real API.
