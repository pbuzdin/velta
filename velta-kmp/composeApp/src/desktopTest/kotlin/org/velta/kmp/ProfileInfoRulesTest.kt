package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.commonCandidates
import org.velta.kmp.ui.formatStorageBytes
import org.velta.kmp.ui.showsChatsInCommon
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #358 C: profile Storage row and Chats in common. */
class ProfileInfoRulesTest {

    @Test
    fun bytesAndWhoSeesTheCommonRow() {
        assertEquals("0 B", formatStorageBytes(0))
        assertEquals("2.1 KB", formatStorageBytes(100 + 2048))
        assertEquals("1.0 MB", formatStorageBytes(1_048_576))
        assertTrue(showsChatsInCommon("single", 7))
        assertTrue(showsChatsInCommon("saved", 1))
        assertFalse(showsChatsInCommon("group", 7))
        assertFalse(showsChatsInCommon("channel", 7))
        assertFalse(showsChatsInCommon("single", null))
        val listed = listOf(
            ChatListItem(id = 5, name = "Ada", chatType = "Single"),
            ChatListItem(id = 10, name = "Crew", chatType = "Group"),
            ChatListItem(id = 11, name = "News", chatType = "OutBroadcast"),
        )
        assertEquals(listOf(10L, 11L), commonCandidates(listed).map { it.id })
    }

    @Test
    fun storageSumsBytesAndCommonWaitsForTheRow() {
        val t = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"a@relay.example.dev","isConfigured":true}""",
                "get_all_accounts" to """[{"id":1,"addr":"a@relay.example.dev","isConfigured":true}]""",
                "select_account" to "null",
                "start_io_for_all_accounts" to "null",
                "get_chatlist_entries" to "[5,10,11]",
                "get_chatlist_items_by_entries" to """{"5":{"kind":"ChatListItem","id":5,"name":"Ada","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0,"chatType":"Single"},"10":{"kind":"ChatListItem","id":10,"name":"Crew","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0,"chatType":"Group","isGroup":true},"11":{"kind":"ChatListItem","id":11,"name":"News","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0,"chatType":"OutBroadcast","isGroup":true}}""",
                "get_full_chat_by_id" to """{"id":5,"name":"Ada","chatType":"Single","contactIds":[7],"canSend":true}""",
                "get_contact" to """{"id":7,"name":"Ada","displayName":"Ada","address":"ada@relay.example.dev","color":"#5aa2e6"}""",
                "get_contact_encryption_info" to "\"\"",
                "get_chat_media" to "[]",
                "get_chat_contacts" to "[7]",
                "get_message_ids" to "[10,11]",
                "get_messages" to """{"10":{"kind":"message","id":10,"fileBytes":100},"11":{"kind":"message","id":11,"fileBytes":2048}}""",
                "list_transports" to """[{"addr":"a@relay.example.dev"}]""",
                "get_server_metadata" to "{}",
            ),
        )
        run(t) { m ->
            m.openProfile(5, "Ada")
            until { m.profile?.contactId == 7L && m.storageText == "2.1 KB" }
            assertFalse(contactCall(t, 10), t.requests.toString())
            assertFalse(contactCall(t, 11), t.requests.toString())
            m.loadChatsInCommon()
            until { m.commonChats?.map { it.id } == listOf(10L, 11L) }
            assertEquals("(2)", m.commonCount)
            assertTrue(contactCall(t, 10))
            assertTrue(contactCall(t, 11))
        }
    }

    private fun contactCall(t: ScriptedRpcTransport, chatId: Long) =
        t.requests.any { "\"get_chat_contacts\"" in it && ",$chatId]" in it }

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, block: suspend (AppModel) -> Unit) = runBlocking {
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-profile-info-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = t
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.connect()
            until { model.screen == AppModel.Screen.ChatList && model.chats.size == 3 }
            block(model)
        } finally {
            scope.cancel()
        }
    }
}
