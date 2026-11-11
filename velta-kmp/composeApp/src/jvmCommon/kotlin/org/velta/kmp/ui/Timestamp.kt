package org.velta.kmp.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val DAY = DateTimeFormatter.ofPattern("d MMM yyyy")

private val zone: ZoneId = ZoneId.systemDefault()

/** actual for the common expect — java.time is safe on both JVM targets (minSdk 26).
 * The core's RPC timestamps are unix SECONDS, not millis. */
actual fun formatTimestamp(epochSeconds: Long): String =
    TIME.withZone(zone).format(Instant.ofEpochSecond(epochSeconds))

/** actual — day-separator header, local date of the message timestamp. */
actual fun formatDateHeader(epochSeconds: Long): String =
    DAY.withZone(zone).format(Instant.ofEpochSecond(epochSeconds))

/** actual — contact last seen, relative. 0 or less = "Never". */
actual fun relativeLastSeen(epochSeconds: Long): String {
    if (epochSeconds <= 0L) return "Never"
    val t = Instant.ofEpochSecond(epochSeconds).atZone(zone)
    val mins = java.time.Duration.between(t, java.time.ZonedDateTime.now()).toMinutes()
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "$mins min ago"
        mins < 1440 -> "${mins / 60} h ago"
        mins < 43200 -> "${mins / 1440} day${if (mins / 1440 > 1) "s" else ""} ago"
        else -> t.format(java.time.format.DateTimeFormatter.ofPattern("d MMM yyyy"))
    }
}
