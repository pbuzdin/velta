# Core stall investigation (after 1.5.0)

Status: the 1.5.0 freeze reports that had a fix are shipped. 1.5.1 is the
watchdog, last-good lists, and patches #22 and #25–#28. 1.5.2 is the
reply-count wedge (#249). Related: #229, #240, #241, #242–#245;
of the progress/loader ideas #231–#238, #233 (first-sync strip) and #238
(search sweep bar) landed in 2bf3ce90, the rest are still open.

## What landed in 1.5.1

- **Core patch #22** (c38a4938, #229): `set_config` / `get_raw_config` no longer
  hold the config cache lock across the DB write. Slow-SQL diagnostics are
  logged to velta.log as `core slow sql: …` (debug).
- **Core watchdog** (eadabcd3, #240, `app/js/core-watchdog.js`): pings
  `get_system_info` every 5 s; the core counts as stuck after 8 s without an
  answer or when the oldest pending call is 10 s old. Shows a banner with
  "Restart core"; a hung core is auto-restarted after 60 s. Dead-core restarts
  back off 1 / 5 / 30 s, at most 3 per 10 min. Skipped during a profile
  transfer and during a 1:1 call.
  False recovery fixed (PR #246, a2b39fb8): the ping avoids the account DB and
  scheduler locks, so it can answer while an account RPC is still stuck — a
  pong now clears `stalled` only when `oldestInFlight()` is under the stall
  threshold, and client-timed-out RPCs stay visible to the watchdog until
  their late answer arrives (entries are cleared on reconnect: they belong to
  the old connection).
  **Limit:** restart only stops/starts IO; it cannot recover a truly wedged
  core process on desktop/Android.
- **Stall-safe lists** (83b2d3da, #241, `app/js/load-retry.js`): relays screen,
  Bots/People chips and chat list keep the last good data and show
  "Couldn't load — Retry". Root cause of the empty Relays screen / Bots=0
  during stalls: a failed/timed-out RPC was rendered as an empty list (app-side,
  not core).
- **Core patches #25–#28** (55a8a393, #242–#245): metadata lock not held across
  network; uncached `get_config` not blocked by a setter (generation counter);
  wake-pending flag so skipped wakes aren't lost; `get_connectivity_html`
  answers "Connecting…" during an IO restart. `tests/core-stall/stop_io_stall.py`
  extended. Quilt is 188 ops / 37 files after #29 (1.5.2).

## Upstream findings

- chatmail core **2.67.0** has no stall fix. Only the tokio-rustls 0.26.6 TLS
  error-handling fix is worth picking up at the next core update.
- Related upstream issues: chatmail/core#8432 (open, ANR freeze), #8513 (open,
  a transport change restarts all IO), #7124/#7125 (connectivity lock
  precedent, in 2.66), #7848, #7950/#7957 (in 2.66).
- Delta Chat desktop/Android/iOS have no core watchdog or auto-restart; Velta's
  watchdog is our own.

## Remaining suspects for the 1.5.0 freeze

- Long DB jobs / write-mutex holders (watch `core slow sql` lines).
- Read-receipt processing.
- A dead tunnel (DNS tunnel / proxy).

## Next step

1.5.1 and 1.5.2 are tagged. A process already wedged on a pre-1.5.2 binary
still has to be quit — the new query is not loaded into that process.
`sqlite3_interrupt` (rusqlite `Connection::get_interrupt_handle()`) was
looked at and not added: the statement that filled the pool is gone, and an
interrupt rolls back the write transaction on that connection. Wire it when
a `core slow sql` line still owns a pool slot after Restart returns.

## #249: get_reply_counts wedge (shipped in 1.5.2)

- `get_reply_counts` (patch #14) self-joined `msgs` via the `chat_id` index on
  both sides: O(n²) per chat. A few overlapping calls held all 3 pool
  connections for minutes; `start_io` and chat opens then timed out, so an IO
  restart could not help. Fixed by core patch #29 (#250) and a single-flight
  reply-count refresh in the chat view.
- Restarts are single-flight; `stop_io` is bounded (15 s), then start anyway.
- Still open: a real process restart. Desktop could respawn the sidecar
  (`sidecar::spawn_sidecar`); Android runs the core in-process, so recovery
  there means relaunching the app process (or moving the core to its own
  `:core` process).
