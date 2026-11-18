package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.bubbleMaxWidth
import org.velta.kmp.ui.keepDraft
import org.velta.kmp.ui.relayRemoveConfirm
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #334 step 8: draft quote, bubble width, relay removal, account switch. */
class SmallFixesTest {

    // ---- rules ----

    @Test
    fun bubbleCapMatchesStableCss() {
        assertEquals(360f, bubbleMaxWidth(400f, withAvatar = false)) // 90%
        assertEquals(480f, bubbleMaxWidth(800f, withAvatar = false)) // 480px cap
        assertEquals(310f, bubbleMaxWidth(400f, withAvatar = true)) // 90% - 50px
        assertEquals(480f, bubbleMaxWidth(1000f, withAvatar = true))
        assertEquals(0f, bubbleMaxWidth(20f, withAvatar = true))
    }

    @Test
    fun draftIsKeptForTextQuoteOrAttachment() {
        assertTrue(keepDraft("hi", false, null))
        assertTrue(keepDraft("", false, 9))
        assertTrue(keepDraft("", true, null))
        assertFalse(keepDraft("", false, null))
    }

    @Test
    fun relayRemoveConfirmIsStableWording() {
        val spec = relayRemoveConfirm("x@relay.example")
        assertEquals("Remove {addr}?", spec.title)
        assertEquals("Remove", spec.ok)
        assertTrue(spec.danger)
        assertEquals(mapOf("addr" to "x@relay.example"), spec.args)
        assertTrue(spec.text.endsWith("Your last relay cannot be removed."))
    }

    // ---- model ----

    private fun platform(t: RpcTransport): CorePlatform = object : CorePlatform {
        override fun accountsDir(): String = "/tmp/velta-kmp-small-fixes-test"
        override fun spawnRpcServer(accountsDir: String): RpcTransport = t
    }

