package org.velta.kmp.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val DAY = DateTimeFormatter.ofPattern("d MMM yyyy")

private val zone: ZoneId = ZoneId.systemDefault()

/** actual for the common expect — java.time is safe on both JVM targets (minSdk 26). */
actual fun formatTimestamp(epochMillis: Long): String =
    TIME.withZone(zone).format(Instant.ofEpochMilli(epochMillis))

/** actual — day-separator header, local date of the message timestamp. */
actual fun formatDateHeader(epochMillis: Long): String =
    DAY.withZone(zone).format(Instant.ofEpochMilli(epochMillis))
