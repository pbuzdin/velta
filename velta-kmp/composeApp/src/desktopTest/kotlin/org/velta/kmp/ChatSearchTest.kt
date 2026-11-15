package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.velta.kmp.core.Contact
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.JumpPlan
import org.velta.kmp.ui.jumpPlan
import org.velta.kmp.ui.searchHitName
import org.velta.kmp.ui.searchHitText
import org.velta.kmp.ui.searchPage
import org.velta.kmp.ui.searchQuery
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #334 step 11: stable's "Search in chat" and jump-to-message. */
class ChatSearchTest {

    @Test
    fun queryAndPageRules() {
        assertNull(searchQuery(" a "))
        assertEquals("hello", searchQuery("  HeLLo "))
        assertEquals(listOf(5L, 4L), searchPage(listOf(1L, 2L, 3L, 4L, 5L), limit = 2))
        assertEquals((70L downTo 41L).toList(), searchPage((1L..70L).toList()))
        val m = MessageObject(text = "x".repeat(100), sender = Contact(name = "Ann", displayName = "Ann B"))
        assertEquals("Ann B", searchHitName(m))
        assertEquals("Bot", searchHitName(m.copy(overrideSenderName = "Bot")))
        assertEquals(80, searchHitText(m).length)
    }

    @Test
    fun jumpPlanMatchesStableLimits() {
        val ids = (1L..3000L).toList()
        assertEquals(JumpPlan.Gone, jumpPlan(ids, 2800, 9999))
        assertEquals(JumpPlan.Loaded, jumpPlan(ids, 2800, 2900))
        assertEquals(JumpPlan.LoadFrom(2480), jumpPlan(ids, 2800, 2501))
    }

    @Test
    fun jumpTooFarAndNearStart() {
        val ids = (1L..3000L).toList()
        assertEquals(JumpPlan.TooFar, jumpPlan(ids, 2800, 5))
        assertEquals(JumpPlan.LoadFrom(0), jumpPlan((1L..300L).toList(), 100, 5))
    }

    private fun transport(extra: Map<String, String> = emptyMap()) = ScriptedRpcTransport(
        mapOf(
            "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
            "get_all_account_ids" to "[1]",
            "get_selected_account_id" to "1",
            "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
            "get_all_accounts" to """[{"id":1,"addr":"a@example.org","isConfigured":true}]""",
            "select_account" to "null",
            "start_io_for_all_accounts" to "null",
            "get_chatlist_entries" to "[5]",
            "get_chatlist_items_by_entries" to
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
            "get_message_ids" to "[" + (1..300).joinToString(",") + "]",
            "get_messages" to
                """{"250":{"kind":"message","id":250,"chatId":5,"text":"newest hello","timestamp":250},"40":{"kind":"message","id":40,"chatId":5,"text":"old hello","timestamp":40,"sender":{"name":"Ann","displayName":"Ann"}}}""",
            "misc_set_draft" to "null",
            "remove_draft" to "null",
            "list_transports" to """[{"addr":"a@example.org"}]""",
            "get_server_metadata" to "{}",
            "misc_get_stickers" to "{}",
            "search_messages" to "[40,250]",
        ) + extra,
    )

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, block: suspend (AppModel) -> Unit) = runBlocking {
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-search-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = t
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.connect()
            until { model.screen == AppModel.Screen.ChatList && model.chats.isNotEmpty() }
            model.openChat(model.chats.first())
            until { model.screen is AppModel.Screen.Chat && model.chatMessages.isNotEmpty() }
            block(model)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun searchListsNewestFirstAndAHitJumpsIntoHistory() {
        val t = transport()
        run(t) { m ->
            m.openChatSearch()
            assertTrue(m.chatSearchOpen)
            m.searchInChat("h") // too short: nothing runs
            delay(400)
            assertNull(m.chatSearchHits)
            assertFalse(t.requests.any { "\"search_messages\"" in it })
            m.searchInChat("Hello")
            until { m.chatSearchHits != null }
            val line = t.requests.first { "\"search_messages\"" in it }
            assertTrue(line.contains("""[1,"hello",5]"""), line)
            assertEquals(listOf(250L, 40L), m.chatSearchHits!!.map { it.id })
            m.pickSearchHit(m.chatSearchHits!![1])
            assertFalse(m.chatSearchOpen)
            until { m.flashMsgId == 40L }
            assertEquals(40L, m.pendingJumpToId)
            // id 30 sits before the loaded window (the newest 200 of 300):
            // history down to it (plus 20 above) loads first.
            val before = t.requests.size
            m.jumpToMessage(30)
            until { m.flashMsgId == 30L }
            val load = t.requests.drop(before).last { "\"get_messages\"" in it }
            assertTrue(load.contains("[10,11,"), load)
            assertTrue(m.hasMoreMessages)
        }
    }

    @Test
    fun hashtagPrefillsAndAGoneMessageToasts() {
        run(transport()) { m ->
            m.openChatSearch("#velta")
            assertEquals("#velta", m.chatSearchQuery)
            m.closeChatSearch()
            m.jumpToMessage(9999)
            until { m.toast != null }
            assertEquals("Message is no longer in this chat's history", m.toast)
        }
    }

    @Test
    fun searchErrorIsShown() {
        run(transport(mapOf("search_messages" to "ERROR:fts broke"))) { m ->
            m.openChatSearch("hello")
            until { m.chatSearchError != null }
            assertTrue(m.chatSearchError!!.contains("fts broke"))
            assertFalse(m.chatSearchBusy)
        }
    }
}
