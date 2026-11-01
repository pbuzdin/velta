package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * P3 write path: the composer drives `misc_set_draft` → `misc_send_draft`,
 * clears the composer, and quotes ride `quotedMessageId`.
 */
class SendFlowTest {

    private fun scriptedPlatform(transport: RpcTransport): CorePlatform = object : CorePlatform {
        override fun accountsDir(): String = "/tmp/velta-kmp-send-test"
        override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
    }

    private suspend fun openTestChat(model: AppModel) {
        model.connect()
        withTimeout(10_000) {
            while (model.screen != AppModel.Screen.ChatList) yield()
        }
        model.openChat(model.chats.first())
        withTimeout(10_000) {
            while (model.screen !is AppModel.Screen.Chat) yield()
        }
    }

    @Test
    fun sendFlowSetsDraftThenSendsAndClearsComposer() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[5]",
                "get_chatlist_items_by_entries" to
                    """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
                "get_message_ids" to "[]",
                "misc_set_draft" to "null",
                "misc_send_draft" to "null",
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(transport), scope)
        try {
            openTestChat(model)

            model.composerText = "  hello kmp  "
            model.send()
            withTimeout(10_000) {
                while (transport.requests.none { "\"misc_send_draft\"" in it }) yield()
            }

            assertEquals("", model.composerText, "composer clears on send")
            val setDraft = transport.requests.first { "\"misc_set_draft\"" in it }
            assertTrue(
                setDraft.contains("""[1,5,"hello kmp",null,null,null,null]"""),
                "set_draft must carry trimmed text, no quote: $setDraft",
            )
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun quotedSendRidesQuotedMessageId() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[5]",
                "get_chatlist_items_by_entries" to
                    """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
                "get_message_ids" to "[]",
                "misc_set_draft" to "null",
                "misc_send_draft" to "null",
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(transport), scope)
        try {
            openTestChat(model)

            model.replyTo = MessageObject(id = 9, text = "the quoted one")
            model.composerText = "reply text"
            model.send()
            withTimeout(10_000) {
                while (transport.requests.none { "\"misc_send_draft\"" in it }) yield()
            }

            assertEquals(null, model.replyTo, "reply state clears on send")
            val setDraft = transport.requests.first { "\"misc_set_draft\"" in it }
            assertTrue(
                setDraft.contains("""[1,5,"reply text",null,null,9,null]"""),
                "set_draft must carry quotedMessageId=9: $setDraft",
            )
        } finally {
            scope.cancel()
        }
    }
}
