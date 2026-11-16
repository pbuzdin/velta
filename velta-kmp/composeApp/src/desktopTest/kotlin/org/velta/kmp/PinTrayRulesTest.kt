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
import org.velta.kmp.ui.PinRow
import org.velta.kmp.ui.SheetChat
import org.velta.kmp.ui.canUnpinInTray
import org.velta.kmp.ui.pinSenderName
import org.velta.kmp.ui.pinSnippet
import org.velta.kmp.ui.pinTrayOf
import org.velta.kmp.ui.pinTrayRefreshes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #358 B: stable chat-view.js `_refreshPinnedBar` (pin tray). */
class PinTrayRulesTest {

    private val ann = Contact(id = 7, name = "ann", displayName = "Ann B", address = "ann@relay.example.dev")

    @Test
    fun snippetMatchesStable() {
        assertEquals("x".repeat(60), pinSnippet(MessageObject(text = "x".repeat(100))))
        assertEquals("image", pinSnippet(MessageObject(viewType = "Gif")))
        assertEquals("voice", pinSnippet(MessageObject(viewType = "Voice")))
        assertEquals("message", pinSnippet(MessageObject(viewType = "Text")))
        assertEquals("message", pinSnippet(MessageObject(viewType = "Unknown")))
        assertEquals("caption", pinSnippet(MessageObject(viewType = "Image", text = "caption")))
    }

    @Test
    fun senderNameMatchesRpcCoreMapping() {
        assertEquals("Вы", pinSenderName(MessageObject(fromId = 1), you = "Вы"))
        assertEquals("Ann B", pinSenderName(MessageObject(fromId = 7, sender = ann)))
        assertEquals("ann", pinSenderName(MessageObject(fromId = 7, sender = ann.copy(displayName = ""))))
        assertEquals("ann@relay.example.dev", pinSenderName(MessageObject(fromId = 7, sender = ann.copy(displayName = "", name = ""))))
        assertEquals("?", pinSenderName(MessageObject(fromId = 7, sender = Contact(id = 7))))
        assertEquals("", pinSenderName(MessageObject(fromId = 7, isInfo = true, sender = ann)))
    }

    @Test
    fun trayNewestLastInCoreOrderAndCountOnlyForTwoPlus() {
        assertNull(pinTrayOf(emptyList()))
        val one = pinTrayOf(listOf(MessageObject(id = 3, fromId = 1, text = "a")))!!
        assertEquals(PinRow(3, "You", "a"), one.newest)
        assertNull(one.count)
        val three = pinTrayOf(
            listOf(
                MessageObject(id = 3, fromId = 1, text = "a"),
                MessageObject(id = 9, fromId = 7, sender = ann, text = "b"),
                MessageObject(id = 5, fromId = 7, sender = ann, viewType = "File"),
            ),
        )!!
        assertEquals(5L, three.newest.id)
        assertEquals("file", three.newest.snippet)
        assertEquals(listOf(5L, 9L, 3L), three.rows.map { it.id })
        assertEquals("3", three.count)
    }

    @Test
    fun unpinFollowsReadOnlyAndAdminCaps() {
        assertTrue(canUnpinInTray(SheetChat()))
        assertFalse(canUnpinInTray(SheetChat(readOnly = true)))
        assertFalse(canUnpinInTray(SheetChat(isGroup = true, groupAdminId = 9)))
        assertTrue(canUnpinInTray(SheetChat(isGroup = true, groupAdminId = 1)))
    }

    @Test
    fun refreshEvents() {
        assertTrue(pinTrayRefreshes("PinnedMessagesChanged"))
        assertTrue(pinTrayRefreshes("MsgsChanged"))
        assertTrue(pinTrayRefreshes("MsgDeleted"))
        assertFalse(pinTrayRefreshes("IncomingMsg"))
    }

    // ---- model flow over the scripted transport ----

    private fun transport(pins: String) = ScriptedRpcTransport(
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
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
            "get_message_ids" to "[10,11]",
            "get_messages" to
                """{"10":{"kind":"message","id":10,"chatId":5,"fromId":1,"text":"first pin","timestamp":10,"isPinned":true},"11":{"kind":"message","id":11,"chatId":5,"fromId":7,"text":"second pin","timestamp":11,"isPinned":true,"sender":{"id":7,"name":"Ann","displayName":"Ann"}}}""",
            "misc_set_draft" to "null",
            "remove_draft" to "null",
            "list_transports" to """[{"addr":"a@relay.example.dev"}]""",
            "get_server_metadata" to "{}",
            "misc_get_stickers" to "{}",
            "get_pinned_messages" to pins,
            "set_pinned_message_state" to "null",
        ),
    )

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, block: suspend (AppModel) -> Unit) = runBlocking {
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-pintray-test"
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
    fun openingAChatLoadsItsPinsAndTheTrayUnpins() {
        val t = transport("[10,11]")
        run(t) { m ->
            until { m.pinnedMessages.size == 2 }
            assertTrue(t.requests.any { "\"get_pinned_messages\"" in it && "[1,5]" in it })
            val tray = pinTrayOf(m.pinnedMessages)!!
            assertEquals("Ann", tray.newest.name)
            assertEquals("2", tray.count)
            m.pinTrayOpen = true
            m.openPinned(10)
            assertFalse(m.pinTrayOpen)
            until { m.flashMsgId == 10L }
            m.unpinFromTray(11)
            until { t.requests.any { "\"set_pinned_message_state\"" in it && "[1,11,false]" in it } }
        }
    }

    @Test
    fun noPinsHidesTheTray() {
        run(transport("[]")) { m ->
            delay(300)
            assertTrue(m.pinnedMessages.isEmpty())
            assertNull(pinTrayOf(m.pinnedMessages))
        }
    }
}
