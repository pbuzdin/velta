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

    @Test
    fun sendReloadsMessagesImmediately() = runBlocking {
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

            model.composerText = "ping"
            model.send()
            // The message is in the db the moment send_draft returns — the
            // reload must be requested AFTER the send, not wait for events.
            withTimeout(10_000) {
                while (true) {
                    val sentIdx = transport.requests.indexOfFirst { "\"misc_send_draft\"" in it }
                    if (sentIdx >= 0 &&
                        transport.requests
                            .drop(sentIdx + 1)
                            .any { "\"get_message_ids\"" in it }
                    ) {
                        break
                    }
                    yield()
                }
            }
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun attachmentSendCarriesFileAndFilename() = runBlocking {
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

            // The platform "picked" a file; the core dedups it into the blobdir.
            model.onAttachmentPicked("/tmp/pic.png", "pic.png")
            assertEquals("/tmp/pic.png", model.pendingAttachment?.first)
            model.send()
            withTimeout(10_000) {
                while (transport.requests.none { "\"misc_send_draft\"" in it }) yield()
            }
            // The request line can appear before the coroutine resumes and
            // clears the state — wait for the state, don't race it.
            withTimeout(10_000) {
                while (model.pendingAttachment != null) yield()
            }
            val setDraft = transport.requests.first { "\"misc_set_draft\"" in it }
            assertTrue(
                setDraft.contains("""[1,5,"","/tmp/pic.png","pic.png",null,null]"""),
                "set_draft must carry empty caption + file + filename: $setDraft",
            )
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun draftRestoreRestoresTextAndQuote() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[5]",
                "get_chatlist_items_by_entries" to
                    """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
                "get_message_ids" to "[]",
                "get_draft" to """{"text":"saved draft","quotedMessageId":42}""",
                "get_messages" to
                    """{"42":{"kind":"message","id":42,"chatId":5,"fromId":5,"text":"the quoted msg","state":13}}""",
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(transport), scope)
        try {
            openTestChat(model)
            withTimeout(10_000) {
                while (model.composerText != "saved draft" || model.replyTo?.id != 42L) yield()
            }
            assertEquals("saved draft", model.composerText)
            assertEquals("the quoted msg", model.replyTo?.text)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun reactSendsReactionArray() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[5]",
                "get_chatlist_items_by_entries" to
                    """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
                "get_message_ids" to "[]",
                "send_reaction" to "null",
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(transport), scope)
        try {
            openTestChat(model)

            model.react(MessageObject(id = 33, text = "target"), "👍")
            withTimeout(10_000) {
                while (transport.requests.none { "\"send_reaction\"" in it }) yield()
            }

            assertEquals(null, model.messageActions, "action bar closes after reacting")
            val line = transport.requests.first { "\"send_reaction\"" in it }
            assertTrue(line.contains("""[1,33,["👍"]]"""), "reaction params must be [account, message, [emoji]]: $line")
        } finally {
            scope.cancel()
        }
    }
}
