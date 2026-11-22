package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.LOOP_GROUP_MAX_OTHERS
import org.velta.kmp.ui.LOOP_PREF
import org.velta.kmp.ui.LOOP_TYPING_PREF
import org.velta.kmp.ui.LoopAsk
import org.velta.kmp.ui.LoopEvent
import org.velta.kmp.ui.LoopGroup
import org.velta.kmp.ui.LoopMember
import org.velta.kmp.ui.LoopMenu
import org.velta.kmp.ui.LoopPeer
import org.velta.kmp.ui.LoopRow
import org.velta.kmp.ui.LoopStatus
import org.velta.kmp.ui.TypingBoard
import org.velta.kmp.ui.TypingSendState
import org.velta.kmp.ui.TYPING_IDLE_MS
import org.velta.kmp.ui.TYPING_REPEAT_MS
import org.velta.kmp.ui.TYPING_SHOW_TTL_MS
import org.velta.kmp.ui.loopChatMenu
import org.velta.kmp.ui.loopGroupMembersOk
import org.velta.kmp.ui.loopGroupNameOk
import org.velta.kmp.ui.loopGroupOf
import org.velta.kmp.ui.loopListRows
import org.velta.kmp.ui.loopPeerOf
import org.velta.kmp.ui.loopTypingLine
import org.velta.kmp.ui.loopSealWanted
import org.velta.kmp.ui.loopTypingWanted
import org.velta.kmp.ui.loopUnpairBody
import org.velta.kmp.ui.parseLoopMessages
import org.velta.kmp.ui.parseLoopPush
import org.velta.kmp.ui.parseLoopStatus
import org.velta.kmp.ui.typingOnIdle
import org.velta.kmp.ui.typingOnKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #332: Loop stays down unless the pref is on, and the list rules match the engine. */
class LoopRulesTest {

    @Test
    fun idsNameCapAndTyping() {
        assertNull(loopPeerOf("p2pg:g"))
        assertEquals("g", loopGroupOf("p2pg:g"))
        assertEquals("abc", loopPeerOf("p2p:abc"))
        assertFalse(loopGroupNameOk("  "))
        assertTrue(loopGroupNameOk("a".repeat(64)))
        assertFalse(loopGroupNameOk("a".repeat(65)))
        assertFalse(loopGroupMembersOk(0))
        assertTrue(loopGroupMembersOk(1))
        assertTrue(loopGroupMembersOk(LOOP_GROUP_MAX_OTHERS))
        assertFalse(loopGroupMembersOk(LOOP_GROUP_MAX_OTHERS + 1))

        val first = typingOnKey(TypingSendState(), true, 1_000)
        assertEquals(true, first.second)
        val held = typingOnKey(first.first, true, 1_000 + TYPING_REPEAT_MS - 1)
        assertNull(held.second)
        val again = typingOnKey(held.first, true, 1_000 + TYPING_REPEAT_MS)
        assertEquals(true, again.second)
        val idle = typingOnIdle(again.first, again.first.idleDeadline)
        assertEquals(false, idle.second)
        assertNull(typingOnIdle(idle.first, 9_000).second)

        val board = TypingBoard()
        board.note("p2p:a", "a", true, 0)
        assertEquals(listOf("a"), board.active("p2p:a", TYPING_SHOW_TTL_MS - 1))
        assertTrue(board.active("p2p:a", TYPING_SHOW_TTL_MS).isEmpty())
        assertEquals("Ada is typing…", loopTypingLine(listOf("Ada")))
        assertEquals("Ada and Ben are typing…", loopTypingLine(listOf("Ada", "Ben")))
    }

    @Test
    fun rowsPinGroupsAndTypingReplacesPreview() {
        val status = LoopStatus(
            nodeId = "me",
            name = "Me",
            peers = listOf(
                LoopPeer("p", "Pam", true, 0, 20),
                LoopPeer("q", "Quin", false, 1, 50),
            ),
            nearby = emptyList(),
            groups = listOf(LoopGroup("g", "Room", false, listOf(LoopMember("me", "Me", true, true)))),
        )
        val rows = loopListRows(status, mapOf("p2p:q" to "hello", "p2pg:g" to "old"), mapOf("p2p:q" to "Quin is typing…"))
        assertEquals(listOf("p2pg:g", "p2p:q", "p2p:p"), rows.map { it.id })
        assertEquals("Quin is typing…", rows[1].preview)
        assertTrue(rows[1].typing)
        assertEquals("old", rows[0].preview)

        val parsed = parseLoopStatus(
            Json.parseToJsonElement(
                """{"nodeId":"me","name":"Me","peers":[{"id":"p","name":"Pam","online":true,"queued":0,"lastTs":20}],"nearby":[{"id":"n","name":"Nearby"}],"groups":[{"gid":"g","name":"Room","removed":false,"members":[{"id":"me","name":"Me","self":true,"online":true}]}]}""",
            ),
        )
        assertEquals("Pam", parsed.peers.single().name)
        assertEquals("Nearby", parsed.nearby.single().name)
        assertEquals("g", parsed.groups.single().gid)
        val msgs = parseLoopMessages(
            Json.parseToJsonElement("""[{"id":"1","dir":"in","text":"hi"},{"id":"2","dir":"sys","text":"joined"},{"id":"3","dir":"out","text":"","file":{"name":"a.png","path":"/tmp/a.png"}}]"""),
        )
        assertTrue(msgs[0].incoming)
        assertTrue(msgs[1].system)
        assertEquals("a.png", msgs[2].text)
        assertEquals("/tmp/a.png", msgs[2].filePath)
        assertEquals("p2p:p", (parseLoopPush("""{"method":"p2p-event","params":{"kind":"typing","peerId":"p","on":true}}""") as LoopEvent.Typing).chatId)
        assertTrue(parseLoopPush("""{"method":"p2p-event","params":{"kind":"message","peerId":"p"}}""") is LoopEvent.Refresh)
    }

