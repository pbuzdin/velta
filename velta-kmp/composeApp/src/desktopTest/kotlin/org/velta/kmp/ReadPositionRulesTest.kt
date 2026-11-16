package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.JUMP_MAX_MESSAGES
import org.velta.kmp.ui.OpenScroll
import org.velta.kmp.ui.goDownBadge
import org.velta.kmp.ui.nearBottom
import org.velta.kmp.ui.openScrollFor
import org.velta.kmp.ui.openWindowFrom
import org.velta.kmp.ui.rowCountsAsSeen
import org.velta.kmp.ui.seenThrough
import org.velta.kmp.ui.unreadLineId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #358 B: stable chat-view.js read position + go-down. */
class ReadPositionRulesTest {

    @Test
    fun openPositionFollowsUnreadState() {
        assertEquals(OpenScroll.Bottom, openScrollFor(0, 42))
        assertEquals(OpenScroll.Bottom, openScrollFor(3, null))
        assertEquals(OpenScroll.Unread(42), openScrollFor(3, 42))
    }

    @Test
    fun windowWidensBackToTheAnchorWithContext() {
        val ids = (1L..500L).toList()
        // Tail = ids[300..]; anchor well inside it: tail.
        assertEquals(300, openWindowFrom(ids, 200, 400))
        // Anchor near the window top: 10 rows of context above it.
        assertEquals(295, openWindowFrom(ids, 200, 306))
        // Anchor before the tail: load from 10 above it.
        assertEquals(90, openWindowFrom(ids, 200, 101))
        assertEquals(0, openWindowFrom(ids, 200, 3))
        // Unknown / no anchor: tail.
        assertEquals(300, openWindowFrom(ids, 200, 9999))
        assertEquals(300, openWindowFrom(ids, 200, null))
        // Further back than the jump cap: the window stops at the cap.
        val big = (1L..5000L).toList()
        assertEquals(5000 - JUMP_MAX_MESSAGES, openWindowFrom(big, 200, 10))
    }

    @Test
    fun unreadLineFallsBackToTheFirstLoadedUnread() {
        assertEquals(7L, unreadLineId(7, listOf(9, 10)))
        assertEquals(9L, unreadLineId(null, listOf(9, 10)))
        assertNull(unreadLineId(null, emptyList()))
    }

    @Test
    fun seenWatermarkMatchesCheckSeen() {
        // fully on screen (2px slack)
        assertTrue(rowCountsAsSeen(100, 200, 0, 1000))
        assertTrue(rowCountsAsSeen(900, 1001, 0, 1000))
        // cut at the bottom, top in the lower half: not yet
        assertFalse(rowCountsAsSeen(800, 1200, 0, 1000))
        // tall row starting in the upper half: seen
        assertTrue(rowCountsAsSeen(400, 2400, 0, 1000))
        // outside the viewport
        assertFalse(rowCountsAsSeen(1000, 1100, 0, 1000))
        assertFalse(rowCountsAsSeen(-200, 0, 0, 1000))
        assertEquals(listOf(1L, 2L, 3L), seenThrough(listOf(1, 2, 3, 4), 3))
        assertEquals(emptyList(), seenThrough(listOf(1, 2, 3), null))
        assertEquals(emptyList(), seenThrough(listOf(1, 2, 3), 99))
    }

    @Test
    fun goDownRules() {
        assertTrue(nearBottom(9, 10, 100))
        assertFalse(nearBottom(9, 10, 220))
        assertFalse(nearBottom(7, 10, 0))
        assertTrue(nearBottom(-1, 0, 0))
        assertNull(goDownBadge(0))
        assertEquals("5", goDownBadge(5))
        assertEquals("999", goDownBadge(999))
        assertEquals("999+", goDownBadge(1000))
    }

    // ---- model flow over the scripted transport ----

    private fun transport(unread: Int, firstUnread: String) = ScriptedRpcTransport(
        mapOf(
            "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
            "get_all_account_ids" to "[1]",
            "get_selected_account_id" to "1",
            "get_account_info" to """{"id":1,"addr":"a@relay.example.dev","isConfigured":true}""",
            "get_all_accounts" to """[{"id":1,"addr":"a@relay.example.dev","isConfigured":true}]""",
            "select_account" to "null",
            "start_io_for_all_accounts" to "null",
            "get_chatlist_entries" to "[5]",
            "get_chatlist_items_by_entries" to
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":$unread}}""",
            "get_message_ids" to "[" + (1..300).joinToString(",") + "]",
            "get_messages" to
                """{"50":{"kind":"message","id":50,"chatId":5,"fromId":7,"text":"first unread","timestamp":50,"state":10},"51":{"kind":"message","id":51,"chatId":5,"fromId":7,"text":"second","timestamp":51,"state":10},"300":{"kind":"message","id":300,"chatId":5,"fromId":1,"text":"mine","timestamp":300,"state":26}}""",
            "misc_set_draft" to "null",
            "remove_draft" to "null",
            "list_transports" to """[{"addr":"a@relay.example.dev"}]""",
            "get_server_metadata" to "{}",
            "misc_get_stickers" to "{}",
            "marknoticed_chat" to "null",
            "markseen_msgs" to "null",
            "get_first_unread_message_of_chat" to firstUnread,
        ),
    )

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, block: suspend (AppModel) -> Unit) = runBlocking {
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-readpos-test"
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
    fun unreadChatOpensAtTheFirstUnreadAndTheBadgeDrains() {
        val t = transport(unread = 2, firstUnread = "50")
        run(t) { m ->
            assertTrue(t.requests.any { "\"get_first_unread_message_of_chat\"" in it && "[1,5]" in it })
            // id 50 sits before the newest-200 window (101..300): load from 40.
            val load = t.requests.last { "\"get_messages\"" in it }
            assertTrue(load.contains("[40,41,"), load)
            assertEquals(50L, m.unreadLineId)
            assertEquals(OpenScroll.Unread(50), m.openScroll)
            assertEquals(2, m.goDownCount)
            m.onMessagesVisible(listOf(50))
            until { t.requests.any { "\"markseen_msgs\"" in it } }
            assertEquals(1, m.goDownCount)
            m.catchUp()
            assertEquals(0, m.goDownCount)
            until { t.requests.count { "\"marknoticed_chat\"" in it } >= 2 }
            // Caught-up rows send no read receipts afterwards.
            val seenBefore = t.requests.count { "\"markseen_msgs\"" in it }
            m.onMessagesVisible(listOf(51))
            delay(200)
            assertEquals(seenBefore, t.requests.count { "\"markseen_msgs\"" in it })
        }
    }

    @Test
    fun readChatOpensAtTheBottomWithoutAskingTheCore() {
        val t = transport(unread = 0, firstUnread = "50")
        run(t) { m ->
            assertFalse(t.requests.any { "\"get_first_unread_message_of_chat\"" in it })
            assertEquals(OpenScroll.Bottom, m.openScroll)
            // stable fallback: the first loaded unread row still gets the line.
            assertEquals(50L, m.unreadLineId)
        }
    }
}
