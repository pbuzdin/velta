package org.velta.kmp.ui

import org.velta.kmp.core.ChatListItem

/**
 * Pure port of the web chat-list category logic (app/js/rpc-core.js:8-59,
 * :813-867) — the #57 category bar's buckets and the row preview mapping.
 * `all` is the bar's unfiltered state and is never returned by [chatCategoryOf].
 */

/** Web _chatKind: the normalized kind behind the category + avatar tiles. */
fun chatKindOf(item: ChatListItem): String = when {
    item.isSelfTalk -> "saved"
    item.isDeviceTalk -> "device"
    item.isContactRequest -> "deaddrop"
    item.chatType == "Group" -> "group"
    item.chatType == "Mailinglist" || item.chatType == "OutBroadcast" || item.chatType == "InBroadcast" -> "channel"
    else -> "single"
}

/**
 * Web chatCategoryOf (rpc-core.js:24-30): saved/device/deaddrop → "system";
 * group → "groups"; channel → "channels"; a 1:1 chat is "bots" when its
 * contact is a bot, "people" otherwise (unknown contact = people).
 */
fun chatCategoryOf(item: ChatListItem, isBot: (Long) -> Boolean): String = when (val kind = chatKindOf(item)) {
    "saved", "device", "deaddrop" -> "system"
    "group" -> "groups"
    "channel" -> "channels"
    "single" -> if (item.dmChatContact != null && isBot(item.dmChatContact)) "bots" else "people"
    else -> "system"
}

/** Web chatIsUnread — the Unread chip intersects across the kind buckets. */
fun chatIsUnread(item: ChatListItem): Boolean = item.freshMessageCounter > 0

/** Web _mapState (only called for outgoing 18..28): row tick glyph choice. */
fun summaryStateOf(state: Int): String = when (state) {
    18, 19, 20 -> "pending"
    24 -> "failed"
    26 -> "delivered"
    28 -> "read"
    else -> "received"
}

/**
 * Web _mapChatListItem's lastMsg: summaryText1/summaryText2 joined ": ",
 * and for media types the core's summaryText2 passed through UNCHANGED —
 * it already embeds the type emoji ("📷 Photo"/"📷 caption", "🎥 Video",
 * "📎 file – text" — core summary.rs get_summary_text_ext with
 * add_type_emoji). Prepending another emoji here showed one received
 * photo as "📷 📷 caption" (web rpc-core.js _mapChatListItem carries the
 * same no-re-prefix comment).
 */
fun listPreview(item: ChatListItem): String {
    val t2 = item.summaryText2
    return when (item.lastMessageType) {
        "Image", "Gif" -> t2.ifBlank { "📷 Photo" }
        "Voice", "Audio" -> t2.ifBlank { "🎤 Voice message" }
        "Video" -> t2.ifBlank { "🎬 Video" }
        "File" -> t2.ifBlank { "📎 File" }
        "Sticker" -> t2.ifBlank { "Sticker" }
        else -> listOf(item.summaryText1, item.summaryText2)
            .filter { it.isNotBlank() }
            .joinToString(": ")
    }
}

/**
 * Web swipeCategoryStep (rpc-core.js:56-59): the #57 category-bar swipe.
 * A horizontal drag steps +1 (left, toward the next chip) or −1 (right,
 * previous) once it clears [threshold] px AND dominates the vertical axis
 * by 1.4× — anything shallower is a scroll, not a swipe. 0 = no step.
 */
fun swipeCategoryStep(dx: Float, dy: Float, threshold: Float = 48f): Int {
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.4f) return 0
    return if (dx < 0) 1 else -1
}
