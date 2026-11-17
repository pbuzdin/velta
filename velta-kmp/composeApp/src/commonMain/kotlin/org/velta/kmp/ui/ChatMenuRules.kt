package org.velta.kmp.ui

import org.velta.kmp.core.ChatListItem

/**
 * Chat menus (#334 step 5) — a pure port of stable app.js:
 *  - `chatContextMenu` (chat-list right-click / long-press menu),
 *  - `bindChatHeadMenu` (the open chat's ⋮ menu),
 *  - their confirmations (`confirmModal` texts) and `OLD_MESSAGE_SPANS`,
 *  - rpc-core `_chatKind`, `setChatFlags` and `deleteMessagesOlderThan`.
 * Labels are stable's English strings (the L.t keys). No Compose here:
 * ChatMenuRulesTest pins every rule.
 */

/** rpc-core `_chatKind`: saved / device / deaddrop / group / channel / single. */
fun stableChatKind(isSelfTalk: Boolean, isDeviceTalk: Boolean, isContactRequest: Boolean, chatType: String?): String = when {
    isSelfTalk -> "saved"
    isDeviceTalk -> "device"
    isContactRequest -> "deaddrop"
    chatType == "Group" -> "group"
    chatType == "Mailinglist" || chatType == "OutBroadcast" || chatType == "InBroadcast" -> "channel"
    else -> "single"
}

/** The chat fields the menus read (stable's mapped chat object). */
data class MenuChat(
    val id: Long,
    val name: String,
    val kind: String,
    val chatType: String? = null,
    val pinned: Boolean = false,
    val muted: Boolean = false,
    val archived: Boolean = false,
    val unread: Int = 0,
    /** FullChat.groupAdminId (admin groups); null for regular chats. */
    val groupAdminId: Long? = null,
)

fun menuChatOf(item: ChatListItem, groupAdminId: Long? = null): MenuChat = MenuChat(
    id = item.id,
    name = item.name.ifEmpty { "?" },
    kind = stableChatKind(item.isSelfTalk, item.isDeviceTalk, item.isContactRequest, item.chatType),
    chatType = item.chatType,
    pinned = item.isPinned,
    muted = item.isMuted,
    archived = item.isArchived,
    unread = item.freshMessageCounter,
    groupAdminId = groupAdminId,
)

enum class ChatAction {
    TogglePin, ToggleMute, MarkRead, DeleteOld, ToggleArchive, DeleteChat,
    ChatInfo, GroupInviteQr, LeaveGroup, ClearHistory, StartCall, StartVideoCall,
}

/** One menu row; [action] null = the `"-"` separator. [icon] is stable's
 *  ICON name (list menu only — the ⋮ menu has none). */
data class ChatMenuEntry(
    val action: ChatAction?,
    val label: String = "",
    val icon: String? = null,
    val danger: Boolean = false,
) {
    val isSeparator: Boolean get() = action == null

    companion object {
        val SEPARATOR = ChatMenuEntry(null)
    }
}

/** app.js `chatContextMenu` for a relay chat (no P2P groups in KMP; the
 *  Tauri-only "Link previews" row is not offered — KMP has no previews). */
fun chatListMenu(chat: MenuChat): List<ChatMenuEntry> = buildList {
    add(ChatMenuEntry(ChatAction.TogglePin, if (chat.pinned) "Unpin" else "Pin to top", "pin"))
    add(ChatMenuEntry(ChatAction.ToggleMute, if (chat.muted) "Unmute" else "Mute notifications", "bell"))
    if (chat.unread > 0) add(ChatMenuEntry(ChatAction.MarkRead, "Mark as read", "markRead"))
    add(ChatMenuEntry(ChatAction.DeleteOld, "Delete old messages…", "trash"))
    add(ChatMenuEntry.SEPARATOR)
    add(ChatMenuEntry(ChatAction.ToggleArchive, if (chat.archived) "Unarchive" else "Archive", "archive"))
    add(ChatMenuEntry(ChatAction.DeleteChat, "Delete chat", "trash", danger = true))
}

/** admin-group.js `adminCaps(chat).canAddMembers`: everyone outside admin
 *  groups; inside one only the admin (contact 1 = self). */
fun canAddMembers(chat: MenuChat): Boolean {
    val adminGroup = chat.kind == "group" && (chat.groupAdminId ?: 0L) > 0L
    return !adminGroup || chat.groupAdminId == 1L
}

/** Leave is offered for groups and channels except mailing lists. */
fun canLeave(chat: MenuChat): Boolean =
    chat.kind == "group" || (chat.kind == "channel" && chat.chatType != "Mailinglist")

/** app.js `bindChatHeadMenu` (relay chats; the "Video call" row is not
 *  offered — KMP has no calls). */
fun chatHeadMenu(chat: MenuChat): List<ChatMenuEntry> = buildList {
    add(ChatMenuEntry(ChatAction.ChatInfo, "Chat info"))
    // 1:1 chats only — channels/groups have no caller role (P1b audio).
    if (chat.kind == "single") {
        add(ChatMenuEntry(ChatAction.StartCall, "Voice call"))
        add(ChatMenuEntry(ChatAction.StartVideoCall, "Video call"))
    }
    if (chat.kind == "group" && canAddMembers(chat)) add(ChatMenuEntry(ChatAction.GroupInviteQr, "Group invite QR"))
    add(ChatMenuEntry(ChatAction.ToggleMute, if (chat.muted) "Unmute" else "Mute"))
    add(ChatMenuEntry(ChatAction.TogglePin, if (chat.pinned) "Unpin" else "Pin"))
    if (canLeave(chat)) {
        add(ChatMenuEntry(ChatAction.LeaveGroup, if (chat.kind == "channel") "Leave channel" else "Leave group"))
    }
    add(ChatMenuEntry.SEPARATOR)
    add(ChatMenuEntry(ChatAction.ClearHistory, "Clear history", danger = true))
}

