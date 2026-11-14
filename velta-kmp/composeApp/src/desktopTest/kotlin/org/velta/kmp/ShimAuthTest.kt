package org.velta.kmp

import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.ShimAuth
import org.velta.kmp.core.SocketRpcTransport
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * #334: the shim drops connections whose first line is not the per-launch
 * token (pinned in native/rpc-shim tests). These pin the client half: the
 * token is strong, fresh per call, and goes out BEFORE any RPC request.
 */
class ShimAuthTest {

    @Test
    fun tokensAre64HexAndFresh() {
        val a = ShimAuth.newToken()
        val b = ShimAuth.newToken()
        assertEquals(64, a.length)
        assertTrue(a.all { it in '0'..'9' || it in 'a'..'f' }, a)
        assertNotEquals(a, b)
    }

    @Test
    fun tokenIsTheFirstLineBeforeAnyRpc() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            val lines = CompletableFuture<List<String>>()
            Thread {
                server.accept().use { conn ->
                    val reader = conn.getInputStream().bufferedReader()
                    lines.complete(listOf(reader.readLine(), reader.readLine()))
                }
            }.start()
            val token = ShimAuth.newToken()
            val transport = SocketRpcTransport("127.0.0.1", server.localPort, token)
            transport.start(onLine = {}, onExit = {})
            transport.send("""{"jsonrpc":"2.0","id":1,"method":"get_system_info","params":[]}""")
            val (first, second) = lines.get(5, TimeUnit.SECONDS)
            assertEquals(token, first)
            assertTrue(second.contains("get_system_info"), second)
            transport.close()
        }
    }

    /** A gate that behaves like the shim (close on a bad first line): a
     * client with the wrong token gets no answer — its call fails instead. */
    @Test
    fun wrongTokenGetsTheConnectionDropped() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            val expected = ShimAuth.newToken()
            Thread {
                server.accept().use { conn ->
                    val first = conn.getInputStream().bufferedReader().readLine()
                    if (first == expected) error("test sends a wrong token")
                    // reject: close without writing a byte
                }
            }.start()
            val transport = SocketRpcTransport("127.0.0.1", server.localPort, ShimAuth.newToken())
            val client = RpcClient(transport)
            val failed = runCatching {
                kotlinx.coroutines.runBlocking { client.call("get_system_info", timeoutMs = 5_000) }
            }.isFailure
            assertTrue(failed, "a dropped connection must fail the call")
            client.close()
        }
    }
}
