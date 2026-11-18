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
import org.velta.kmp.ui.SHARE_CATEGORIES
import org.velta.kmp.ui.forwardPickerTargets
import org.velta.kmp.ui.ShareItem
import org.velta.kmp.ui.SharedText
import org.velta.kmp.ui.classifySharedText
import org.velta.kmp.ui.composerWithShare
import org.velta.kmp.ui.coreViewtype
import org.velta.kmp.ui.sharePlan
import org.velta.kmp.ui.shareStageKind
import org.velta.kmp.ui.shareTargets
import org.velta.kmp.ui.shareViewtype
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** #334 step 7: share-in mirrors stable share-in.js + routeOpenedBatch. */
class ShareInRulesTest {

    private val fp = "0123456789ABCDEF0123456789ABCDEF01234567"

    @Test
    fun sharedTextRouting() {
        assertEquals(SharedText.Text("hello world"), classifySharedText("hello world"))
        assertEquals(SharedText.Text("see https://x.org/a"), classifySharedText("see https://x.org/a"))
        assertEquals(SharedText.Text("https://example.org/page"), classifySharedText("https://example.org/page"))
        // Invite links and chatmail codes belong to the deep-link router.
        assertTrue(classifySharedText("https://velta.cc/join/?$fp&a=x%40y.org") is SharedText.Link)
        assertTrue(classifySharedText("https://i.delta.chat/#$fp&a=x%40y.org") is SharedText.Link)
        assertTrue(classifySharedText("DCACCOUNT:https://relay.example/new") is SharedText.Link)
        assertTrue(classifySharedText("openpgp4fpr:$fp") is SharedText.Link)
        // Unconsumed app schemes are dropped, other schemes are decoded text.
        assertEquals(SharedText.Drop, classifySharedText("velta://chat?id=3"))
        assertEquals(SharedText.Text("mailto:a b"), classifySharedText("mailto:a%20b"))
        assertEquals(null, classifySharedText("   "))
    }

    @Test
    fun viewtypesAndStageKind() {
        assertEquals("image", shareViewtype("a.JPG"))
        assertEquals("video", shareViewtype("clip.mov"))
        assertEquals("audio", shareViewtype("v.opus"))
        assertEquals("file", shareViewtype("doc.pdf"))
        assertEquals("Image", coreViewtype("image"))
        assertEquals("File", coreViewtype("file"))
        assertEquals("text", shareStageKind(emptyList()))
        assertEquals("image", shareStageKind(listOf("p.png")))
        assertEquals("send", shareStageKind(listOf("p.svg")), "svg is not staged")
        assertEquals("video", shareStageKind(listOf("c.mp4")))
        assertEquals("send", shareStageKind(listOf("d.pdf")))
        assertEquals("send", shareStageKind(listOf("a.png", "b.png")))
    }

    @Test
    fun planJoinsTextAndDedupesFiles() {
        val plan = sharePlan(listOf(ShareItem(text = "a"), ShareItem(file = "/f1", name = "1.png"), ShareItem(text = ""), ShareItem(text = "b"), ShareItem(file = "/f1", name = "1.png"), ShareItem()))
        assertEquals("a\n\nb", plan.text)
        assertEquals(listOf("/f1"), plan.files.map { it.file })
        assertEquals("x\ny", composerWithShare("x", "y"))
        assertEquals("y", composerWithShare("  ", "y"))
        assertEquals("x", composerWithShare("x", ""))
    }

