package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.CLEAR_HISTORY_CONFIRM
import org.velta.kmp.ui.ChatAction
import org.velta.kmp.ui.MenuChat
import org.velta.kmp.ui.OLD_MESSAGE_SPANS
import org.velta.kmp.ui.canAddMembers
import org.velta.kmp.ui.chatHeadMenu
import org.velta.kmp.ui.chatListMenu
import org.velta.kmp.ui.deleteChatConfirm
import org.velta.kmp.ui.deleteChatLeavesFirst
import org.velta.kmp.ui.deleteOldConfirm
import org.velta.kmp.ui.deletedToastKey
import org.velta.kmp.ui.idsOlderThan
import org.velta.kmp.ui.leaveConfirm
import org.velta.kmp.ui.menuChatOf
import org.velta.kmp.ui.muteKind
import org.velta.kmp.ui.placeMenu
import org.velta.kmp.ui.stableChatKind
import org.velta.kmp.ui.visibilityFor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #334 step 5: the chat menus mirror stable app.js chatContextMenu /
 *  bindChatHeadMenu (items, order, labels, icons, confirmations). */
class ChatMenuRulesTest {

    private fun chat(kind: String = "single", chatType: String? = null, pinned: Boolean = false, muted: Boolean = false, archived: Boolean = false, unread: Int = 0, admin: Long? = null) =
        MenuChat(7, "Ann", kind, chatType, pinned, muted, archived, unread, admin)

    private fun labels(entries: List<org.velta.kmp.ui.ChatMenuEntry>) = entries.map { if (it.isSeparator) "-" else it.label }

    @Test
    fun chatKindFollowsRpcCore() {
        assertEquals("saved", stableChatKind(true, false, false, "Single"))
        assertEquals("device", stableChatKind(false, true, false, "Single"))
        assertEquals("deaddrop", stableChatKind(false, false, true, "Single"))
        assertEquals("group", stableChatKind(false, false, false, "Group"))
        listOf("Mailinglist", "OutBroadcast", "InBroadcast").forEach { assertEquals("channel", stableChatKind(false, false, false, it)) }
        assertEquals("single", stableChatKind(false, false, false, "Single"))
        assertEquals("single", stableChatKind(false, false, false, null))
    }

    @Test
    fun menuChatReadsListItemFlags() {
        val c = menuChatOf(ChatListItem(id = 3, name = "", chatType = "Group", isPinned = true, isMuted = true, isArchived = true, freshMessageCounter = 4), groupAdminId = 1)
        assertEquals(MenuChat(3, "?", "group", "Group", true, true, true, 4, 1), c)
    }

    @Test
    fun listMenuOrderAndLabels() {
        assertEquals(
            listOf("Pin to top", "Mute notifications", "Delete old messages…", "-", "Archive", "Delete chat"),
            labels(chatListMenu(chat())),
        )
        assertEquals(
            listOf("Unpin", "Unmute", "Mark as read", "Delete old messages…", "-", "Unarchive", "Delete chat"),
            labels(chatListMenu(chat(pinned = true, muted = true, archived = true, unread = 2))),
        )
    }

    @Test
    fun listMenuIconsAndDanger() {
        val e = chatListMenu(chat(unread = 1)).filterNot { it.isSeparator }
        assertEquals(listOf("pin", "bell", "markRead", "trash", "archive", "trash"), e.map { it.icon })
        assertEquals(listOf(ChatAction.DeleteChat), e.filter { it.danger }.map { it.action })
    }

    @Test
    fun headMenuSingleChat() {
        assertEquals(listOf("Chat info", "Mute", "Pin", "-", "Clear history"), labels(chatHeadMenu(chat())))
        assertEquals(listOf("Chat info", "Unmute", "Unpin", "-", "Clear history"), labels(chatHeadMenu(chat(muted = true, pinned = true))))
        assertTrue(chatHeadMenu(chat()).all { it.icon == null })
        assertTrue(chatHeadMenu(chat()).last().danger)
    }

