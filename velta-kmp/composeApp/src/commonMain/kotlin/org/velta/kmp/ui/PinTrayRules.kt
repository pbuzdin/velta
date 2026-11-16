package org.velta.kmp.ui

import org.velta.kmp.core.MessageObject

/**
 * Pinned-message tray (#358 B) — a pure port of stable chat-view.js
 * `_refreshPinnedBar` and its event wiring. No Compose here:
 * PinTrayRulesTest pins every rule.
 *
 *  - the core's `get_pinned_messages` order is kept; the LAST id is the
 *    newest pin and drives the collapsed summary,
 *  - the expanded list shows every pin newest first,
 *  - the count pill appears only for two or more pins,
 *  - unpin (✕) only where the user may pin: writable chat + adminCaps.canPin,
 *  - a tap on a row collapses the tray and jumps to the message.
 */

/** One tray row: the sender name in bold, then the snippet. */
data class PinRow(val id: Long, val name: String, val snippet: String)

data class PinTray(
    /** Newest pin (collapsed summary). */
    val newest: PinRow,
    /** All pins, newest first (expanded list). */
    val rows: List<PinRow>,
    /** Count pill text, or null for a single pin. */
    val count: String?,
)

/** Stable `snippet`: the first 60 chars of the text, else the viewtype
 *  name for media, else "message" (stable's literal, untranslated). */
fun pinSnippet(m: MessageObject): String {
    val text = m.text.take(60)
    if (text.isNotEmpty()) return text
    val vt = stableViewtype(m.viewType)
    return if (vt != "text") vt else "message"
}

/** rpc-core `fromContact.name`: own messages are "You", others the
 *  contact's displayName / name / address, "?" when all are empty. */
fun pinSenderName(m: MessageObject, you: String = "You"): String {
    if (m.isInfo) return ""
    if (m.fromId == 1L) return you
    val c = m.sender ?: return ""
    return c.displayName.ifEmpty { c.name }.ifEmpty { c.address }.ifEmpty { "?" }
}

/** Stable tray model for the pinned messages in core order; null = hidden. */
fun pinTrayOf(pins: List<MessageObject>, you: String = "You"): PinTray? {
    if (pins.isEmpty()) return null
    val rows = pins.map { PinRow(it.id, pinSenderName(it, you), pinSnippet(it)) }
    return PinTray(
        newest = rows.last(),
        rows = rows.reversed(),
        count = if (rows.size > 1) rows.size.toString() else null,
    )
}

/** Stable `canUnpin = !this.readOnly && adminCaps(this.chat).canPin`. */
fun canUnpinInTray(chat: SheetChat): Boolean = !chat.readOnly && canPin(chat)

/** Core events that refresh the tray of the open chat. PinnedMessagesChanged
 *  fires for pin, unpin AND pin deletion; MsgsChanged / MsgDeleted are
 *  stable's debounced backstop against a dropped event (#69). */
fun pinTrayRefreshes(kind: String?): Boolean =
    kind == "PinnedMessagesChanged" || kind == "MsgsChanged" || kind == "MsgDeleted"

/** Stable's backstop debounce: one refresh per 400 ms burst. */
const val PIN_REFRESH_DEBOUNCE_MS = 400L