/** A stable `confirmModal(title, text, okLabel, danger)`. [args] fill the
 *  `{name}` / `{label}` placeholders after translation. */
data class ConfirmSpec(
    val title: String,
    val text: String,
    val ok: String = "Delete",
    val danger: Boolean = true,
    val args: Map<String, String> = emptyMap(),
)

/** app.js relay row [data-remove] confirmModal (title carries {addr}). */
fun relayRemoveConfirm(addr: String) = ConfirmSpec(
    title = "Remove {addr}?",
    text = "The relay stops being used right away and your contacts are informed automatically, but messages still on their way to the old address may arrive for a short while. Your last relay cannot be removed.",
    ok = "Remove",
    args = mapOf("addr" to addr),
)

/** chat-view.js received-sticker tap: ask, then the lightbox either way. */
val ADD_STICKER_CONFIRM = ConfirmSpec(
    title = "Add sticker",
    text = "Add this sticker to your sticker collection?",
    ok = "Add",
    danger = false,
)

/** #145: a group or broadcast must be left before delete_chat. */
fun deleteChatLeavesFirst(chat: MenuChat): Boolean =
    chat.kind == "group" || chat.chatType == "OutBroadcast" || chat.chatType == "InBroadcast"

fun deleteChatConfirm(chat: MenuChat): ConfirmSpec {
    val leave = deleteChatLeavesFirst(chat)
    return ConfirmSpec(
        title = "Delete chat",
        text = if (leave) "Leave \"{name}\" and delete it with all its messages?" else "Delete \"{name}\" and all its messages?",
        ok = if (leave) "Leave and delete" else "Delete",
        args = mapOf("name" to chat.name),
    )
}

fun leaveConfirm(chat: MenuChat): ConfirmSpec = if (chat.kind == "channel") {
    ConfirmSpec("Leave channel", "You will no longer receive messages from this channel. Re-subscribe via its invite link/QR.", "Leave")
} else {
    ConfirmSpec("Leave group", "You will leave this chat and no longer receive its messages.", "Leave")
}

val CLEAR_HISTORY_CONFIRM = ConfirmSpec("Clear history", "Delete all messages in this chat?")

/** app.js `OLD_MESSAGE_SPANS` (label key, age in ms). */
val OLD_MESSAGE_SPANS: List<Pair<String, Long>> = listOf(
    "1 hour" to 3_600_000L,
    "1 day" to 86_400_000L,
    "1 week" to 7 * 86_400_000L,
    "5 weeks" to 35 * 86_400_000L,
    "6 months" to 182 * 86_400_000L,
    "1 year" to 365 * 86_400_000L,
)

fun deleteOldConfirm(chat: MenuChat, spanLabel: String): ConfirmSpec = ConfirmSpec(
    title = "Delete old messages",
    text = "Delete every message in \"{name}\" older than {label}? Pinned messages are kept. This cannot be undone.",
    args = mapOf("name" to chat.name, "label" to spanLabel),
)

/** rpc-core `deleteMessagesOlderThan`: ids of unpinned messages whose
 *  timestamp (seconds) is before [cutoffMs]. Input: (id, timestampSec, pinned). */
fun idsOlderThan(messages: List<Triple<Long, Long, Boolean>>, cutoffMs: Long): List<Long> =
    messages.filter { (_, ts, pinned) -> !pinned && ts * 1000 < cutoffMs }.map { it.first }

/** Stable deletes in chunks of 800 ids. */
const val DELETE_CHUNK = 800

/** The delete-old result toast key (with `{n}` filled by the caller). */
fun deletedToastKey(n: Int): String = when (n) {
    0 -> "Nothing older than that"
    1 -> "1 message deleted"
    else -> "Messages deleted: {n}"
}

/** rpc-core `setChatFlags` visibility for a pin / archive toggle. */
fun visibilityFor(pinned: Boolean?, archived: Boolean?): String =
    if (archived == true) "Archived" else if (pinned == true) "Pinned" else "Normal"

/** rpc-core `setChatFlags` mute: `{kind: Forever}` / `{kind: NotMuted}`. */
fun muteKind(muted: Boolean): String = if (muted) "Forever" else "NotMuted"

/** ui.js `placeMenu`: keep the menu 8px from the top/left and 10px from the
 *  right/bottom window edges. */
fun placeMenu(x: Int, y: Int, w: Int, h: Int, winW: Int, winH: Int, near: Int = 8, far: Int = 10): Pair<Int, Int> =
    maxOf(near, minOf(x, winW - w - far)) to maxOf(near, minOf(y, winH - h - far))

/** #334 step 6 — app.js openChat: a contact request (deaddrop) does not
 *  open; stable asks first and accepts on OK (Accept is not a danger). */
fun contactRequestConfirm(name: String): ConfirmSpec = ConfirmSpec(
    title = "Contact request",
    text = "\"{name}\" wants to start a conversation with you. Accept it to read the messages and reply.",
    ok = "Accept",
    danger = false,
    args = mapOf("name" to name.ifEmpty { "?" }),
)