    @Test
    fun headMenuGroupInviteFollowsAdminCaps() {
        assertEquals(listOf("Chat info", "Group invite QR", "Mute", "Pin", "Leave group", "-", "Clear history"), labels(chatHeadMenu(chat("group", "Group"))))
        // Admin group, someone else is admin: no invite.
        assertFalse(canAddMembers(chat("group", "Group", admin = 5)))
        assertEquals(listOf("Chat info", "Mute", "Pin", "Leave group", "-", "Clear history"), labels(chatHeadMenu(chat("group", "Group", admin = 5))))
        assertTrue(canAddMembers(chat("group", "Group", admin = 1)))
    }

    @Test
    fun headMenuChannels() {
        assertEquals(listOf("Chat info", "Mute", "Pin", "Leave channel", "-", "Clear history"), labels(chatHeadMenu(chat("channel", "InBroadcast"))))
        // Mailing lists cannot be left.
        assertEquals(listOf("Chat info", "Mute", "Pin", "-", "Clear history"), labels(chatHeadMenu(chat("channel", "Mailinglist"))))
    }

    @Test
    fun deleteChatConfirmLeavesGroupsAndBroadcasts() {
        val single = deleteChatConfirm(chat())
        assertEquals("Delete chat", single.title)
        assertEquals("Delete \"{name}\" and all its messages?", single.text)
        assertEquals("Delete", single.ok)
        assertEquals(mapOf("name" to "Ann"), single.args)
        assertTrue(single.danger)
        val group = deleteChatConfirm(chat("group", "Group"))
        assertEquals("Leave \"{name}\" and delete it with all its messages?", group.text)
        assertEquals("Leave and delete", group.ok)
        assertTrue(deleteChatLeavesFirst(chat("channel", "OutBroadcast")))
        assertTrue(deleteChatLeavesFirst(chat("channel", "InBroadcast")))
        assertFalse(deleteChatLeavesFirst(chat("channel", "Mailinglist")))
    }

    @Test
    fun leaveAndClearConfirmations() {
        assertEquals("Leave group", leaveConfirm(chat("group", "Group")).title)
        assertEquals("You will leave this chat and no longer receive its messages.", leaveConfirm(chat("group", "Group")).text)
        assertEquals("Leave channel", leaveConfirm(chat("channel", "InBroadcast")).title)
        assertEquals("Leave", leaveConfirm(chat("channel", "InBroadcast")).ok)
        assertEquals("Clear history", CLEAR_HISTORY_CONFIRM.title)
        assertEquals("Delete all messages in this chat?", CLEAR_HISTORY_CONFIRM.text)
        assertEquals("Delete", CLEAR_HISTORY_CONFIRM.ok)
    }

    @Test
    fun oldMessageSpansAndCutoff() {
        assertEquals(listOf("1 hour", "1 day", "1 week", "5 weeks", "6 months", "1 year"), OLD_MESSAGE_SPANS.map { it.first })
        assertEquals(35 * 86_400_000L, OLD_MESSAGE_SPANS[3].second)
        val spec = deleteOldConfirm(chat(), "1 day")
        assertEquals("Delete old messages", spec.title)
        assertEquals(mapOf("name" to "Ann", "label" to "1 day"), spec.args)
        // (id, ts seconds, pinned): pinned and newer messages stay.
        val msgs = listOf(Triple(1L, 100L, false), Triple(2L, 100L, true), Triple(3L, 300L, false))
        assertEquals(listOf(1L), idsOlderThan(msgs, 200_000L))
        assertEquals("Nothing older than that", deletedToastKey(0))
        assertEquals("1 message deleted", deletedToastKey(1))
        assertEquals("Messages deleted: {n}", deletedToastKey(5))
    }

    @Test
    fun flagsMapToCoreValues() {
        assertEquals("Pinned", visibilityFor(pinned = true, archived = null))
        assertEquals("Normal", visibilityFor(pinned = false, archived = null))
        assertEquals("Archived", visibilityFor(pinned = null, archived = true))
        assertEquals("Normal", visibilityFor(pinned = null, archived = false))
        assertEquals("Forever", muteKind(true))
        assertEquals("NotMuted", muteKind(false))
    }

