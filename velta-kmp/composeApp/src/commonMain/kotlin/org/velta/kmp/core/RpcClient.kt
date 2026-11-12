package org.velta.kmp.core

import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
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
@OptIn(ExperimentalAtomicApi::class)
class RpcClient(
    private val transport: RpcTransport,
    private val log: (String) -> Unit = {},
    readerScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    /** Bound for an ordinary call. Network methods get three times this. Long-polls are unbounded. */
    private val callTimeoutMs: Long = 60_000,
    /**
     * Fired once when the core stops answering or the connection drops.
     * The boolean is true when a call timed out: the core is wedged, not
     * just disconnected. Desktop respawns the sidecar; Android kills the
     * process because the shim cannot be restarted in-process.
     */
    private val onLost: (restartProcess: Boolean) -> Unit = {},
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
    private val closed = AtomicBoolean(false)
    private val lostFired = AtomicBoolean(false)
    private val restartOnLoss = AtomicBoolean(false)

    /** False after a timeout or a dropped connection. The event loop stops. */
    val isOpen: Boolean get() = !lostFired.load() && !closed.load()

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
            if (!closed.load()) noteLost()
        }
    }

    /** Send one call and await its response. Throws [RpcException] on error responses and timeouts. */
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
            val limit = timeoutMs(method)
            return if (limit == null) deferred.await() else withTimeout(limit) { deferred.await() }
        } catch (_: TimeoutCancellationException) {
            restartOnLoss.store(true)
            noteLost()
            transport.close()
            throw RpcException(method, -32001, "timed out")
        } finally {
            lock.withLock { pending.remove(id) }
        }
    }

    override fun close() {
        closed.store(true)
        failAll("rpc client closed")
        transport.close()
        incoming.close()
    }

    /** get_next_event blocks until the core has something to say. Network setup can run for minutes. */
    private fun timeoutMs(method: String): Long? = when (method) {
        "get_next_event", "get_next_event_batch" -> null
        "configure", "secure_join", "add_transport_from_qr", "background_fetch" -> callTimeoutMs * 3
        else -> callTimeoutMs
    }

    private fun noteLost() {
        if (!lostFired.compareAndSet(false, true)) return
        val restart = restartOnLoss.load()
        onLost(restart)
        failAll("core connection lost")
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
