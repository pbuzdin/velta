package org.velta.kmp.ui

/** Local-time HH:mm for message bubbles. */
expect fun formatTimestamp(epochMillis: Long): String

/** Day-separator header, local date of the message timestamp. */
expect fun formatDateHeader(epochMillis: Long): String
