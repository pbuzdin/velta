package org.velta.kmp.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val DAY = DateTimeFormatter.ofPattern("d MMM yyyy")
private val WEEKDAY = DateTimeFormatter.ofPattern("EEE")
private val LIST_DATE = DateTimeFormatter.ofPattern("MMM d")
private val LIST_DATE_YEAR = DateTimeFormatter.ofPattern("MMM d, yyyy")

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

/** actual — chat-list stamp (web formatListTime). */
actual fun formatListTime(epochSeconds: Long): String {
    val t = Instant.ofEpochSecond(epochSeconds).atZone(zone)
    val today = java.time.LocalDate.now(zone)
    val days = java.time.temporal.ChronoUnit.DAYS.between(t.toLocalDate(), today)
    return when (days) {
        0L -> TIME.format(t)
        1L -> "Yesterday"
        in 2..6 -> WEEKDAY.format(t)
        else ->
            if (t.year == today.year) LIST_DATE.format(t) else LIST_DATE_YEAR.format(t)
    }
}

/** actual — relative time for the calls view (web timeAgo, en branch). */
actual fun timeAgo(epochSeconds: Long): String {
    if (epochSeconds <= 0L) return ""
    val secs = java.time.Duration.between(Instant.ofEpochSecond(epochSeconds), Instant.now()).seconds
    if (secs < 60) return "just now"
    val min = secs / 60
    if (min < 60) return "$min minute${if (min == 1L) "" else "s"} ago"
    val hrs = min / 60
    if (hrs < 24) return "$hrs hour${if (hrs == 1L) "" else "s"} ago"
    val days = hrs / 24
    return "$days day${if (days == 1L) "" else "s"} ago"
}

/** actual — wall clock (JVM targets only; both Android and desktop are JVM). */
actual fun wallClockSeconds(): Long = System.currentTimeMillis() / 1000
