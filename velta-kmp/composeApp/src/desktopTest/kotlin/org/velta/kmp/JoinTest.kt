package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** P4 invite/join: check_qr parses offline; join() routes by kind. */
class JoinTest {

    private fun testScope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private suspend fun awaitRequest(transport: ScriptedRpcTransport, method: String) {
        withTimeout(10_000) {
            while (transport.requests.none { "\"$method\"" in it }) yield()
        }
    }

    @Test
    fun accountInviteOnboardsTransport() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.69.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"isConfigured":false}""",
                "get_chatlist_entries" to "[]",
                "check_qr" to """{"kind":"account","domain":"relay.example"}""",
                "add_account" to "9",
                "list_transports" to "[]",
                "get_server_metadata" to "{}",
                "add_transport_from_qr" to "null",
                "start_io_for_all_accounts" to "null",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-join-account-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            // The screen starts as Login — wait until resume actually ran
            // (status settles at "connected" on the no-configured-account path)
            // or the Join flow races the resume and takes the add_account path.
            withTimeout(10_000) {
                while (model.status != "connected") yield()
            }
            model.screen = AppModel.Screen.Join
            model.joinText = "DCACCOUNT:https://relay.example/i/tok"
            model.checkJoin()
            withTimeout(10_000) {
                while (model.joinChecked == null) yield()
            }
            assertEquals("account", model.joinChecked?.kind)

            model.join()
            try {
                withTimeout(10_000) {
                    while (model.screen != AppModel.Screen.ChatList) yield()
                }
            } catch (t: Throwable) {
                println("DIAG joinError=${model.joinError} status=${model.status} reqs=${transport.requests.joinToString(" | ")}")
                throw t
            }
            awaitRequest(transport, "add_transport_from_qr")
            // Reusing the leftover unconfigured id must stick, or the relays
            // screen (and every other accountId reader) no-ops.
            assertEquals(1L, model.accountId)
            val addLine = transport.requests.first { "\"add_transport_from_qr\"" in it }
            assertTrue(addLine.contains("[1,\"DCACCOUNT:https://relay.example/i/tok\"]"), "add params: $addLine")
            // The legacy configure() RPC must NOT be called: in core 2.69's
            // multi-transport world it loads old-style addr/mail_pw configs
            // the QR flow never sets and fails "missing email address";
            // add_transport_from_qr already configures (transports table)
            // and restarts I/O itself.
            assertTrue(
                transport.requests.none { "\"configure\"" in it },
                "legacy configure() must not be called",
            )
        } finally {
            scope.cancel()
        }
    }

    /** Re-scanning an invite for a relay the account is ALREADY on must skip
     * entirely — no delete (which once errored on the only transport), no
     * re-add, no duplicate stacking; straight back to the chat list. */
    @Test
    fun repeatJoinSkipsAlreadyConnectedRelay() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.69.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"isConfigured":false}""",
                "get_chatlist_entries" to "[]",
                "check_qr" to """{"kind":"account","domain":"relay.example"}""",
                "add_account" to "9",
                "list_transports" to """[{"addr":"relay.example","imapServer":"relay.example","smtpServer":"relay.example"}]""",
                "get_server_metadata" to "{}",
                "get_account_info" to """{"id":1,"isConfigured":false}""",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-join-skip-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(10_000) {
                while (model.status != "connected") yield()
            }
            model.screen = AppModel.Screen.Join
            model.joinText = "DCACCOUNT:https://relay.example/i/tok"
            model.checkJoin()
            withTimeout(10_000) {
                while (model.joinChecked == null) yield()
            }
            model.join()
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }
            withTimeout(10_000) { while (transport.requests.none { "\"get_account_info\"" in it }) yield() }
            assertTrue(
                transport.requests.none { "\"delete_transport\"" in it },
                "an already-connected relay must not be deleted; reqs=${transport.requests}",
            )
            assertTrue(
                transport.requests.none { "\"add_transport_from_qr\"" in it },
                "an already-connected relay must not be re-added; reqs=${transport.requests}",
            )
        } finally {
            scope.cancel()
        }
    }

    /** The relay cap is not a dead end: the error routes to the Relays screen
     * with the reason attached, where a slot can be freed. */
    @Test
    fun maxRelaysErrorRoutesToRelaysScreen() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.69.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"isConfigured":false}""",
                "get_chatlist_entries" to "[]",
                "check_qr" to """{"kind":"account","domain":"relay.example"}""",
                "add_account" to "9",
                "list_transports" to "[]",
                "get_server_metadata" to "{}",
                "add_transport_from_qr" to "ERROR:You have reached the maximum number of relays (5)",
                "start_io_for_all_accounts" to "null",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-join-cap-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(10_000) {
                while (model.status != "connected") yield()
            }
            model.screen = AppModel.Screen.Join
            model.joinText = "DCACCOUNT:https://relay.example/i/tok"
            model.checkJoin()
            withTimeout(10_000) {
                while (model.joinChecked == null) yield()
            }
            model.join()
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.Relays) yield()
            }
            assertTrue(model.joinError!!.contains("maximum number of relays"), "joinError: ${model.joinError}")
            assertTrue(model.relaysNotice!!.contains("maximum number of relays"), "notice: ${model.relaysNotice}")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun secureJoinRoutesToSecureJoinRpc() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "select_account" to "null",
                "start_io_for_all_accounts" to "null",
                "get_chatlist_entries" to "[]",
                "check_qr" to """{"kind":"askVerifyGroup","grpname":"Test Group","contactId":7}""",
                "secure_join" to "42",
                "start_io_for_all_accounts" to "null",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-join-secure-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }
            model.screen = AppModel.Screen.Join
            model.joinText = "DCJOIN:example/0000aaaa"
            model.checkJoin()
            withTimeout(10_000) {
                while (model.joinChecked == null) yield()
            }
            assertEquals("askVerifyGroup", model.joinChecked?.kind)
            assertEquals("Test Group", model.joinChecked?.grpname)

            model.join()
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }
            awaitRequest(transport, "secure_join")
            val line = transport.requests.first { "\"secure_join\"" in it }
            assertTrue(line.contains("""[1,"DCJOIN:example/0000aaaa"]"""), "secure_join params: $line")
        } finally {
            scope.cancel()
        }
    }
}
