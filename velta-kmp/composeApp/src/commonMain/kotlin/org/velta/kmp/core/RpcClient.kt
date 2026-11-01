package org.velta.kmp.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Error response of the RPC server (yerpc shape: `{code, message}`). */
class RpcException(val method: String, val code: Int, message: String) :
    Exception("$method failed ($code): $message")

/**
 * Minimal JSON Lines RPC client for `deltachat-rpc-server`.
 *
 * Requests are positional (`#[rpc(all_positional)]` in deltachat-jsonrpc):
 * params travel as a JSON array. Responses are correlated by the `id` field;
 * lines that carry a `method` instead are server-pushed calls (webxdc
 * internals today) and are surfaced via [pushes].
 *
 * Concurrency: the transport thread only does `trySend` into [incoming];
 * one reader coroutine owns the pending-calls map (guarded by [lock] against
 * [call]'s registration). Pure common code — no java.* here.
 */
class RpcClient(
    private val transport: RpcTransport,
    private val log: (String) -> Unit = {},
    readerScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : AutoCloseable {

    val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val lock = Mutex()
    private var nextId = 1
    private val pending = HashMap<Int, CompletableDeferred<JsonElement>>()

    private val _pushes = MutableSharedFlow<String>(extraBufferCapacity = 64)
    val pushes: SharedFlow<String> = _pushes

    private val incoming = Channel<String>(Channel.UNLIMITED)
    private val reader: Job

    init {
        transport.start(
            onLine = { line -> incoming.trySend(line) },
            onExit = { incoming.close() },
        )
        reader = readerScope.launch {
            for (line in incoming) {
                handleLine(line)
            }
        }
    }

    /** Send one call and await its response. Throws [RpcException] on error responses. */
    suspend fun call(method: String, params: JsonArray = JsonArray(emptyList())): JsonElement {
        val deferred: CompletableDeferred<JsonElement>
        val id: Int
        lock.withLock {
            id = nextId++
            deferred = CompletableDeferred()
            pending[id] = deferred
        }
        val line = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            put("params", params)
        }.toString()
        transport.send(line)
        try {
            return deferred.await()
        } finally {
            lock.withLock { pending.remove(id) }
        }
    }

    override fun close() {
        failAll("rpc client closed")
        transport.close()
        incoming.close()
    }

    private suspend fun handleLine(line: String) {
        if (line.isBlank()) return
        val obj = try {
            json.parseToJsonElement(line).let { it as? JsonObject }
        } catch (t: Throwable) {
            log("unparseable rpc line: ${line.take(200)}")
            null
        } ?: return

        val id = (obj["id"] as? JsonPrimitive)?.content?.toIntOrNull()
        if (id != null) {
            val deferred = lock.withLock { pending.remove(id) }
            if (deferred == null) {
                log("response for unknown id $id")
                return
            }
            val error = obj["error"] as? JsonObject
            if (error != null) {
                val code = (error["code"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0
                val message = (error["message"] as? JsonPrimitive)?.content ?: "unknown error"
                deferred.completeExceptionally(RpcException("id=$id", code, message))
            } else {
                deferred.complete(obj["result"] ?: JsonPrimitive(null))
            }
        } else if (obj.containsKey("method")) {
            _pushes.tryEmit(line)
        } else {
            log("rpc line without id or method: ${line.take(200)}")
        }
    }

    private fun failAll(reason: String) {
        val snapshot = pending.values.toList()
        pending.clear()
        for (deferred in snapshot) {
            deferred.completeExceptionally(IllegalStateException(reason))
        }
    }

    companion object {
        /** Convenience for building positional params. */
        fun params(vararg elements: JsonElement): JsonArray = JsonArray(elements.toList())

        fun param(value: String?): JsonElement = JsonPrimitive(value)

        fun param(value: Number?): JsonElement = JsonPrimitive(value)

        fun param(value: Boolean?): JsonElement = JsonPrimitive(value)

        fun nullParam(): JsonElement = JsonPrimitive(null)
    }
}
