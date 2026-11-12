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
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * P4 relay cards: `list_transports` (primary first, quilt #11) merged with
 * `get_server_metadata` (#15) by address; missing metadata = "not known yet".
 */
class RelaysTest {

    @Test
    fun relayCardsMergeTransportsWithMetadata() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "select_account" to "null",
                "start_io_for_all_accounts" to "null",
                "get_chatlist_entries" to "[]",
                "list_transports" to
                    """[{"addr":"primary@example.org","imapServer":"imap.primary.example"},{"addr":"second@other.example"}]""",
                "get_server_metadata" to
                    """{"primary@example.org":{"hasTurn":true,"irohRelay":"https://iroh.primary.example","supportsPush":true,"canIdle":true,"maxSmtpRcptTo":50,"comment":"friendly relay","admin":"ops@primary.example"}}""",
                "delete_transport" to "null",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-relays-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.connect()
            try {
                withTimeout(10_000) {
                    while (model.screen != AppModel.Screen.ChatList) yield()
                }
            } catch (t: Throwable) {
                println("DIAG1 status=${model.status} connected=${model.connected} reqs=${transport.requests.joinToString(" | ")}")
                throw t
            }
            model.openRelays()
            try {
                withTimeout(10_000) {
                    while (model.relays.size < 2) yield()
                }
            } catch (t: Throwable) {
                println("DIAG2 status=${model.status} relays=${model.relays.size} reqs=${transport.requests.joinToString(" | ")}")
                throw t
            }

            // Quilt #11: the sending transport comes first.
            assertEquals("primary@example.org", model.relays[0].addr)
            assertEquals(true, model.relays[0].metadata?.hasTurn)
            assertEquals("friendly relay", model.relays[0].metadata?.comment)
            assertEquals(50L, model.relays[0].metadata?.maxSmtpRcptTo)
            // No metadata for the second relay → every flag "not known yet".
            assertEquals("second@other.example", model.relays[1].addr)
            assertNull(model.relays[1].metadata)

            model.removeRelay("second@other.example")
            withTimeout(10_000) {
                while (true) {
                    val deletedIdx = transport.requests
                        .indexOfFirst { "\"delete_transport\"" in it && "second@other.example" in it }
                    if (deletedIdx >= 0 &&
                        transport.requests
                            .drop(deletedIdx + 1)
                            .any { "\"list_transports\"" in it }
                    ) {
                        break
                    }
                    yield()
                }
            }
            val deleteLine = transport.requests.first { "\"delete_transport\"" in it }
            assertTrue(deleteLine.contains("""[1,"second@other.example"]"""), "delete params: $deleteLine")
        } finally {
            scope.cancel()
        }
    }
}