    private fun transport(extra: Map<String, String> = emptyMap()) = ScriptedRpcTransport(
        mapOf(
            "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
            "get_all_account_ids" to "[1]",
            "get_selected_account_id" to "1",
            "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
            "get_all_accounts" to
                """[{"id":1,"addr":"a@example.org","isConfigured":true},{"id":2,"addr":"b@example.org","isConfigured":true}]""",
            "select_account" to "null",
            "start_io_for_all_accounts" to "null",
            "get_chatlist_entries" to "[5]",
            "get_chatlist_items_by_entries" to
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
            "get_message_ids" to "[]",
            "misc_set_draft" to "null",
            "remove_draft" to "null",
            "list_transports" to """[{"addr":"a@example.org"},{"addr":"second@other.example"}]""",
            "get_server_metadata" to "{}",
            "misc_get_stickers" to """{"pack":["/tmp/s1.webp"]}""",
        ) + extra,
    )

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, block: suspend (AppModel) -> Unit) = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform(t), scope)
        try {
            model.connect()
            until { model.screen == AppModel.Screen.ChatList && model.chats.isNotEmpty() }
            block(model)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun leavingAChatKeepsTheReplyQuoteInTheDraft() {
        val t = transport()
        run(t) { model ->
            model.openChat(model.chats.first())
            until { model.screen is AppModel.Screen.Chat }
            model.replyTo = MessageObject(id = 9, text = "quoted")
            model.composerText = "half typed"
            model.backToChatList()
            until { t.requests.any { "\"misc_set_draft\"" in it } }
            val line = t.requests.first { "\"misc_set_draft\"" in it }
            assertTrue(line.contains("""[1,5,"half typed",null,null,9,null]"""), line)
        }
    }

    @Test
    fun aQuoteAloneIsStillADraft() {
        val t = transport()
        run(t) { model ->
            model.openChat(model.chats.first())
            until { model.screen is AppModel.Screen.Chat }
            model.replyTo = MessageObject(id = 9, text = "quoted")
            model.backToChatList()
            until { t.requests.any { "\"misc_set_draft\"" in it || "\"remove_draft\"" in it } }
            val line = t.requests.first { "\"misc_set_draft\"" in it || "\"remove_draft\"" in it }
            assertTrue(line.contains("""[1,5,"",null,null,9,null]"""), line)
        }
    }

    @Test
    fun relayRemovalAsksFirstThenToasts() {
        val t = transport(mapOf("delete_transport" to "null"))
        run(t) { model ->
            model.removeRelay("second@other.example")
            assertEquals("Remove {addr}?", model.chatConfirm?.spec?.title)
            model.answerChatConfirm(false)
            delay(200)
            assertTrue(t.requests.none { "\"delete_transport\"" in it }, "cancel removes nothing")

            model.removeRelay("second@other.example")
            model.answerChatConfirm(true)
            until { model.toast != null }
            assertEquals("Relay removed", model.toast)
            assertTrue(t.requests.first { "\"delete_transport\"" in it }.contains("""[1,"second@other.example"]"""))
        }
    }

    @Test
    fun relayRemovalErrorIsShown() {
        val t = transport(mapOf("delete_transport" to "ERROR:cannot remove the last relay"))
        run(t) { model ->
            model.removeRelay("a@example.org")
            model.answerChatConfirm(true)
            until { model.toast != null }
            assertTrue(model.toast!!.contains("cannot remove the last relay"), model.toast)
        }
    }

    @Test
    fun stickerSendKeepsTheReplyQuote() {
        val t = transport(mapOf("send_msg" to "77"))
        run(t) { model ->
            model.openChat(model.chats.first())
            until { model.screen is AppModel.Screen.Chat }
            model.replyTo = MessageObject(id = 3, text = "q")
            model.sendSticker("/tmp/s1.webp")
            until { t.requests.any { "\"send_msg\"" in it } }
            val line = t.requests.first { "\"send_msg\"" in it }
            assertTrue(line.contains("\"viewtype\":\"Sticker\""), line)
            assertTrue(line.contains("\"file\":\"/tmp/s1.webp\""), line)
            assertTrue(line.contains("\"quotedMessageId\":3"), line)
            assertTrue(t.requests.none { "\"send_sticker\"" in it })
            assertNull(model.replyTo)
        }
    }

    @Test
    fun stickerPickerRefetchesPacksEachOpen() {
        val t = transport()
        run(t) { model ->
            model.loadStickers()
            until { model.stickerPacks.isNotEmpty() }
            val n = t.requests.count { "\"misc_get_stickers\"" in it }
            model.loadStickers()
            until { t.requests.count { "\"misc_get_stickers\"" in it } > n }
        }
    }

    @Test
    fun socksCardConfirmStoresTheProxy() {
        val t = transport(mapOf("set_config" to "null", "maybe_network" to "null"))
        run(t) { model ->
            val raw = "velta://proxy?h=proxy.example.org&p=1080"
            model.askSocksProxy(raw)
            assertEquals("Add SOCKS5 proxy?", model.chatConfirm?.spec?.title)
            assertEquals("Add and use", model.chatConfirm?.spec?.ok)
            model.answerChatConfirm(false)
            delay(200)
            assertTrue(t.requests.none { "proxy_url" in it }, "cancel stores nothing")
            model.askSocksProxy(raw)
            model.answerChatConfirm(true)
            until { model.proxyUrl == "socks5://proxy.example.org:1080" }
            assertTrue(t.requests.any { "\"proxy_enabled\"" in it && "\"1\"" in it })
        }
    }

    @Test
    fun switchingAccountsDropsTheOldProfilesCaches() {
        val t = transport()
        run(t) { model ->
            model.loadStickers()
            until { model.stickerPacks.isNotEmpty() }
            model.listView = "contacts"
            val before = t.requests.count { "\"misc_get_stickers\"" in it }

            model.switchAccount(2)
            until { model.accountId == 2L && model.screen == AppModel.Screen.ChatList }
            assertEquals("chats", model.listView)
            until { model.chats.isNotEmpty() }
            assertTrue(model.stickerPacks.isEmpty(), "stickers are per profile")
            model.loadStickers()
            until { t.requests.count { "\"misc_get_stickers\"" in it } > before }
            assertNotNull(t.requests.last { "\"misc_get_stickers\"" in it }.takeIf { "[2]" in it })
            assertNull(model.chatHead)
        }
    }
}
