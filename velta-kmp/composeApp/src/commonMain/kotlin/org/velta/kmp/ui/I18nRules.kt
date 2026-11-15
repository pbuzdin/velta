package org.velta.kmp.ui

/**
 * Pure label rules for #334 step 9 (translations), mirrored from stable so
 * the English keys match app/locales and the desktop tests pin them.
 */

/** app.js EPHEMERAL_OPTIONS: the official client's timer list (seconds). */
val EPHEMERAL_OPTIONS: List<Pair<String, Int>> = listOf(
    "Off" to 0,
    "After 5 minutes" to 5 * 60,
    "After 1 hour" to 60 * 60,
    "After 1 day" to 24 * 60 * 60,
    "After 1 week" to 7 * 24 * 60 * 60,
    "After 5 weeks" to 5 * 7 * 24 * 60 * 60,
    "After 1 year" to 365 * 24 * 60 * 60,
)

/** app.js formatEphemeralTimer: an option label, else "On ({n} s)" / "Off".
 *  Returns the English key and the {n} value (null when there is none). */
fun ephemeralTimerKey(secs: Int): Pair<String, Int?> {
    EPHEMERAL_OPTIONS.firstOrNull { it.second == secs }?.let { return it.first to null }
    return if (secs > 0) "On ({n} s)" to secs else "Off" to null
}

/** app.js relayFlagsHtml: the words behind the C / I / P / D letters. */
val RELAY_FLAG_LABELS: List<Pair<String, String>> = listOf(
    "C" to "Calls: the relay hands out TURN credentials",
    "I" to "iroh relay: helps Beam and peer-to-peer transfers",
    "P" to "Push notifications: the relay accepts device tokens",
    "D" to "Instant delivery: the relay pushes new mail to the app as it arrives (IMAP IDLE)",
)

/** Stable "No stickers yet.<br>…" is HTML; Compose text takes a newline. */
fun htmlBreaks(text: String): String = text.replace(Regex("<br\\s*/?>"), "\n")
