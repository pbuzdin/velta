# Scheduled messages ("Send later")

On-device scheduling: a scheduled message stays on this device until it is
due, then goes out through the normal send path (`send_msg` on the Delta Chat
core). Nothing is handed to a relay early, so encryption, relay choice and
multi-device behave exactly like a message sent by hand at that moment.
No `core/` change.

## Using it

- **Open "Send later"**: right-click or long-press (500 ms, touch) the Send
  button, the ContextMenu key / Shift+F10 on it, **Ctrl/Cmd+Shift+Enter** in
  the composer, or **Attach menu → Send later** (keyboard/screen-reader route).
- **Presets** (user's local time zone): in 1 hour, tonight 20:00 (hidden
  after ~19:59), tomorrow 09:00, next Monday 09:00 (on a Monday: the following
  one). **Custom**: native `<input type="datetime-local">`, local time; the
  sheet shows the zone name.
- **Chat**: an "N scheduled" chip above the composer opens the chat's list:
  Send now, Edit time, Edit text, Delete (confirmation).
- **Everything**: drawer → *Scheduled messages* (all profiles).

Text only (with reply quote, and with a selected-fragment quote as `> `
prefix exactly like `_send()`). Attachments, voice and edits are refused
with a toast for now; markdown is the same as a normal send (rendered by the
receiving client). Local (p2p) chats cannot schedule.

## Storage

One JSON document, `{version: 1, items: [...]}`. Item fields: `id`,
`accountId`, `chatId`, `text`, `quoteId`, `dueAt` (UTC ms), `createdAt`,
`status` (`pending` | `sending` | `error`), `error`, `attempts`, `retryAt`,
`claimedAt`, `uncertain`.

| Shell | Where | Code |
|---|---|---|
| Tauri desktop | `scheduled.json` in the app local data dir | `scheduled.rs` command `scheduled_op` |
| Tauri Android | `scheduled.json` in `filesDir` (AppData), readable by Kotlin without the WebView | same |
| PWA / browser | `localStorage["velta-scheduled"]` | `localStore()` in `scheduled.js` |

All mutations are ops (`add`, `update`, `remove`, `claim`, `done`, `fail`,
`recover`), implemented twice with the same rules: `applyOp` in
`app/js/scheduled.js` and `apply` in `velta-app/src-tauri/src/scheduled_store.rs`
(unit tests in both). The Rust side serializes ops with a mutex and writes
via temp file + rename. Nothing rewrites the whole document from the page,
so a page edit can never resurrect an item the alarm path just sent.

## Sending and no double send

1. `recover`: an item stuck in `sending` for ≥ 2 min (crash/kill mid-send) becomes
   `error` with `uncertain: true`.
2. For each due item: `claim` (pending/error → `sending`, only one caller
   wins), then send, then `done` (removed) or `fail`.
3. `fail` keeps the item as `error` with a backoff (1, 5, 15, 60 min) for the
   periodic timer; app start/resume and alarms retry immediately.
4. Errors where the core may already have queued the message (timeouts,
   dropped channel, restart) are `uncertain` and are **never** retried
   automatically. The list shows "Not sure it was sent"; the user checks the
   chat and taps Send now (an explicit edit clears the flag).

Who sends:

- **Desktop / PWA**: the page's `ScheduledRunner` calls
  `core.sendMessage(chatId, {text, quoteId, accountId})` — the same method
  the composer uses (`accountId` option added so a message goes out from the
  profile it was written in, even after switching profiles).
- **Android**: the shell sends (`scheduled::run_due`), from both the alarm and
  the page (`scheduled_run_due`), under one async mutex, through the in-process
  core's JSON-RPC (`bg_rpc("send_msg", [accountId, chatId, {text,
  quotedMessageId, quoted_message_id}])` — byte-for-byte the params
  rpc-core builds for a text send). The page never sends on Android, so the
  WebView and the receiver cannot race.

## Wakeups

**Desktop / PWA**: `setTimeout` to the next due/retry time (clamped to 2^31 ms),
a 60 s safety tick (timers stall across sleep), a catch-up pass at startup and
on every `visibilitychange` to visible / `velta-foreground`. The PWA only
sends while a tab is open (the UI says so).

**Android**:

- One alarm (`ScheduledAlarm.kt`) for the earliest pending/retry time,
  re-armed by Rust after every op and by Kotlin from the file.
- `setExactAndAllowWhileIdle(RTC_WAKEUP)` when `canScheduleExactAlarms()`
  (always true below Android 12), else `setAndAllowWhileIdle`.
- Manifest: `SCHEDULE_EXACT_ALARM` (user-grantable, off by default on 14+),
  **not** `USE_EXACT_ALARM` (Play restricts it to alarm/calendar apps).
  `RECEIVE_BOOT_COMPLETED` for re-arming.
- The first time a message is scheduled without the permission, a one-time
  sheet explains it is optional and offers *Open settings*
  (`ACTION_REQUEST_SCHEDULE_EXACT_ALARM`). Granting it fires
  `SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED`, which re-arms.
- `ScheduledAlarmReceiver` handles the alarm plus `BOOT_COMPLETED`,
  `MY_PACKAGE_REPLACED`, `TIME_SET`, `TIMEZONE_CHANGED` (dueAt is UTC, so
  these only need a re-arm).
- On the alarm: start `CoreService` (the app's existing foreground service;
  starting it is allowed from an exact alarm, may be refused for an inexact
  one on 12+ — caught), then JNI `scheduledWakeup()` → `run_due` on the
  in-process core, the same pattern as `pushWakeup` / `BackgroundFetchJob`.
  No WebView is needed.
- **Cold process** (the OS killed Velta, the alarm restarts the process but
  nobody initialized the core): `scheduledWakeup` returns false and a
  notification "Scheduled message is due — open Velta to send it" is posted;
  opening the app sends it (catch-up on start). Starting the full core
  without the activity is not supported by the shell today (see AGENTS.md
  §9.4, same ceiling as push wakeups).
- Catch-up on app start and on every resume (`velta-foreground`).

### Doze behaviour

- Exact + allow-while-idle: fires on time even in Doze (the OS rate-limits
  allow-while-idle alarms to roughly one per ~9 min per app in deep Doze).
- Inexact: deferred to the next maintenance window — typically ~10–15 min
  late on an idle phone, longer in deep Doze.
- The send itself needs network: in Doze the alarm grants a short network
  window; with the battery-optimization exemption (already requested by
  Velta for background sync) it is reliable. OEM "battery savers" that kill
  apps can still delay delivery until Velta is opened.

## Limits

- Text only (plus reply quote); attachments are not scheduled yet.
- PWA: sends only while open; data is per browser profile (localStorage).
- Desktop: sends only while Velta is running (catch-up on next start).
- Scheduled items are not synced to other devices and are not part of
  backups / settings export.
- Max text 64 KiB (UTF-16 units). Times are minute-precision from the picker.
- An item deleted from the chat (chat removed) fails with the core's error and
  stays in the list as an error for the user to delete.

## Verification

- `tests/scheduled-messages.test.mjs`: ops, presets across zones/DST
  (Moscow, Berlin fall-back, New York spring-forward), datetime-local round
  trip, catch-up, concurrent runners (no double send), failure/retry,
  uncertain errors, Android wiring, list rendering.
- `cargo test --lib scheduled_store` (Rust mirror).
- Needs a device: alarm delivery in Doze, exact-alarm prompt, boot re-arm,
  cold-process notification.
