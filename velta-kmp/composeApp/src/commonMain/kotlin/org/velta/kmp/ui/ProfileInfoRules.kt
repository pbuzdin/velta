package org.velta.kmp.ui

import org.velta.kmp.core.ChatListItem
import kotlin.math.roundToInt

/**
 * Profile storage + chats in common (#358 C). Web `formatBytes`, the
 * Storage row, and `chatsInCommon` (ids only, and only after the row opens,
 * #171). No Compose here.
 */

/** One `get_messages` page. The web pages 500; one id list cannot double-count. */
const val STORAGE_PAGE = 500

/** Web format.js `formatBytes`: one decimal, no GB. Not the attachment chip. */
fun formatStorageBytes(n: Long): String {
    if (n < 1024) return "$n B"
    val (div, unit) = if (n < 1_048_576L) 1024.0 to "KB" else 1_048_576.0 to "MB"
    val tenths = ((n / div) * 10).roundToInt()
    return "${tenths / 10}.${tenths % 10} $unit"
}

/** Web: the row exists for any non-group chat that has a contact, including Saved. */
fun showsChatsInCommon(kind: String, contactId: Long?): Boolean =
    contactId != null && kind != "group" && kind != "channel"

/** Groups and channels already on the chat list. Not archived, not 1:1. */
fun commonCandidates(chats: List<ChatListItem>): List<ChatListItem> =
    chats.filter {
        val kind = chatKindOf(it)
        kind == "group" || kind == "channel"
    }
