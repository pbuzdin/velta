package org.velta.kmp.ui

import org.velta.kmp.core.MessageObject

// #334 step 11: stable's "Search in chat" (app.js openChatSearch) and the
// jump to a message outside the loaded window (chat-view _jumpToMessage).

/** Queries shorter than this show nothing (stable q.length < 2). */
const val SEARCH_MIN_CHARS = 2
const val SEARCH_DEBOUNCE_MS = 250L
/** rpc-core searchMessages limit: the newest 30 hits, newest first. */
const val SEARCH_LIMIT = 30
/** Stable walks at most 50 pages of 40 older messages to reach a target. */
const val JUMP_MAX_MESSAGES = 50 * 40

/** The query stable sends: trimmed, lowercased; null = too short. */
fun searchQuery(raw: String): String? = raw.trim().lowercase().takeIf { it.length >= SEARCH_MIN_CHARS }

/** Core ids come oldest first; the list shows the newest [limit], newest first. */
fun searchPage(ids: List<Long>, limit: Int = SEARCH_LIMIT): List<Long> = ids.takeLast(limit).reversed()

/** Result row: sender name (bold) and the first 80 characters. */
fun searchHitName(m: MessageObject): String =
    m.overrideSenderName?.ifBlank { null } ?: m.sender?.displayName?.ifBlank { null } ?: m.sender?.name ?: ""

fun searchHitText(m: MessageObject): String = m.text.take(80)

sealed interface JumpPlan {
    /** Already in the loaded window: just scroll. */
    data object Loaded : JumpPlan
    /** Load ids[from, loadedFrom) in front of the window, then scroll. */
    data class LoadFrom(val from: Int) : JumpPlan
    /** Not in the chat any more ("Message is no longer in this chat's history"). */
    data object Gone : JumpPlan
    /** Further back than stable's 50 pages ("…scroll up to load it"). */
    data object TooFar : JumpPlan
}

/** [ids] = the chat's message ids (oldest first), [loadedFrom] = index of
 *  the first loaded one. A little context above the target is loaded too. */
fun jumpPlan(ids: List<Long>, loadedFrom: Int, target: Long, context: Int = 20): JumpPlan {
    val idx = ids.indexOf(target)
    if (idx < 0) return JumpPlan.Gone
    if (idx >= loadedFrom) return JumpPlan.Loaded
    if (loadedFrom - idx > JUMP_MAX_MESSAGES) return JumpPlan.TooFar
    return JumpPlan.LoadFrom((idx - context).coerceAtLeast(0))
}
