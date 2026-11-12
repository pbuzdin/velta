package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Answers every request from a static method→result script; methods without
 * an entry (e.g. get_next_event) simply never get a response, like a real
 * long-poll. A result starting with "ERROR:" is answered as a JSON-RPC error
 * with that message instead. Records all requests for assertions.
 */
class ScriptedRpcTransport(private val script: Map<String, String>) : RpcTransport {
    val requests = CopyOnWriteArrayList<String>()
    private var onLine: ((String) -> Unit)? = null
    var closed = false
        private set

    override fun start(onLine: (String) -> Unit, onExit: () -> Unit) {
        this.onLine = onLine
    }

    override fun send(line: String) {
        requests.add(line)
        val obj = Json.parseToJsonElement(line).jsonObject
        val id = obj["id"]!!.jsonPrimitive.content
        val method = obj["method"]!!.jsonPrimitive.content
        val scripted = script[method] ?: return
        if (scripted.startsWith("ERROR:")) {
            onLine?.invoke(
                """{"id":$id,"error":{"code":-1,"message":"${scripted.removePrefix("ERROR:")}"}}""",
            )
        } else {
            onLine?.invoke("""{"id":$id,"result":$scripted}""")
        }
    }

    override fun close() {
        closed = true
    }
}

/**
 * P2 persistence: the core's accounts dir is the storage. On connect the
 * app must resume a configured account straight into the chat list, and
 * fall back to the login screen (reusing an unconfigured account) when
 * there is nothing to resume.
 */
class ResumeSessionTest {

    private fun testScope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun resumesConfiguredAccountOnConnect() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to
                    """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[5]",
                "get_chatlist_items_by_entries" to
                    """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"hello there","lastUpdated":1730000000000,"freshMessageCounter":2}}""",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-resume-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            try {
                withTimeout(10_000) {
                    while (model.screen != AppModel.Screen.ChatList) yield()
                }
            } catch (t: Throwable) {
                println("DIAG status=${model.status} connected=${model.connected} " +
                    "coreVersion=${model.coreVersion} chats=${model.chats.size}")
                println("DIAG requests=" + transport.requests.joinToString(" | "))
                throw t
            }
            assertEquals("v2.66.0", model.coreVersion)
            assertEquals("demo@example.org", model.accountAddr)
            assertEquals(1, model.chats.size)
            assertEquals("Test Chat", model.chats.first().name)
            assertEquals(2, model.chats.first().freshMessageCounter)
            // No login attempt must have happened.
            assertTrue(transport.requests.none { it.contains("\"add_account\"") })
        } finally {
            model.let { }
            scope.cancel()
        }
    }

    @Test
    fun fallsBackToLoginWhenNoConfiguredAccount() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"isConfigured":false}""",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-login-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(10_000) {
                while (!model.connected) yield()
            }
            // Give resumeSession a beat to settle, then assert we stayed on Login.
            withTimeout(2_000) { while (true) yield() }
        } catch (t: Throwable) {
            // expected: the settle loop times out
        } finally {
            assertEquals(AppModel.Screen.Login, model.screen)
            assertTrue(model.chats.isEmpty())
            scope.cancel()
        }
    }
}
