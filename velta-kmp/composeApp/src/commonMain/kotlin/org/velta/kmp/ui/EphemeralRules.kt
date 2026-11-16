package org.velta.kmp.ui

/**
 * Disappearing-messages setter (#358 C) — a pure port of stable app.js
 * `showChatInfo` (the row) + `openEphemeralDialog` (the editor) and
 * admin-group.js `adminCaps.canSetTimer`. Options and labels live in
 * I18nRules.kt (EPHEMERAL_OPTIONS / ephemeralTimerKey).
 * No Compose here: EphemeralRulesTest pins every rule.
 */

/** Stable: the row exists for relay groups and 1:1 chats, never for
 *  Saved Messages, the device chat, channels or contact requests. */
fun showsEphemeralRow(kind: String): Boolean = kind == "group" || kind == "single"

/** adminCaps.canSetTimer: everyone, except in an admin group where only
 *  the admin (self = contact 1) may change it. */
fun canSetEphemeral(kind: String, groupAdminId: Long?): Boolean {
    val adminGroup = kind == "group" && (groupAdminId ?: 0L) > 0L
    return !adminGroup || groupAdminId == 1L
}

/** Hint on the disabled row (stable `title`). */
const val EPHEMERAL_ADMIN_ONLY = "Only the group admin can do this"

/** The dialog's note under the radios. */
const val EPHEMERAL_NOTE = "Applies to all members of this chat; they can still copy, save, and forward messages."

/** Stable `Math.max(0, seconds | 0)` before set_chat_ephemeral_timer. */
fun ephemeralSecsToSend(secs: Int): Int = secs.coerceAtLeast(0)

/** Radio preselection: the option matching the current timer; a custom
 *  value (another client's) leaves every radio off, like stable — OK then
 *  sends Off (stable reads `:checked` → none → 0). */
fun ephemeralPreselect(current: Int): Int? = EPHEMERAL_OPTIONS.firstOrNull { it.second == current }?.second
