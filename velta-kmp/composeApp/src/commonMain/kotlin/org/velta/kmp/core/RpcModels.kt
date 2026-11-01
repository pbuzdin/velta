package org.velta.kmp.core

import kotlinx.serialization.Serializable

/**
 * Wire models for the subset of the deltachat JSON-RPC surface P1 consumes.
 * All decoding is lenient (`ignoreUnknownKeys`): fields we don't render yet
 * are simply dropped, so minor core additions don't break the client.
 */

@Serializable
data class Account(
    val id: Long = 0,
    val addr: String? = null,
    val displayName: String? = null,
    val isConfigured: Boolean? = null,
)

/** `ChatListItemFetchResult::ChatListItem` (tagged `kind`), error variants dropped. */
@Serializable
data class ChatListItem(
    val kind: String = "ChatListItem",
    val id: Long = 0,
    val name: String = "",
    val avatarPath: String? = null,
    val color: String? = null,
    val summaryText1: String = "",
    val summaryText2: String = "",
    val lastUpdated: Long? = null,
    val freshMessageCounter: Int = 0,
    val isContactRequest: Boolean = false,
    val isGroup: Boolean = false,
    val isSelfTalk: Boolean = false,
    val isDeviceTalk: Boolean = false,
    val isArchived: Boolean = false,
    val isPinned: Boolean = false,
    val isMuted: Boolean = false,
    val isEncrypted: Boolean = false,
    /** `ArchiveLink` fresh counter rides this field via kind != ChatListItem. */
    val error: String? = null,
)

/** `MessageLoadResult::Message` (tagged `kind`); `LoadingError` is dropped. */
@Serializable
data class MessageObject(
    val kind: String = "Message",
    val id: Long = 0,
    val chatId: Long = 0,
    val fromId: Long = 0,
    val text: String = "",
    /** MessageViewtype serializes as a string variant name ("Text", "Image", …). */
    val viewType: String = "Text",
    val state: Int = 0,
    val timestamp: Long = 0,
    val sortTimestamp: Long? = null,
    val isInfo: Boolean = false,
    val isForwarded: Boolean = false,
    val showPadlock: Boolean = true,
    val error: String? = null,
)

/** DC contact (camelCase) — used for sender names in group chats. */
@Serializable
data class Contact(
    val id: Long = 0,
    val name: String = "",
    val displayName: String = "",
    val address: String = "",
    val color: String? = null,
    val profileImage: String? = null,
)

/** Chat draft (camelCase) — text + optional quote; file fields not used yet. */
@Serializable
data class Draft(
    val text: String? = null,
    val quotedMessageId: Long? = null,
    val file: String? = null,
)

/**
 * Core event as returned by the long-poll `get_next_event`:
 * `{accountId, event: {kind, ...}}` — the inner event is kept raw; consumers
 * match on `kind` (ConfigureProgress, MsgsChanged, IncomingMsg, …).
 */
@Serializable
data class CoreEvent(
    val accountId: Long? = null,
    val event: kotlinx.serialization.json.JsonObject? = null,
) {
    val kind: String?
        get() = (event?.get("kind") as? kotlinx.serialization.json.JsonPrimitive)?.content
}
