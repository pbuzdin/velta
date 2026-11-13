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
    /** "Configured" or "Unconfigured". This is what get_account_info sends. */
    val kind: String? = null,
    /** Fixture-only. The live core sends [kind], not this field. */
    val isConfigured: Boolean? = null,
) {
    val configured: Boolean get() = kind == "Configured" || isConfigured == true
}

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
    /** Last message's state number (web summaryStatus: 18-28 = outgoing). */
    val summaryStatus: Int = 0,
    /** JsonrpcChatType variant name ("Single"/"Group"/"Mailinglist"/"OutBroadcast"/"InBroadcast"). */
    val chatType: String? = null,
    /** The dm contact of a 1:1 chat (web dmChatContact) — known-contacts + bots. */
    val dmChatContact: Long? = null,
    /** MessageViewtype of the last message (web lastMessageType) — preview emoji prefixes. */
    val lastMessageType: String? = null,
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

/** `MessageLoadResult::Message` (tagged `kind` = "message", enum-level camelCase); `loadingError` is dropped. */
@Serializable
data class MessageObject(
    val kind: String = "message",
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
    /** Raw `Reactions` object (`contactsByReaction`: emoji → contact list); parsed leniently in the UI. */
    val reactions: kotlinx.serialization.json.JsonElement? = null,
    /** Quoted message (`MessageQuote`, tag "kind": JustText | WithMessage; the
     * WithMessage variant is camelCase on the wire). */
    val quote: MessageQuote? = null,
    val file: String? = null,
    val fileName: String? = null,
    val error: String? = null,
)

/** Core `MessageQuote` (message.rs): JustText carries only the text;
 * WithMessage adds the author + metadata (camelCase via serde rename_all). */
@Serializable
data class MessageQuote(
    val kind: String = "JustText",
    val text: String? = null,
    val authorDisplayName: String? = null,
    val authorDisplayColor: String? = null,
    val viewType: String? = null,
    val image: String? = null,
    val messageId: Long? = null,
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
    val lastSeen: Long = 0,
    val isBlocked: Boolean = false,
    /** Core sends camelCase isBot on every ContactObject (web _mapContact). */
    val isBot: Boolean = false,
)

/** Chat draft (camelCase) — text + optional quote; file fields not used yet. */
@Serializable
data class Draft(
    val text: String? = null,
    val quotedMessageId: Long? = null,
    val file: String? = null,
)

/** One configured transport (relay) — subset of EnteredLoginParam we render. */
@Serializable
data class TransportLogin(
    val addr: String = "",
    val imapServer: String? = null,
    val smtpServer: String? = null,
)

/**
 * Relay capabilities per `JsonrpcTransportServerMetadata` (quilt patch #15).
 * Tri-state flags: null = not known yet (IMAP capabilities only exist after
 * the relay's first connection). Server-reported strings are plain text.
 */
@Serializable
data class ServerMetadata(
    val hasTurn: Boolean? = null,
    val irohRelay: String? = null,
    val supportsPush: Boolean? = null,
    val canIdle: Boolean? = null,
    val canCompress: Boolean? = null,
    val maxSmtpRcptTo: Long? = null,
    val comment: String? = null,
    val admin: String? = null,
)

/** A relay card: transport address + its metadata (when the core knows it). */
data class RelayCard(
    val addr: String,
    val metadata: ServerMetadata? = null,
)

/**
 * Parsed QR (core `Qr` oneOf, tagged by `kind`). Only the fields the join
 * flow routes on are decoded; everything else stays ignored (lenient).
 * Kinds: "account" = relay invite (add_transport_from_qr),
 * "askVerifyContact"/"askVerifyGroup"/"askJoinBroadcast" = secure-join,
 * "text" = not a DC QR, others = informational.
 */
@Serializable
data class CoreQr(
    val kind: String = "text",
    val text: String? = null,
    val domain: String? = null,
    val grpname: String? = null,
    val contactId: Long? = null,
) {
    val isAccountInvite: Boolean get() = kind == "account"
    /** DCLOGIN: an address (+password) sign-in to an existing relay account. */
    val isLoginInvite: Boolean get() = kind == "login"
    val isSecureJoin: Boolean
        get() = kind == "askVerifyContact" || kind == "askVerifyGroup" || kind == "askJoinBroadcast"
}

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
