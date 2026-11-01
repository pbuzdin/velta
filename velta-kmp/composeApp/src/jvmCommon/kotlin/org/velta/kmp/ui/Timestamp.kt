package org.velta.kmp.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** actual for the common expect — java.time is safe on both JVM targets (minSdk 26). */
actual fun formatTimestamp(epochMillis: Long): String =
    DateTimeFormatter.ofPattern("HH:mm")
        .withZone(ZoneId.systemDefault())
        .format(Instant.ofEpochMilli(epochMillis))
