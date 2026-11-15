package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.contactRequestConfirm
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #334 step 6: contact requests follow stable app.js openChat — a
 *  confirm (Cancel / Accept) instead of opening, accept_chat on Accept. */
class ContactRequestTest {

    @Test
    fun confirmMatchesStable() {
        val spec = contactRequestConfirm("Bob")
        assertEquals("Contact request", spec.title)
        assertEquals("\"{name}\" wants to start a conversation with you. Accept it to read the messages and reply.", spec.text)
        assertEquals("Accept", spec.ok)
        assertFalse(spec.danger)
        assertEquals(mapOf("name" to "Bob"), spec.args)
        assertEquals(mapOf("name" to "?"), contactRequestConfirm("").args)
    }

    private fun scriptedPlatform(transport: RpcTransport): CorePlatform = object : CorePlatform {
        override fun accountsDir(): String = "/tmp/velta-kmp-creq-test"
        override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
    }

    private fun transport() = ScriptedRpcTransport(
        mapOf(
            "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
            "get_all_account_ids" to "[1]",
            "get_selected_account_id" to "1",
            "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
            "select_account" to "null",
            "start_io_for_all_accounts" to "null",
            "get_chatlist_entries" to "[12]",
            "get_chatlist_items_by_entries" to
                """{"12":{"kind":"ChatListItem","id":12,"name":"Bob","chatType":"Single","summaryText2":"hi","lastUpdated":1,"freshMessageCounter":1,"isContactRequest":true}}""",
            "get_message_ids" to "[]",
            "accept_chat" to "null",
            "marknoticed_chat" to "null",
        ),
    )

    private suspend fun ready(model: AppModel) {
        model.connect()
        withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || model.chats.isEmpty()) yield() }
    }

    @Test
    fun tapAsksAndCancelKeepsTheRequest() = runBlocking {
        val t = transport()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(t), scope)
        try {
            ready(model)
            model.openChat(model.chats.first())
            assertEquals("Accept", model.chatConfirm?.spec?.ok)
            assertEquals(AppModel.Screen.ChatList, model.screen, "a request does not open")
            model.answerChatConfirm(false)
            delay(300)
            assertTrue(t.requests.none { "\"accept_chat\"" in it })
            assertEquals(AppModel.Screen.ChatList, model.screen)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun acceptCallsCoreThenOpensTheChat() = runBlocking {
        val t = transport()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(t), scope)
        try {
            ready(model)
            model.openChat(model.chats.first())
            model.answerChatConfirm(true)
            withTimeout(10_000) { while (model.screen !is AppModel.Screen.Chat) yield() }
            assertTrue(t.requests.first { "\"accept_chat\"" in it }.contains("[1,12]"))
            assertEquals(12L, (model.screen as AppModel.Screen.Chat).chatId)
            assertEquals(null, model.chatConfirm)
        } finally {
            scope.cancel()
        }
    }
}
