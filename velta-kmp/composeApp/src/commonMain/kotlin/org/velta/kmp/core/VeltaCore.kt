package org.velta.kmp.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
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
class VeltaCore(private val client: RpcClient) : AutoCloseable {

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

    suspend fun marknoticedChat(accountId: Long, chatId: Long) {
        client.call(
            "marknoticed_chat",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(chatId)),
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
        client.call("secure_join", RpcClient.params(RpcClient.param(accountId), RpcClient.param(qr)))
            .toString().toLong()

    /** Adds a transport from a `DCACCOUNT:` invite QR (relay onboarding). */
    suspend fun addTransportFromQr(accountId: Long, qr: String) {
        client.call(
            "add_transport_from_qr",
            RpcClient.params(RpcClient.param(accountId), RpcClient.param(qr)),
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
        )
    }

    suspend fun addTransport(accountId: Long, addr: String, password: String) {
        val param = buildJsonObject {
            put("addr", addr)
            put("password", password)
        }
        client.call("add_transport", RpcClient.params(RpcClient.param(accountId), param))
    }

    suspend fun configure(accountId: Long) {
        client.call("configure", RpcClient.params(RpcClient.param(accountId)))
    }

    suspend fun startIoForAllAccounts() {
        client.call("start_io_for_all_accounts")
    }

    suspend fun chatlistEntries(accountId: Long): List<Long> {
        val result = client.call(
            "get_chatlist_entries",
            RpcClient.params(
                RpcClient.param(accountId),
                RpcClient.nullParam(),
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

    /** Long-polls one event; blocks server-side until something happens. */
    suspend fun nextEvent(): CoreEvent =
        client.json.decodeFromString(
            CoreEvent.serializer(),
            client.call("get_next_event").toString(),
        )

    /**
     * Drives `get_next_event` in a loop and forwards events to [onEvent].
     * This is the same pattern the JS `BaseDeltaChat` client uses.
     */
    fun startEventLoop(scope: CoroutineScope, onEvent: suspend (CoreEvent) -> Unit): Job =
        scope.launch {
            while (isActive) {
                val event = try {
                    nextEvent()
                } catch (e: CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    continue
                }
                onEvent(event)
            }
        }

    override fun close() = client.close()
}
