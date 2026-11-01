package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.RpcException
import org.velta.kmp.core.RpcTransport
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** In-memory transport: records what the client sends, emits canned lines. */
class FakeRpcTransport : RpcTransport {
    val sent = CopyOnWriteArrayList<String>()
    private var onLine: ((String) -> Unit)? = null
    var closed = false
        private set

    override fun start(onLine: (String) -> Unit, onExit: () -> Unit) {
        this.onLine = onLine
    }

    override fun send(line: String) {
        sent.add(line)
    }

    override fun close() {
        closed = true
    }

    fun emit(line: String) {
        onLine?.invoke(line)
    }
}

/**
 * runBlocking on purpose: the client's reader coroutine runs on real
 * Dispatchers.Default threads and completes deferreds from there — the test
 * scheduler's virtual time must not get involved.
 *
 * Calls are launched in a SUPERVISOR scope: a failing call must stay held in
 * its Deferred for assertFailsWith — a plain async child would cancel this
 * runBlocking scope before we ever get to await it.
 */
class RpcClientTest {

    private fun testScope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private suspend fun awaitRequest(transport: FakeRpcTransport, count: Int = 1) {
        withTimeout(5000) {
            while (transport.sent.size < count) kotlinx.coroutines.yield()
        }
    }

    private fun requestId(line: String): String =
        Json.parseToJsonElement(line).jsonObject["id"]!!.jsonPrimitive.content

    @Test
    fun correlatesResponseById() = runBlocking {
        val transport = FakeRpcTransport()
        val client = RpcClient(transport)
        val call = testScope().async { client.call("get_system_info") }
        awaitRequest(transport)
        transport.emit("""{"id":${requestId(transport.sent[0])},"result":{"version":"2.66.0"}}""")
        val result = call.await()
        assertEquals("2.66.0", result.jsonObject["version"]!!.jsonPrimitive.content)
        client.close()
        assertTrue(transport.closed)
    }

    @Test
    fun errorResponseBecomesRpcException() = runBlocking {
        val transport = FakeRpcTransport()
        val client = RpcClient(transport)
        val call = testScope().async { client.call("configure") }
        awaitRequest(transport)
        transport.emit("""{"id":${requestId(transport.sent[0])},"error":{"code":-32000,"message":"bad transport"}}""")
        val exception = assertFailsWith<RpcException> { call.await() }
        assertEquals(-32000, exception.code)
        assertTrue(exception.message!!.endsWith("bad transport"))
        client.close()
    }

    @Test
    fun interleavedCallsMatchTheirOwnResponses() = runBlocking {
        val transport = FakeRpcTransport()
        val client = RpcClient(transport)
        val first = testScope().async { client.call("get_system_info") }
        val second = testScope().async { client.call("add_account") }
        awaitRequest(transport, count = 2)
        val idFirst = requestId(transport.sent[0])
        val idSecond = requestId(transport.sent[1])
        assertTrue(idFirst != idSecond)
        // Answer out of order — correlation must hold.
        transport.emit("""{"id":$idSecond,"result":7}""")
        transport.emit("""{"id":$idFirst,"result":{"version":"x"}}""")
        assertEquals("x", first.await().jsonObject["version"]!!.jsonPrimitive.content)
        assertEquals(7L, second.await().jsonPrimitive.content.toLong())
        client.close()
    }

    @Test
    fun junkAndPushesAreToleratedAndCloseFailsPending() = runBlocking {
        val transport = FakeRpcTransport()
        val client = RpcClient(transport)
        val call = testScope().async { client.call("get_next_event") }
        awaitRequest(transport)
        transport.emit("not json at all") // unparseable junk
        transport.emit("""{"method":"on_realtime_data"}""") // server push
        client.close() // closing fails all pending calls
        assertFailsWith<IllegalStateException> { call.await() }
        assertTrue(transport.closed)
    }
}