    @Test
    fun placeMenuClampsLikeStable() {
        assertEquals(100 to 200, placeMenu(100, 200, 210, 300, 1000, 1000))
        assertEquals(1000 - 210 - 10 to 1000 - 300 - 10, placeMenu(990, 990, 210, 300, 1000, 1000))
        assertEquals(8 to 8, placeMenu(-50, 2, 210, 300, 1000, 1000))
    }

    // ---- model → RPC wiring ----

    private fun scriptedPlatform(transport: RpcTransport): CorePlatform = object : CorePlatform {
        override fun accountsDir(): String = "/tmp/velta-kmp-chatmenu-test"
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
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","chatType":"Group","summaryText2":"x","lastUpdated":1,"freshMessageCounter":2}}""",
            "get_message_ids" to "[]",
            "set_chat_visibility" to "null",
            "set_chat_mute_duration" to "null",
            "marknoticed_chat" to "null",
            "leave_group" to "null",
            "delete_chat" to "null",
        ),
    )

    private suspend fun awaitRequest(t: ScriptedRpcTransport, needle: String) =
        withTimeout(10_000) { while (t.requests.none { needle in it }) yield() }

    @Test
    fun listMenuActionsCallTheCore() = runBlocking {
        val t = transport()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(t), scope)
        try {
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || model.chats.isEmpty()) yield() }
            val item = model.chats.first()

            model.openChatListMenu(item, 10f, 20f)
            assertEquals(10f, model.chatMenu?.x)
            model.onChatMenuAction(ChatAction.TogglePin)
            assertEquals(null, model.chatMenu)
            awaitRequest(t, "\"set_chat_visibility\"")
            assertTrue(t.requests.first { "\"set_chat_visibility\"" in it }.contains("[1,5,\"Pinned\"]"))

            model.openChatListMenu(item, 0f, 0f)
            model.onChatMenuAction(ChatAction.ToggleMute)
            awaitRequest(t, "\"set_chat_mute_duration\"")
            assertTrue(t.requests.first { "\"set_chat_mute_duration\"" in it }.contains("[1,5,{\"kind\":\"Forever\"}]"))

            model.openChatListMenu(item, 0f, 0f)
            model.onChatMenuAction(ChatAction.ToggleArchive)
            awaitRequest(t, "\"Archived\"")

            model.openChatListMenu(item, 0f, 0f)
            model.onChatMenuAction(ChatAction.DeleteOld)
            assertTrue(model.chatMenu?.spans == true, "Delete old messages… opens the spans menu")
            model.closeChatMenu()

            // Delete chat: confirm first; a group is left before delete_chat.
            model.openChatListMenu(item, 0f, 0f)
            model.onChatMenuAction(ChatAction.DeleteChat)
            assertEquals("Leave and delete", model.chatConfirm?.spec?.ok)
            assertTrue(t.requests.none { "\"delete_chat\"" in it })
            model.answerChatConfirm(true)
            awaitRequest(t, "\"delete_chat\"")
            val leave = t.requests.indexOfFirst { "\"leave_group\"" in it }
            val delete = t.requests.indexOfFirst { "\"delete_chat\"" in it }
            assertTrue(leave in 0 until delete, "leave_group goes out before delete_chat")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun cancelledConfirmDoesNothing() = runBlocking {
        val t = transport()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(scriptedPlatform(t), scope)
        try {
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || model.chats.isEmpty()) yield() }
            model.openChatListMenu(model.chats.first(), 0f, 0f)
            model.onChatMenuAction(ChatAction.DeleteChat)
            model.answerChatConfirm(false)
            assertEquals(null, model.chatConfirm)
            kotlinx.coroutines.delay(300)
            assertTrue(t.requests.none { "\"delete_chat\"" in it || "\"leave_group\"" in it })
        } finally {
            scope.cancel()
        }
    }
}
