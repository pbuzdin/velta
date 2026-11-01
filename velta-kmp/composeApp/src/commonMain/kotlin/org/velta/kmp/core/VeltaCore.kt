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
            if (message.kind == "Message") message else null
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