    @Test
    fun targetsSkipRequestsAndDeviceChat() {
        val chats = listOf(
            ChatListItem(id = 10, name = "Ann", chatType = "Single"),
            ChatListItem(id = 11, name = "Team", chatType = "Group"),
            ChatListItem(id = 12, name = "Req", isContactRequest = true),
            ChatListItem(id = 13, name = "Device", isDeviceTalk = true),
            ChatListItem(id = 14, name = "Saved", isSelfTalk = true),
        )
        assertEquals(listOf(10L, 11L, 14L), shareTargets(chats).map { it.id })
        assertEquals(listOf(11L), shareTargets(chats, cat = "groups").map { it.id })
        assertEquals(listOf(14L), shareTargets(chats, cat = "saved").map { it.id })
        assertEquals(listOf(10L), shareTargets(chats, query = "an").map { it.id })
        assertEquals(listOf("all", "people", "groups", "channels", "bots", "saved"), SHARE_CATEGORIES)
        val withSpecial = chats + ChatListItem(id = 7, name = "Hint", chatType = "Single")
        assertEquals(listOf(10L, 11L, 14L), forwardPickerTargets(withSpecial).map { it.id })
        assertEquals(listOf(11L), forwardPickerTargets(withSpecial, cat = "groups").map { it.id })
        assertEquals(listOf(10L), forwardPickerTargets(withSpecial, knownOnly = true).map { it.id })
    }

    // ---- model wiring ----

    private fun scriptedPlatform(transport: RpcTransport): CorePlatform = object : CorePlatform {
        override fun accountsDir(): String = "/tmp/velta-kmp-share-test"
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
            "get_chatlist_entries" to "[5]",
            "get_chatlist_items_by_entries" to
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","chatType":"Single","summaryText2":"x","lastUpdated":1}}""",
            "get_message_ids" to "[]",
            "marknoticed_chat" to "null",
            "get_full_chat_by_id" to """{"id":5,"canSend":true}""",
            "send_msg" to "77",
            "set_chat_visibility" to "null", // the scripted archive list also holds chat 5
            "get_draft" to "null",
        ),
    )

    @Test
    fun shareWaitsForTheChatListThenStagesText() = runBlocking {
        val t = transport()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(t), scope)
        try {
            // Cold start: the share lands before the core is up — held.
            model.receiveShare(listOf(ShareItem(text = "shared words")))
            assertEquals(null, model.sharePick)
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || model.chats.isEmpty()) delay(10) }
            model.flushShares() // the host's LaunchedEffect does this on screen changes
            assertEquals("shared words", model.sharePick?.text)
            model.pickShareChat(model.chats.first())
            assertEquals(null, model.sharePick)
            withTimeout(10_000) { while (model.composerText != "shared words") delay(10) }
            assertTrue(t.requests.none { "\"send_msg\"" in it }, "text goes to the composer, not out")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun documentIsSentRightAway() = runBlocking {
        val t = transport()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(t), scope)
        try {
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || model.chats.isEmpty()) delay(10) }
            model.receiveShare(listOf(ShareItem(text = "cap"), ShareItem(file = "/tmp/x.pdf", name = "x.pdf")))
            model.pickShareChat(model.chats.first())
            withTimeout(10_000) { while (t.requests.none { "\"send_msg\"" in it }) delay(10) }
            val line = t.requests.first { "\"send_msg\"" in it }
            assertTrue(line.contains("\"text\":\"cap\"") && line.contains("\"file\":\"/tmp/x.pdf\"") && line.contains("\"viewtype\":\"File\""), line)
            withTimeout(10_000) { while (model.toast == null) delay(10) }
            assertEquals("Sent to Test Chat", model.toast)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun photoIsStagedAsAttachment() = runBlocking {
        val t = transport()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(t), scope)
        try {
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || model.chats.isEmpty()) delay(10) }
            model.receiveShare(listOf(ShareItem(file = "/tmp/p.jpg", name = "p.jpg")))
            model.pickShareChat(model.chats.first())
            withTimeout(10_000) { while (model.pendingAttachment == null) delay(10) }
            assertEquals("/tmp/p.jpg" to "p.jpg", model.pendingAttachment)
            assertTrue(t.requests.none { "\"send_msg\"" in it })
        } finally {
            scope.cancel()
        }
    }
}
