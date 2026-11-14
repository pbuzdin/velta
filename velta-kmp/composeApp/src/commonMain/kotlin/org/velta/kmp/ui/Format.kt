package org.velta.kmp.ui

/** Local-time HH:mm for message bubbles. The core's RPC timestamps are unix SECONDS. */
expect fun formatTimestamp(epochSeconds: Long): String

/** Day-separator header, local date of the message timestamp. */
expect fun formatDateHeader(epochSeconds: Long): String

/** "4 days ago" / "2 h ago" / "just now" for a contact last-seen. */
expect fun relativeLastSeen(epochSeconds: Long): String

/** Chat-list stamp, Delta Chat convention: today HH:MM, "Yesterday", 2–6
 * days weekday, same year "Oct 3", older with year (web formatListTime). */
expect fun formatListTime(epochSeconds: Long): String

/** "just now" / "5 minutes ago" / "2 days ago" (web timeAgo, en branch). */
expect fun timeAgo(epochSeconds: Long): String

/** Wall clock in unix seconds (call log timestamps; java.* is not commonMain). */
expect fun wallClockSeconds(): Long

/** Shell-side relay probe (#76): HTTPS GET https://domain/ with a 6 s
 * timeout; true = any HTTP response arrived (a bare TCP connect lies
 * behind fake-IP VPNs — web probe_relay). */
expect suspend fun probeRelayReachable(domain: String): Boolean
