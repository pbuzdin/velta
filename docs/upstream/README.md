# Upstream drafts — chatmail/core

Ready-to-file texts for the two upstream contributions that would let Velta
drop its vendored-core patches (VENDORISSUES #7 and #10). Nothing here is
filed yet — the user reviews, then submits.

- `0001-*.patch` — the #7 PR branch (`fix/animated-webp-byte-exact` in the
  local clone at /tmp/chatmail-core, based on upstream 2.63.0-dev
  @ 7073049). PR text below.
- `issue-sending-transport.md` — the #10 feature issue (file first, PR the
  implementation after the API shape is agreed).

## PR text — fix: don't recode animated WebPs, send them byte-exact

**Title:** `fix: don't recode animated WebPs — send them byte-exact instead of losing animation`

**Body:**

Closes the first half of the TODO in `check_or_recode_to_size`
("Fix lost animation and transparency when recoding using the `image`
crate").

### The bug

Any animated WebP that exceeds the media-quality byte limit or carries an
EXIF chunk is currently run through the `image`-crate recode. The `image`
crate decodes only the **first frame**, so the recipient receives a silent
**static JPEG**: animation gone, transparency flattened. This affects every
client (iOS/Android/Desktop) because the recode happens core-side on send.

### The fix

`check_or_recode_to_size` now detects animated WebPs from the container
header (RIFF/WEBP magic + an `ANMF` chunk in the first 4 KiB — a chunk only
animated files carry) and returns them **byte-exact** before any decode is
attempted. No new dependencies; the sniff is ~15 lines and takes
`impl Read + Seek` so it is unit-testable without fixtures.

### What this does NOT do (the remaining TODO)

- Transparency for *recoded* still images is unchanged.
- EXIF is not stripped from the byte-exact animated WebPs (the RIFF EXIF
  chunk survives). Proper handling — re-animating after recode, or
  byte-exact EXIF-chunk removal — belongs to the full fix the existing TODO
  describes; the early return carries a TODO pointer.
- Byte-exact sending means the media-quality byte limit is not enforced for
  animated WebPs (they were already being sent over-limit in practice when
  small enough to pass; now also when larger). Chatmail relays enforce
  their own server-side size ceiling regardless.

### Testing

- New `src/blob_tests.rs` (this also fixes the test build at HEAD —
  `mod blob_tests;` was declared but the file was missing): container-frame
  construction tests for the sniff — animated detected, static WebP/VP8X-
  only/JPEG/truncated inputs rejected.
- `cargo test -p deltachat --lib blob_tests` green.

---
*Committed on top of 7073049 (2.63.0-dev). Happy to rebase/split.*

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
