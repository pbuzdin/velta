package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #223 chat paging: opening a chat fetches only the LAST window of message
 * ids; scrolling near the older end fetches the page before it; a reload
 * preserves the wider window the user already pulled in.
 */
class ChatPagingTest {

    private val totalMessages = AppModel.MESSAGE_PAGE_SIZE + 105 // forces a second page

    private fun allIds(): String = (1..totalMessages).joinToString(",", "[", "]")

    private fun allMessages(): String {
        val entries = (1..totalMessages).joinToString(",") { n ->
            """"$n":{"kind":"message","id":$n,"chatId":5,"fromId":2,"text":"m$n","viewType":"Text","state":16,"timestamp":${1_700_000_000 + n}}"""
        }
        return "{$entries}"
    }

    private fun scriptedPlatform(transport: RpcTransport): CorePlatform = object : CorePlatform {
        override fun accountsDir(): String = "/tmp/velta-kmp-paging-test"
        override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
    }

    /** Params array of the Nth get_messages request. */
    private fun windowOf(transport: ScriptedRpcTransport, nth: Int): List<Long> {
        val line = transport.requests.filter { "\"get_messages\"" in it }[nth]
        val params = Json.parseToJsonElement(line).jsonObject["params"]!!.jsonArray
        return params[1].jsonArray.map { it.jsonPrimitive.content.toLong() }
    }

    private suspend fun awaitRequests(transport: ScriptedRpcTransport, method: String, count: Int) {
        withTimeout(10_000) {
            while (transport.requests.count { "\"$method\"" in it } < count) yield()
        }
    }

    /** Waits until the model STATE settles — a sent request is not a processed
     * response, and the load* paths flip state only after decoding. */
    private suspend fun awaitState(condition: () -> Boolean) {
        withTimeout(10_000) {
            while (!condition()) yield()
        }
    }

    @Test
    fun chatOpensOnLastPageAndLoadOlderFetchesTheRest() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[5]",
                "get_chatlist_items_by_entries" to
                    """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
                "select_account" to "null",
                "start_io_for_all_accounts" to "null",
                "get_message_ids" to allIds(),
                "get_messages" to allMessages(),
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(transport), scope)
        try {
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList) yield() }
            model.openChat(model.chats.first())
            withTimeout(10_000) { while (model.screen !is AppModel.Screen.Chat) yield() }

            awaitRequests(transport, "get_messages", 1)
            awaitState { model.hasMoreMessages } // open page processed
            val firstWindow = windowOf(transport, 0)
            assertEquals(AppModel.MESSAGE_PAGE_SIZE, firstWindow.size, "open must fetch the LAST page only")
            assertEquals(totalMessages.toLong(), firstWindow.last(), "the window must cover the NEWEST ids")
            assertEquals((totalMessages - AppModel.MESSAGE_PAGE_SIZE + 1).toLong(), firstWindow.first())
            assertTrue(model.hasMoreMessages, "older pages must be announced")

            model.loadOlderMessages()
            awaitRequests(transport, "get_messages", 2)
            awaitState { !model.hasMoreMessages } // older page processed
            val secondWindow = windowOf(transport, 1)
            assertEquals(totalMessages - AppModel.MESSAGE_PAGE_SIZE, secondWindow.size, "the remainder is one page")
            assertEquals(1L, secondWindow.first())
            assertFalse(model.hasMoreMessages, "nothing older than page one")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun reloadAfterNewMessageKeepsTheLoadedWindow() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"demo@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[5]",
                "get_chatlist_items_by_entries" to
                    """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
                "select_account" to "null",
                "start_io_for_all_accounts" to "null",
                "get_message_ids" to allIds(),
                "get_messages" to allMessages(),
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(transport), scope)
        try {
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList) yield() }
            model.openChat(model.chats.first())
            withTimeout(10_000) { while (model.screen !is AppModel.Screen.Chat) yield() }
            awaitRequests(transport, "get_messages", 1)
            awaitState { model.hasMoreMessages }
            val openWindowTop = windowOf(transport, 0).first()
            model.loadOlderMessages()
            awaitRequests(transport, "get_messages", 2)
            awaitState { !model.hasMoreMessages }

            // Re-opening the SAME chat must NOT shrink the window back to the
            // last page — the user already pulled the older history in.
            model.openChat(model.chats.first())
            awaitRequests(transport, "get_messages", 3)
            awaitState { model.chatMessages.isNotEmpty() && model.chatMessages.size == totalMessages }
            assertTrue(model.hasMoreMessages, "the preserved window still has older pages")
            assertEquals(
                openWindowTop,
                windowOf(transport, 2).first(),
                "reload must keep fetching from the preserved window top",
            )
        } finally {
            scope.cancel()
        }
    }
}
