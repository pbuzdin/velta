package org.velta.kmp.ui

import org.velta.kmp.core.MessageObject

/**
 * Reply threads (stable chat-view.js `_replyCountFor` / `_openThread`).
 * A reply is a message whose quote points at another message in the chat.
 * There is no thread object.
 */

/** Quotes that name a message. A text-only quote is not a reply. */
fun replyParentId(m: MessageObject): Long? = m.quote?.messageId?.takeIf { it > 0L }

/** Counts over the loaded window. Edits are hidden rows the core never returns. */
fun windowReplyCounts(messages: List<MessageObject>): Map<Long, Int> {
    val out = HashMap<Long, Int>()
    for (m in messages) {
        val parent = replyParentId(m) ?: continue
        out[parent] = (out[parent] ?: 0) + 1
    }
    return out
}

/**
 * Stable `_replyCountFor`. With the #14 core, max(core, window) so a reply
 * that just landed still counts. Without it, the window count shows only
 * when no older page is missing — a partial window would under-count.
 */
fun replyCountFor(
    id: Long,
    window: Map<Long, Int>,
    core: Map<Long, Int>?,
    hasMore: Boolean,
): Int {
    val w = window[id] ?: 0
    if (core != null) return maxOf(core[id] ?: 0, w)
    return if (hasMore) 0 else w
}

/** Parent first, then replies oldest first. [extras] fills ids the window lacks. */
fun threadRows(
    loaded: List<MessageObject>,
    extras: List<MessageObject>,
    parentId: Long,
): List<MessageObject> {
    val byId = LinkedHashMap<Long, MessageObject>()
    for (m in loaded) byId[m.id] = m
    for (m in extras) if (m.id !in byId) byId[m.id] = m
    val parent = byId[parentId]
    val replies = byId.values
        .filter { it.id != parentId && replyParentId(it) == parentId }
        .sortedBy { it.sortTimestamp ?: it.timestamp }
    return listOfNotNull(parent) + replies
}

/** Header's one-line original: "Name: first line", or the file name. */
fun threadOrigLine(name: String, text: String, fileName: String?): String {
    val body = (text.ifBlank { fileName.orEmpty() }).lineSequence().firstOrNull().orEmpty().trim()
    return when {
        name.isBlank() -> body
        body.isBlank() -> name
        else -> "$name: $body"
    }
}

/**
 * What this send quotes, and which message the bar shows afterwards.
 * The send uses the bar as it is now. An open thread puts the bar back
 * on the parent; otherwise the bar clears (stable appendOutgoing).
 */
fun sendQuotePlan(threadParentId: Long?, replyToId: Long?): Pair<Long?, Long?> =
    replyToId to threadParentId

/** JSON-RPC -32601 / "not found": this core has no reply queries. Permanent. */
fun replyRpcMissing(t: Throwable): Boolean {
    val msg = t.message ?: return false
    return msg.contains("32601") || msg.contains("not found", ignoreCase = true)
}
