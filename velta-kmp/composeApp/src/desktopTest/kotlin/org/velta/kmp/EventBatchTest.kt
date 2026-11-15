package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.VeltaCore
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #357: catch-up is one `get_next_event_batch` round trip. A two-event
 * response calls the listener twice, in order. An empty batch is not a
 * failure and does not spin the loop.
 */
class EventBatchTest {

    private fun batchOf(vararg kinds: String): String {
        val events = kinds.joinToString(",") { kind ->
            """{"contextId":1,"event":{"kind":"$kind","chatId":2,"msgId":3}}"""
        }
        return "[$events]"
    }

    @Test
    fun twoEventsDispatchInOrder() = runBlocking {
        val transport = ScriptedRpcTransport(mapOf("get_next_event_batch" to batchOf("IncomingMsg", "MsgRead")))
        val core = VeltaCore(RpcClient(transport))
        val kinds = CopyOnWriteArrayList<String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        core.startEventLoop(scope) { kinds += it.kind ?: "?" }
        try {
            withTimeout(5_000) { while (kinds.size < 2) yield() }
            assertEquals(listOf("IncomingMsg", "MsgRead"), kinds.take(2))
            assertTrue(transport.requests.all { "\"get_next_event_batch\"" in it })
        } finally {
            scope.cancel()
            core.close()
        }
    }

    @Test
    fun emptyBatchIsNotAFailure() = runBlocking {
        val transport = ScriptedRpcTransport(mapOf("get_next_event_batch" to "[]"))
        val core = VeltaCore(RpcClient(transport))
        val kinds = CopyOnWriteArrayList<String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val job = core.startEventLoop(scope) { kinds += it.kind ?: "?" }
        try {
            withTimeout(5_000) { while (transport.requests.size < 2) yield() }
            assertTrue(kinds.isEmpty())
            assertTrue(job.isActive, "an empty batch must not stop the loop")
        } finally {
            scope.cancel()
            core.close()
        }
    }
}
