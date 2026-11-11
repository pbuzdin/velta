package org.velta.kmp.ui

/** Local-time HH:mm for message bubbles. The core's RPC timestamps are unix SECONDS. */
expect fun formatTimestamp(epochSeconds: Long): String

/** Day-separator header, local date of the message timestamp. */
expect fun formatDateHeader(epochSeconds: Long): String

/** "4 days ago" / "2 h ago" / "just now" for a contact last-seen. */
expect fun relativeLastSeen(epochSeconds: Long): String
