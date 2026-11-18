package org.velta.kmp.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Typed facade over the P1 JSON-RPC surface (see issue #192):
 * account + transport setup, io, chat list, messages, events.
 *
 * Method names and positional argument order mirror
 * `core/deltachat-jsonrpc/src/api.rs` (`#[rpc(all_positional)]`).
 */
class VeltaCore(private val client: RpcClient) : AutoCloseable, CallCore {

    val raw: RpcClient get() = client

    suspend fun systemInfo(): JsonObject =
        client.call("get_system_info").let { it as? JsonObject } ?: JsonObject(emptyMap())

    suspend fun addAccount(): Long =
        client.call("add_account").toString().toLong()

    suspend fun accountInfo(accountId: Long): Account =
        client.json.decodeFromString(
            Account.serializer(),
            client.call("get_account_info", RpcClient.params(RpcClient.param(accountId))).toString(),
        )

    /** All account ids known to the core — the persistence layer of P2 resume. */
    suspend fun allAccountIds(): List<Long> {
        val result = client.call("get_all_account_ids")
        return (result as? JsonArray)?.mapNotNull {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    suspend fun contact(accountId: Long, contactId: Long): Contact =
        client.json.decodeFromString(
            Contact.serializer(),
            client.call(
                "get_contact",
                RpcClient.params(RpcClient.param(accountId), RpcClient.param(contactId)),
            ).toString(),
        )

    /** All contacts (web getContacts → get_contacts(acct, 0, null)); lenient per element. */
    suspend fun contacts(accountId: Long): List<Contact> {
        val result = client.call(
            "get_contacts",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(0), RpcClient.nullParam()),
        )
        return (result as? JsonArray)?.mapNotNull { element ->
            runCatching { client.json.decodeFromString(Contact.serializer(), element.toString()) }
                .onFailure { println("velta-kmp: contact decode failed: $it") }
                .getOrNull()
        } ?: emptyList()
    }

    // ---- Chat creation (web rpc-core createChat) ----

    /** 1:1 chat with a contact — creates it if it doesn't exist yet. */
    suspend fun createChatByContactId(accountId: Long, contactId: Long): Long =
        client.call(
            "create_chat_by_contact_id",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(contactId)),
        ).toString().toLong()

    /** Outgoing broadcast channel; recipients join later via the invite QR. */
    suspend fun createBroadcast(accountId: Long, name: String): Long =
        client.call(
            "create_broadcast",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(name)),
        ).toString().toLong()

    suspend fun createGroupChat(accountId: Long, name: String): Long =
        client.call(
            "create_group_chat",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(name), RpcClient.param(false)),
        ).toString().toLong()

    /** #177 (quilt #19): group id = our fingerprint + random; only we manage members. */
    suspend fun createGroupWithAdmin(accountId: Long, name: String): Long =
        client.call(
            "create_group_with_admin",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(name)),
        ).toString().toLong()

    suspend fun addContactToChat(accountId: Long, chatId: Long, contactId: Long) {
        client.call(
            "add_contact_to_chat",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), RpcClient.param(contactId)),
        )
    }

    /** The self/group invite: [code, svg] — the code IS the canonical invite link. */
    suspend fun inviteQr(accountId: Long, chatId: Long? = null): Pair<String, String> {
        val result = client.call(
            "get_chat_securejoin_qr_code_svg",
            RpcClient.params(
                RpcClient.param(accountId),
                if (chatId != null) RpcClient.param(chatId) else RpcClient.nullParam(),
            ),
        )
        val arr = result as? JsonArray ?: return "" to ""
        fun s(i: Int) = (arr.getOrNull(i) as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""
        return s(0) to s(1)
    }

    suspend fun marknoticedChat(accountId: Long, chatId: Long) {
        client.call(
            "marknoticed_chat",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
    }

    /** Marks these messages SEEN: read receipts go out and IMAP \Seen syncs
     * to other devices (web markSeen — only rows actually shown). */
    suspend fun markseenMsgs(accountId: Long, messageIds: List<Long>) {
        if (messageIds.isEmpty()) return
        val ids = buildJsonArray { messageIds.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
        client.call(
            "markseen_msgs",
            RpcClient.params(RpcClient.param(accountId), ids),
        )
    }

    // ---- Write path (P3): the draft flow — set, then send. ----

    suspend fun setDraft(
        accountId: Long,
        chatId: Long,
        text: String,
        quotedMessageId: Long? = null,
        file: String? = null,
        filename: String? = null,
    ) {
        client.call(
            "misc_set_draft",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(chatId),
                RpcClient.param(text),
                if (file != null) RpcClient.param(file) else RpcClient.nullParam(),
                if (filename != null) RpcClient.param(filename) else RpcClient.nullParam(),
                if (quotedMessageId != null) RpcClient.param(quotedMessageId) else RpcClient.nullParam(),
                RpcClient.nullParam(), // viewType — the core infers it from the file
            ),
        )
    }

    suspend fun sendDraft(accountId: Long, chatId: Long) {
        client.call(
            "misc_send_draft",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
    }

    /** Returns null when the chat has no draft (or the core errors out). */
    suspend fun draft(accountId: Long, chatId: Long): Draft? =
        runCatching {
            client.json.decodeFromString(
                Draft.serializer(),
                client.call(
                    "get_draft",
                    RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
                ).toString(),
            )
        }.getOrNull()

    suspend fun removeDraft(accountId: Long, chatId: Long) {
        client.call(
            "remove_draft",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
    }

    /** Toggle the user's reaction (sending the same emoji again removes it). */
    suspend fun sendReaction(accountId: Long, messageId: Long, emoji: List<String>) {
        val emojis = kotlinx.serialization.json.buildJsonArray {
            emoji.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) }
        }
        client.call(
            "send_reaction",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(messageId), emojis),
        )
    }

    // ---- Relay management (P4) — the Velta differentiator. ----

    /** All accounts (id + addr + isConfigured) in one call — the switcher's data. */
    suspend fun allAccounts(): List<Account> {
        val result = client.call("get_all_accounts")
        return (result as? JsonArray)?.mapNotNull { element ->
            runCatching {
                client.json.decodeFromString(Account.serializer(), element.toString())
            }.onFailure { println("velta-kmp: account decode failed: $it") }.getOrNull()
        } ?: emptyList()
    }

    /** The account the core currently has selected (persists across restarts). */
    suspend fun selectedAccountId(): Long? =
        (client.call("get_selected_account_id") as? kotlinx.serialization.json.JsonPrimitive)
            ?.content?.toLongOrNull()

    suspend fun selectAccount(id: Long) {
        client.call("select_account", RpcClient.params(RpcClient.param(id)))
    }

    /**
     * All configured transports (relays) with their metadata merged in.
     * `list_transports` already orders the sending transport first (quilt #11).
     */
    suspend fun relayCards(accountId: Long): List<RelayCard> {
        val rawTransports = client.call("list_transports", RpcClient.params(RpcClient.param(accountId)))
        val transports = (rawTransports as? JsonArray)?.mapNotNull { element ->
            runCatching {
                client.json.decodeFromString(TransportLogin.serializer(), element.toString())
            }.onFailure { println("velta-kmp: transport decode failed: $it") }.getOrNull()
        } ?: emptyList()

        val metaByAddr: Map<String, ServerMetadata> = runCatching {
            val meta = client.call("get_server_metadata", RpcClient.params(RpcClient.param(accountId)))
            (meta as? JsonObject)?.mapNotNull { (addr, value) ->
                val parsed = runCatching {
                    client.json.decodeFromString(ServerMetadata.serializer(), value.toString())
                }.onFailure { println("velta-kmp: metadata decode failed for $addr: $it") }.getOrNull()
                    ?: return@mapNotNull null
                addr to parsed
            }?.toMap()
        }.getOrNull() ?: emptyMap()

        return transports.map { transport ->
            RelayCard(transport.addr, metaByAddr[transport.addr])
        }
    }

    suspend fun deleteTransport(accountId: Long, addr: String) {
        client.call(
            "delete_transport",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(addr)),
            timeoutMs = null,
        )
    }

    // ---- Invite / join flow (P4) ----

    /** Parses a QR string locally (no network): kind + the fields to route on. */
    suspend fun checkQr(accountId: Long, qr: String): CoreQr =
        client.json.decodeFromString(
            CoreQr.serializer(),
            client.call(
                "check_qr",
                RpcClient.params(RpcClient.param(accountId), RpcClient.param(qr)),
            ).toString(),
        )

    /** Starts the secure-join protocol for the QR; returns the chat id. Needs io. */
    suspend fun secureJoin(accountId: Long, qr: String): Long =
        client.call(
            "secure_join",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(qr)),
            timeoutMs = null, // secure-join runs while the caller polls for the chat
        )
            .toString().toLong()

    /** Adds a transport from a `DCACCOUNT:` invite QR (relay onboarding). */
    suspend fun addTransportFromQr(accountId: Long, qr: String) {
        client.call(
            "add_transport_from_qr",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(qr)),
            timeoutMs = null, // runs a server probe + I/O restart, minutes on slow relays
        )
    }

    // ---- Push (P4, Android) ----

    /**
     * SHIM-ONLY method: `Accounts::set_push_device_token` is not on the
     * JSON-RPC surface, so the Android shim intercepts it before dispatch.
     * The desktop sidecar rejects it — push is Android-only. The token is
     * the `webpush:<url>|<pubkey>|<auth>` serialization; the core treats it
     * as opaque, encrypts it to the notifier key and registers it via IMAP
     * METADATA when io runs.
     */
    suspend fun setPushDeviceToken(token: String) {
        client.call(
            "velta_set_push_device_token",
            RpcClient.params(RpcClient.param(token)),
        )
    }

    /** Push-triggered fetch: pulls new mail; results surface as events. */
    suspend fun backgroundFetch(timeoutSeconds: Double) {
        client.call(
            "background_fetch",
            RpcClient.params(RpcClient.param(timeoutSeconds)),
            timeoutMs = null, // long-poll with its own timeout parameter
        )
    }

    // ---- Onboarding (#334: stable splash port) ----

    /** Core autorelay onboarding (stable rpc-core initTransports): probes the
     * core's built-in PUBLIC relay pool (core/src/autorelay.rs) with parallel
     * TCP connects, configures the first that answers and works, skips the
     * rest. A `DCACCOUNT:`/`DCLOGIN:` [qr] adds that one relay instead. */
    suspend fun initTransports(accountId: Long, qr: String? = null) {
        client.call(
            "init_transports",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(qr)),
            timeoutMs = 180_000, // stable's ceiling
        )
    }

    /** Second device: receive a profile from a DCBACKUP code. Returns when
     * the transfer finished (ImexProgress reports along the way). */
    suspend fun getBackup(accountId: Long, qr: String) {
        client.call("get_backup", RpcClient.params(RpcClient.param(accountId), RpcClient.param(qr)), timeoutMs = null)
    }

    /** Restore a backup tar into the (unconfigured) account. */
    suspend fun importBackup(accountId: Long, path: String) {
        client.call(
            "import_backup",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(path), RpcClient.nullParam()),
            timeoutMs = null,
        )
    }

    /** This device offers its profile. Blocks until another device takes it. */
    suspend fun provideBackup(accountId: Long) {
        client.call("provide_backup", RpcClient.params(RpcClient.param(accountId)), timeoutMs = null)
    }

    /** QR text for the running [provideBackup]. Blocks until the provider is ready. */
    suspend fun getBackupQr(accountId: Long): String {
        val el = client.call("get_backup_qr", RpcClient.params(RpcClient.param(accountId)), timeoutMs = null)
        val p = el as? JsonPrimitive ?: return ""
        return if (p.isString) p.content else ""
    }

    /** Write a backup tar into [destination] (a directory the core can write). */
    suspend fun exportBackup(accountId: Long, destination: String) {
        client.call(
            "export_backup",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(destination), RpcClient.nullParam()),
            timeoutMs = null,
        )
    }

    suspend fun stopOngoingProcess(accountId: Long) {
        client.call("stop_ongoing_process", RpcClient.params(RpcClient.param(accountId)))
    }

    suspend fun setConfig(accountId: Long, key: String, value: String?) {
        client.call("set_config", RpcClient.params(RpcClient.param(accountId), RpcClient.param(key), RpcClient.param(value)))
    }

    suspend fun getConfig(accountId: Long, key: String): String? {
        val el = client.call("get_config", RpcClient.params(RpcClient.param(accountId), RpcClient.param(key)))
        val p = el as? JsonPrimitive ?: return null
        return if (p.isString) p.content else null
    }

    suspend fun maybeNetwork() {
        client.call("maybe_network")
    }

    /** True when no account has mail left in the SMTP queue. */
    suspend fun isSendingFinished(): Boolean =
        client.call("is_sending_finished").toString() == "true"

    /** Pre-claims a device-message label so the core never posts it (stable
     * SUPPRESSED_DEVICE_LABELS: the core welcome image). */
    suspend fun suppressDeviceMessage(accountId: Long, label: String) {
        client.call(
            "add_device_message",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(label), RpcClient.nullParam()),
        )
    }

    suspend fun isConfigured(accountId: Long): Boolean =
        client.call("is_configured", RpcClient.params(RpcClient.param(accountId))).toString() == "true"

    suspend fun addTransport(accountId: Long, addr: String, password: String) {
        val param = buildJsonObject {
            put("addr", addr)
            put("password", password)
        }
        client.call("add_transport", RpcClient.params(RpcClient.param(accountId), param), timeoutMs = null)
    }

    suspend fun configure(accountId: Long) {
        client.call("configure", RpcClient.params(RpcClient.param(accountId)), timeoutMs = null)
    }

    suspend fun startIoForAllAccounts() {
        client.call("start_io_for_all_accounts")
    }

    /** Rough relay status for the chat-list strip. 1000 down, 2000 connecting, 4000 connected. */
    suspend fun connectivity(accountId: Long): Int =
        client.call("get_connectivity", RpcClient.params(RpcClient.param(accountId)))
            .toString().trim('"').toInt()

    /**
     * The core's full connectivity HTML page — the ONLY live per-transport
     * source: one `<li class="transport">` per relay with colored dots
     * (web parseConnectivityHtml; 🐴 ceiling noted there too — the upgrade
     * is a per-transport JSON-RPC in the core).
     */
    suspend fun connectivityHtml(accountId: Long): String =
        (client.call("get_connectivity_html", RpcClient.params(RpcClient.param(accountId)))
            as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""

    /** Sticker packs (misc_get_stickers): pack name → sticker file paths. */
    suspend fun getStickers(accountId: Long): Map<String, List<String>> {
        val result = client.call("misc_get_stickers", RpcClient.params(RpcClient.param(accountId)))
        val obj = result as? JsonObject ?: return emptyMap()
        return obj.entries.associate { (pack, value) ->
            pack to ((value as? JsonArray)?.mapNotNull {
                (it as? kotlinx.serialization.json.JsonPrimitive)?.content
            } ?: emptyList())
        }
    }

    // ---- Message sheet actions (#334 step 5) — the same RPCs stable's
    // rpc-core.js calls for each sheet item. ----

    private fun idArray(ids: List<Long>) =
        buildJsonArray { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }

    /** rpc-core forwardMessages. */
    suspend fun forwardMessages(accountId: Long, messageIds: List<Long>, toChatId: Long) {
        client.call(
            "forward_messages",
            RpcClient.params(RpcClient.param(accountId), idArray(messageIds), RpcClient.param(toChatId)),
        )
    }

    /** rpc-core deleteMessages (forAll → delete_messages_for_all). */
    suspend fun deleteMessages(accountId: Long, messageIds: List<Long>, forAll: Boolean) {
        client.call(
            if (forAll) "delete_messages_for_all" else "delete_messages",
            RpcClient.params(RpcClient.param(accountId), idArray(messageIds)),
        )
    }

    /** rpc-core starMessages ("Save to Saved Messages"). */
    suspend fun saveMessages(accountId: Long, messageIds: List<Long>) {
        client.call("save_msgs", RpcClient.params(RpcClient.param(accountId), idArray(messageIds)))
    }

    /** rpc-core resendMessage. */
    suspend fun resendMessages(accountId: Long, messageIds: List<Long>) {
        client.call("resend_messages", RpcClient.params(RpcClient.param(accountId), idArray(messageIds)))
    }

    /** rpc-core editMessage. */
    suspend fun sendEditRequest(accountId: Long, messageId: Long, text: String) {
        client.call(
            "send_edit_request",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(messageId), RpcClient.param(text)),
        )
    }

    /** rpc-core pinMessage. */
    suspend fun setPinned(accountId: Long, messageId: Long, pinned: Boolean) {
        client.call(
            "set_pinned_message_state",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(messageId), RpcClient.param(pinned)),
        )
    }

    /** rpc-core getPinnedMessages: every pinned message id of a chat, in the core's order. */
    suspend fun pinnedMessageIds(accountId: Long, chatId: Long): List<Long> {
        val result = client.call(
            "get_pinned_messages",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
        return (result as? JsonArray)?.mapNotNull {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    /** rpc-core setChatFlags pin/archive → set_chat_visibility ("Normal"/"Pinned"/"Archived"). */
    suspend fun setChatVisibility(accountId: Long, chatId: Long, visibility: String) {
        client.call(
            "set_chat_visibility",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), RpcClient.param(visibility)),
        )
    }

    /** rpc-core setChatFlags mute: MuteDuration is internally tagged ({kind: …}). */
    suspend fun setChatMute(accountId: Long, chatId: Long, kind: String) {
        val duration = buildJsonObject { put("kind", kind) }
        client.call(
            "set_chat_mute_duration",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), duration),
        )
    }

    /** rpc-core leaveGroup. */
    suspend fun leaveGroup(accountId: Long, chatId: Long) {
        client.call("leave_group", RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)))
    }

    suspend fun removeContactFromChat(accountId: Long, chatId: Long, contactId: Long) {
        client.call(
            "remove_contact_from_chat",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), RpcClient.param(contactId)),
        )
    }

    /** rpc-core getChatEphemeralTimer: seconds, 0 = off. */
    suspend fun chatEphemeralTimer(accountId: Long, chatId: Long): Int {
        val result = client.call(
            "get_chat_ephemeral_timer",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
        return (result as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 0
    }

    /** rpc-core setChatEphemeralTimer (the core posts its own system notice). */
    suspend fun setChatEphemeralTimer(accountId: Long, chatId: Long, seconds: Int) {
        client.call(
            "set_chat_ephemeral_timer",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), RpcClient.param(seconds)),
        )
    }

    suspend fun setChatName(accountId: Long, chatId: Long, name: String) {
        client.call(
            "set_chat_name",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), RpcClient.param(name)),
        )
    }

    /** rpc-core getChatDescription. Empty when the chat has none. */
    suspend fun chatDescription(accountId: Long, chatId: Long): String {
        val el = client.call(
            "get_chat_description",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
        val p = el as? JsonPrimitive ?: return ""
        return if (p.isString) p.content else ""
    }

    /** rpc-core setChatDescription. Empty string clears it. */
    suspend fun setChatDescription(accountId: Long, chatId: Long, description: String) {
        client.call(
            "set_chat_description",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), RpcClient.param(description)),
        )
    }

    /** rpc-core setChatImage. Null removes the picture. */
    suspend fun setChatProfileImage(accountId: Long, chatId: Long, path: String?) {
        client.call(
            "set_chat_profile_image",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(chatId),
                if (path == null) RpcClient.nullParam() else RpcClient.param(path),
            ),
        )
    }

    /** rpc-core renameContact: a name only this account sees. */
    suspend fun changeContactName(accountId: Long, contactId: Long, name: String) {
        client.call(
            "change_contact_name",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(contactId), RpcClient.param(name)),
        )
    }

    /** rpc-core deleteChat. */
    suspend fun deleteChat(accountId: Long, chatId: Long) {
        client.call("delete_chat", RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)))
    }

    /** rpc-core acceptChat: a contact request becomes a normal chat. */
    suspend fun acceptChat(accountId: Long, chatId: Long) {
        client.call("accept_chat", RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)))
    }

    /** rpc-core sendMessage (send_msg MessageData; both viewtype casings,
     *  as stable sends them, so either core build reads its own). */
    suspend fun sendMessage(accountId: Long, chatId: Long, text: String, viewtype: String? = null, file: String? = null, filename: String? = null, quotedMessageId: Long? = null): Long? {
        val data = buildJsonObject {
            put("text", text)
            if (quotedMessageId != null) {
                put("quotedMessageId", quotedMessageId)
                put("quoted_message_id", quotedMessageId)
            }
            if (viewtype != null) {
                put("viewType", viewtype)
                put("viewtype", viewtype)
            }
            if (file != null) put("file", file)
            if (filename != null) put("filename", filename)
        }
        val r = client.call("send_msg", RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId), data))
        return (r as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
    }

    /** rpc-core saveSticker (collection "Default"). */
    suspend fun saveSticker(accountId: Long, messageId: Long, collection: String = "Default") {
        client.call(
            "misc_save_sticker",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(messageId), RpcClient.param(collection)),
        )
    }

    /** rpc-core downloadFullMessage. */
    suspend fun downloadFullMessage(accountId: Long, messageId: Long) {
        client.call(
            "download_full_message",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(messageId)),
            timeoutMs = null,
        )
    }

    /** rpc-core getMessageInfo: get_message_info_object → (Message-ID, server URLs). */
    suspend fun messageInfoObject(accountId: Long, messageId: Long): Pair<String, List<String>> {
        val o = client.call(
            "get_message_info_object",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(messageId)),
        ) as? JsonObject
        val mid = (o?.get("rfc724Mid") as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""
        val urls = (o?.get("serverUrls") as? JsonArray)?.mapNotNull {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content
        } ?: emptyList()
        return mid to urls
    }

    suspend fun chatlistEntries(accountId: Long, listFlags: Int? = null): List<Long> {
        val result = client.call(
            "get_chatlist_entries",
            RpcClient.params(
                RpcClient.param(accountId),
                if (listFlags != null) RpcClient.param(listFlags) else RpcClient.nullParam(),
                RpcClient.nullParam(),
                RpcClient.nullParam(),
            ),
        )
        return (result as? JsonArray)?.mapNotNull { entry ->
            (entry as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    /** Contact ids of a chat (a 1:1 chat holds exactly the peer). */
    suspend fun chatContactIds(accountId: Long, chatId: Long): List<Long> {
        val result = client.call(
            "get_chat_contacts",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
        return (result as? JsonArray)?.mapNotNull { entry ->
            (entry as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    /** The contact's encryption-info text (the "Profile key" blocks). */
    suspend fun contactEncryptionInfo(accountId: Long, contactId: Long): String? {
        val result = client.call(
            "get_contact_encryption_info",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(contactId)),
        )
        return (result as? kotlinx.serialization.json.JsonPrimitive)?.content
    }

    /** The full chat record (contacts, mute, ephemeral timer, type). */
    suspend fun fullChat(accountId: Long, chatId: Long): kotlinx.serialization.json.JsonObject? {
        val result = client.call(
            "get_full_chat_by_id",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
        return result as? kotlinx.serialization.json.JsonObject
    }

    /** Message ids of up to three viewtypes in the chat (types are PascalCase: "Image", "Webxdc"...). */
    suspend fun chatMediaIds(accountId: Long, chatId: Long, type1: String, type2: String?, type3: String?): List<Long> {
        val result = client.call(
            "get_chat_media",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(chatId),
                RpcClient.param(type1),
                RpcClient.param(type2),
                RpcClient.param(type3),
            ),
        )
        return (result as? JsonArray)?.mapNotNull { entry ->
            (entry as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    /** Blocks or unblocks a contact. */
    suspend fun setContactBlocked(accountId: Long, contactId: Long, blocked: Boolean) {
        client.call(
            if (blocked) "block_contact" else "unblock_contact",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(contactId)),
        )
    }

    /** Returns only the successfully loaded items; errored entries are logged. */
    suspend fun chatlistItems(accountId: Long, chatIds: List<Long>): List<ChatListItem> {
        if (chatIds.isEmpty()) return emptyList()
        val ids = buildJsonArray { chatIds.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
        val result = client.call(
            "get_chatlist_items_by_entries",
            RpcClient.params(RpcClient.param(accountId), ids),
        )
        val obj = result as? JsonObject ?: return emptyList()
        return obj.entries.mapNotNull { (key, value) ->
            val item = client.json.decodeFromString(
                ChatListItem.serializer(), value.toString(),
            )
            if (item.kind != "ChatListItem") {
                client.let { /* ArchiveLink / Error entries: not shown in the P1 list */ }
                null
            } else {
                if (item.id == 0L) item.copy(id = key.toLongOrNull() ?: 0L) else item
            }
        }
    }

    /** rpc-core searchMessages: core fulltext ids (oldest first); with a
     *  chat id only that chat. */
    suspend fun searchMessages(accountId: Long, query: String, chatId: Long?): List<Long> {
        val result = client.call(
            "search_messages",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(query),
                if (chatId != null) RpcClient.param(chatId) else RpcClient.nullParam(),
            ),
        )
        return (result as? JsonArray)?.mapNotNull {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    suspend fun messageIds(accountId: Long, chatId: Long): List<Long> {
        val result = client.call(
            "get_message_ids",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(chatId),
                RpcClient.param(false),
                RpcClient.param(false),
            ),
        )
        return (result as? JsonArray)?.mapNotNull {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    /** rpc-core getFirstUnreadMessageId: the "Unread messages" line, null when fully read. */
    suspend fun firstUnreadMessageId(accountId: Long, chatId: Long): Long? {
        val result = client.call(
            "get_first_unread_message_of_chat",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
        return (result as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()?.takeIf { it > 0L }
    }

    suspend fun messages(accountId: Long, messageIds: List<Long>): List<MessageObject> {
        if (messageIds.isEmpty()) return emptyList()
        val ids = buildJsonArray { messageIds.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
        val result = client.call(
            "get_messages",
            RpcClient.params(RpcClient.param(accountId), ids),
        )
        val obj = result as? JsonObject ?: return emptyList()
        return obj.entries.mapNotNull { (_, value) ->
            val message = client.json.decodeFromString(MessageObject.serializer(), value.toString())
            // Wire truth (probed against core 2.66): MessageLoadResult is an
            // enum-level camelCase-tagged enum → kind is "message" (lowercase),
            // NOT "Message". LoadingError entries are dropped here.
            if (message.kind == "message") message else null
        }
    }

    /** Velta #14. Map of parent message id → reply count for the whole chat.
     *  Throws when the core has no such method (old sidecar). */
    suspend fun replyCounts(accountId: Long, chatId: Long): Map<Long, Int> {
        val result = client.call(
            "get_reply_counts",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
        )
        val obj = result as? JsonObject ?: return emptyMap()
        val out = HashMap<Long, Int>()
        for ((k, v) in obj) {
            val id = k.toLongOrNull() ?: continue
            val n = (v as? JsonPrimitive)?.content?.toIntOrNull() ?: continue
            if (n > 0) out[id] = n
        }
        return out
    }

    /** Velta #14. Reply ids for one parent, oldest first. */
    suspend fun replyIds(accountId: Long, chatId: Long, messageId: Long): List<Long> {
        val result = client.call(
            "get_reply_ids",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(chatId),
                RpcClient.param(messageId),
            ),
        )
        return (result as? JsonArray)?.mapNotNull {
            (it as? JsonPrimitive)?.content?.toLongOrNull()
        } ?: emptyList()
    }

    /**
     * One parked `get_next_event_batch` (#357). The core returns every event
     * already queued, oldest first. Empty is not an error: a closed channel
     * comes back with nothing, and polling again immediately would spin.
     */
    private suspend fun nextEvents(): List<CoreEvent> {
        val result = client.call("get_next_event_batch", timeoutMs = null)
        val arr = result as? JsonArray ?: return emptyList()
        return arr.map { el ->
            client.json.decodeFromString(CoreEvent.serializer(), el.toString())
        }
    }

    /**
     * Drives `get_next_event_batch` and forwards each event to [onEvent],
     * in order. Same shape as the JS client's batch poll.
     *
     * Consecutive failures end the loop: once the client is dead its calls
     * throw instantly, and retrying forever would just hot-spin a CPU core.
     * A live-but-flaky core recovers — a batch, even an empty one, resets
     * the counter.
     */
    fun startEventLoop(scope: CoroutineScope, onEvent: suspend (CoreEvent) -> Unit): Job =
        scope.launch {
            var failures = 0
            while (isActive) {
                val events = try {
                    nextEvents()
                } catch (e: CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    failures++
                    if (failures >= 5) {
                        println("velta-kmp: event loop stopping after $failures consecutive failures: $t")
                        break
                    }
                    continue
                }
                failures = 0
                if (events.isEmpty()) {
                    delay(250)
                    continue
                }
                for (event in events) onEvent(event)
            }
        }

    override fun close() = client.close()

    // ---- Calls (deltachat calls.rs via jsonrpc; CallManager drives these) ----

    override suspend fun placeOutgoingCall(accountId: Long, chatId: Long, offerSdp: String, hasVideo: Boolean): Long {
        val result = client.call(
            "place_outgoing_call",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(chatId),
                RpcClient.param(offerSdp),
                RpcClient.param(hasVideo),
            ),
        )
        return (result as? JsonObject)?.get("id")?.let { it as? JsonPrimitive }?.content?.toLongOrNull()
            ?: (result as? JsonPrimitive)?.content?.toLongOrNull()
            ?: 0L
    }

    override suspend fun acceptIncomingCall(accountId: Long, msgId: Long, answerSdp: String) {
        client.call(
            "accept_incoming_call",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId), RpcClient.param(answerSdp)),
        )
    }

    override suspend fun endCall(accountId: Long, msgId: Long) {
        client.call(
            "end_call",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId)),
        )
    }

    override suspend fun callInfo(accountId: Long, msgId: Long): JsonObject? {
        val result = client.call(
            "call_info",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId)),
        )
        return result as? JsonObject
    }

    override suspend fun iceServers(accountId: Long): JsonObject? {
        val result = client.call(
            "ice_servers",
            RpcClient.params(RpcClient.param(accountId)),
        )
        return result as? JsonObject
    }
    // ---- Webxdc realtime channels (P3b: the Circle mesh rides these) ----

    /** Advertise on the instance's iroh-gossip topic (core sends the hidden
     *  advertisement mail; peers arrive via WebxdcRealtimeData events). */
    suspend fun sendWebxdcRealtimeAdvertisement(accountId: Long, msgId: Long) {
        client.call(
            "send_webxdc_realtime_advertisement",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId)),
        )
    }

    suspend fun sendWebxdcRealtimeData(accountId: Long, msgId: Long, data: List<Int>) {
        client.call(
            "send_webxdc_realtime_data",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId), JsonArray(data.map { JsonPrimitive(it) })),
        )
    }

    suspend fun leaveWebxdcRealtime(accountId: Long, msgId: Long) {
        client.call(
            "leave_webxdc_realtime",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId)),
        )
    }
    // ---- Webxdc (P3a runtime: WebxdcScreen + the injected window.webxdc) ----

    /** get_webxdc_info -> {name, document, summary, sourceCodeUrl, selfAddr,
     *  selfName, sendUpdateInterval, sendUpdateMaxSize}. */
    suspend fun getWebxdcInfo(accountId: Long, msgId: Long): JsonObject? {
        val result = client.call(
            "get_webxdc_info",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId)),
        )
        return result as? JsonObject
    }

    /** get_webxdc_status_updates -> {updates: [...], serial}. */
    suspend fun getWebxdcStatusUpdates(accountId: Long, msgId: Long, serial: Long): JsonObject? {
        val result = client.call(
            "get_webxdc_status_updates",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId), RpcClient.param(serial)),
        )
        return result as? JsonObject
    }

    suspend fun sendWebxdcStatusUpdate(accountId: Long, msgId: Long, updateJson: String, description: String) {
        client.call(
            "send_webxdc_status_update",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.param(msgId),
                RpcClient.param(updateJson),
                RpcClient.param(description),
            ),
        )
    }

    /** get_webxdc_blob -> base64 (STANDARD_NO_PAD) of one archive file. */
    suspend fun getWebxdcBlob(accountId: Long, msgId: Long, path: String): String? {
        val result = client.call(
            "get_webxdc_blob",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(msgId), RpcClient.param(path)),
        )
        return (result as? JsonPrimitive)?.content
    }
}