    @Test
    fun menuTypingAndUnpairText() {
        assertTrue(loopTypingWanted(null))
        assertFalse(loopTypingWanted("0"))
        assertTrue(loopSealWanted(null))
        assertFalse(loopSealWanted("0"))
        assertEquals(listOf(LoopMenu.Unpair), loopChatMenu(false, false, false))
        assertEquals(listOf(LoopMenu.Rename, LoopMenu.Disband), loopChatMenu(true, true, false))
        assertEquals(listOf(LoopMenu.Leave), loopChatMenu(true, false, false))
        assertEquals(listOf(LoopMenu.Delete), loopChatMenu(true, true, true))
        val body = loopUnpairBody("Pam", listOf("Room"), listOf("Other"))
        assertTrue(body.contains("\"Room\""))
        assertTrue(body.contains("\"Other\""))
    }

    @Test
    fun fileRenameUnpairAndTyping() = runBlocking {
        val h = harness(pref = "1", available = true, status = RICH)
        try {
            h.model.connect()
            withTimeout(10_000) { while (!h.model.loopReady) yield() }
            h.model.setLoopTyping(false)
            assertEquals("0", h.prefs[LOOP_TYPING_PREF])
            h.model.openLoopChat(LoopRow("p2p:p", "Pam", "", false, false, 1))
            h.model.onLoopDraft("hi")
            h.model.onAttachmentPicked("/tmp/a.png", "a.png")
            withTimeout(10_000) { while (h.loop.requests.none { "p2p_send_file" in it }) yield() }
            assertTrue(h.loop.requests.none { "p2p_typing" in it })
            h.model.askLoopRenameDevice()
            h.model.confirmLoopAsk("Ada")
            withTimeout(10_000) { while (h.loop.requests.none { "p2p_set_name" in it }) yield() }
            h.model.askLoop(LoopMenu.Unpair)
            withTimeout(10_000) { while (h.model.loopAsk == null) yield() }
            assertTrue((h.model.loopAsk as LoopAsk.Unpair).body.contains("\"Room\""))
            h.model.confirmLoopAsk()
            withTimeout(10_000) {
                while (h.model.screen is AppModel.Screen.LoopChat || h.loop.requests.none { "p2p_remove_peer" in it }) yield()
            }
            h.model.openLoopChat(LoopRow("p2pg:g", "Room", "", true, false, 0))
            h.model.askLoop(LoopMenu.Disband)
            assertTrue(h.model.loopAsk is LoopAsk.Leave)
            h.model.confirmLoopAsk()
            withTimeout(10_000) { while (h.loop.requests.none { "p2p_group_disband" in it }) yield() }
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun finishedGroupDeletes() = runBlocking {
        val h = harness(pref = "1", available = true, status = DONE)
        try {
            h.model.connect()
            withTimeout(10_000) { while (!h.model.loopReady) yield() }
            h.model.openLoopChat(LoopRow("p2pg:g", "Room", "", true, false, 0))
            withTimeout(10_000) { while (h.model.loopStatus == null) yield() }
            assertFalse(h.model.loopWritable())
            assertEquals(listOf(LoopMenu.Delete), h.model.loopMenu())
            h.model.askLoop(LoopMenu.Delete)
            h.model.confirmLoopAsk()
            withTimeout(10_000) {
                while (h.model.screen is AppModel.Screen.LoopChat || h.loop.requests.none { "p2p_group_delete" in it }) yield()
            }
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun prefOffDoesNotStartTheEngine() = runBlocking {
        val h = harness(pref = null, available = true)
        try {
            h.model.connect()
            withTimeout(10_000) { while (h.model.screen != AppModel.Screen.ChatList) yield() }
            assertEquals(0, h.opens)
            assertFalse(h.model.loopOn)
            assertFalse(h.loop.requests.any { "p2p_status" in it })
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun prefOnStartsOnceAndOffCloses() = runBlocking {
        val h = harness(pref = "1", available = true)
        try {
            h.model.connect()
            withTimeout(10_000) { while (!h.model.loopReady) yield() }
            assertEquals(1, h.opens)
            assertEquals("1", h.prefs[LOOP_PREF])
            assertTrue(h.loop.requests.any { "p2p_status" in it })
            h.model.setLoop(false)
            yield()
            assertEquals(1, h.closes)
            assertEquals("0", h.prefs[LOOP_PREF])
            assertFalse(h.model.loopReady)
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun unavailableSwitchDoesNotPersist() = runBlocking {
        val h = harness(pref = null, available = false)
        try {
            h.model.connect()
            withTimeout(10_000) { while (h.model.screen != AppModel.Screen.ChatList) yield() }
            h.model.setLoop(true)
            yield()
            assertEquals(0, h.opens)
            assertNull(h.prefs[LOOP_PREF])
            assertFalse(h.model.loopOn)
            assertEquals("Local groups need the Velta app with local chat on", h.model.toast)
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun failedStartLeavesThePrefOff() = runBlocking {
        val h = harness(pref = null, available = true, status = "ERROR:bind failed")
        try {
            h.model.connect()
            withTimeout(10_000) { while (h.model.screen != AppModel.Screen.ChatList) yield() }
            h.model.setLoop(true)
            withTimeout(10_000) { while (h.model.toast == null) yield() }
            assertEquals(1, h.opens)
            assertEquals(1, h.closes)
            assertNull(h.prefs[LOOP_PREF])
            assertFalse(h.model.loopOn)
        } finally {
            h.scope.cancel()
        }
    }

    private class LoopPlatform(
        val prefs: MutableMap<String, String?>,
        private val available: Boolean,
        private val core: RpcTransport,
        private val loop: RpcTransport,
        var opens: Int = 0,
        var closes: Int = 0,
    ) : CorePlatform {
        override fun accountsDir(): String = "/tmp/velta-kmp-loop-test"
        override fun spawnRpcServer(accountsDir: String): RpcTransport = core
        override fun pref(key: String): String? = prefs[key]
        override fun setPref(key: String, value: String?) {
            if (value == null) prefs.remove(key) else prefs[key] = value
        }
        override fun loopAvailable(): Boolean = available
        override fun openLoop(accountsDir: String): RpcTransport? {
            if (!available) return null
            opens++
            return loop
        }
        override fun closeLoop() {
            closes++
        }
    }

    private class Harness(
        val model: AppModel,
        val scope: CoroutineScope,
        val loop: ScriptedRpcTransport,
        val prefs: MutableMap<String, String?>,
        val platform: LoopPlatform,
    ) {
        val opens get() = platform.opens
        val closes get() = platform.closes
    }

    private fun harness(pref: String?, available: Boolean, status: String = STATUS): Harness {
        val prefs = mutableMapOf<String, String?>()
        if (pref != null) prefs[LOOP_PREF] = pref
        val core = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
                "select_account" to "null",
                "start_io_for_all_accounts" to "null",
                "get_chatlist_entries" to "[]",
            ),
        )
        val loop = ScriptedRpcTransport(
            mapOf(
                "p2p_status" to status,
                "p2p_messages" to "[]",
                "p2p_group_messages" to "[]",
                "p2p_send_file" to """{"id":"f","path":"/tmp/f"}""",
                "p2p_group_send_file" to """{"id":"f"}""",
                "p2p_peer_groups" to """{"created":[{"gid":"g","name":"Room","removed":false}],"member":[]}""",
                "p2p_remove_peer" to "null",
                "p2p_set_name" to "null",
                "p2p_group_rename" to "null",
                "p2p_group_leave" to "null",
                "p2p_group_disband" to "null",
                "p2p_group_delete" to "null",
                "p2p_typing_peer" to "true",
                "p2p_typing_group" to "0",
            ),
        )
        val platform = LoopPlatform(prefs, available, core, loop)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        return Harness(AppModel(platform, scope), scope, loop, prefs, platform)
    }

    private companion object {
        const val STATUS =
            """{"nodeId":"me","name":"Me","peers":[],"nearby":[],"groups":[]}"""
        const val RICH =
            """{"nodeId":"me","name":"Me","peers":[{"id":"p","name":"Pam","online":true,"queued":0,"lastTs":1}],"nearby":[],"groups":[{"gid":"g","name":"Room","removed":false,"closed":false,"canManage":true,"members":[]}]}"""
        const val DONE =
            """{"nodeId":"me","name":"Me","peers":[],"nearby":[],"groups":[{"gid":"g","name":"Room","removed":true,"closed":true,"canManage":false,"members":[]}]}"""
    }
}
