package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.velta.kmp.core.CoreEvent
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppIconChoice
import org.velta.kmp.ui.AppModel
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * #334 step 3: events route by account (`contextId`), notifications are
 * keyed per account+chat and suppressed only for the chat on screen while
 * the app is visible, visible unseen messages get markseen_msgs, message
 * events refetch only the named message (#507), and a notification tap
 * opens the right account + chat.
 */
class NotifyEventsTest {

    private class Recorder : AppModel.IncomingNotifier {
        val posted = CopyOnWriteArrayList<Triple<Long, Long, String>>()
        val cancelled = CopyOnWriteArrayList<Pair<Long, Long>>()
        var refreshes = 0
        override fun notifyIncoming(accountId: Long, chatId: Long, chatName: String, text: String) {
            posted += Triple(accountId, chatId, "$chatName|$text")
        }
        override fun cancel(accountId: Long, chatId: Long) {
            cancelled += accountId to chatId
        }
        override fun refreshIcons() {
            refreshes++
        }
    }

    private fun script(muted: Boolean = false, state: Int = 10) = mapOf(
        "get_system_info" to """{"deltachat_core_version":"v2.69.0"}""",
        "get_all_account_ids" to "[1,2]",
        "get_selected_account_id" to "1",
        "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
        "get_chatlist_entries" to "[5]",
        "get_chatlist_items_by_entries" to
            """{"5":{"kind":"ChatListItem","id":5,"name":"Alice","summaryText2":"x","lastUpdated":1,"freshMessageCounter":1,"isMuted":$muted}}""",
        "select_account" to "null",
        "start_io_for_all_accounts" to "null",
        "get_message_ids" to "[41,42,43]",
        "get_messages" to """{
            "41":{"kind":"message","id":41,"chatId":5,"fromId":2,"text":"hi","viewType":"Text","state":$state,"timestamp":1700000001},
            "42":{"kind":"message","id":42,"chatId":5,"fromId":1,"text":"mine","viewType":"Text","state":26,"timestamp":1700000002},
            "43":{"kind":"message","id":43,"chatId":5,"fromId":2,"text":"old","viewType":"Text","state":16,"timestamp":1700000003}}""",
        "markseen_msgs" to "null",
    )

    private class Fixture(val transport: ScriptedRpcTransport, val model: AppModel, val notifier: Recorder, val scope: CoroutineScope)

    private suspend fun started(script: Map<String, String>): Fixture {
        val transport = ScriptedRpcTransport(script)
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-notify-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        val notifier = Recorder()
        model.notifier = notifier
        model.connect()
        withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || model.chats.isEmpty()) yield() }
        return Fixture(transport, model, notifier, scope)
    }

    private suspend fun Fixture.openChat5() {
        model.openChat(model.chats.first())
        withTimeout(10_000) { while (model.chatMessages.size < 3) yield() }
    }

    private fun incoming(account: Long, chat: Long = 5, msg: Long = 41) = Json.decodeFromString(
        CoreEvent.serializer(),
        """{"contextId":$account,"event":{"kind":"IncomingMsg","chatId":$chat,"msgId":$msg}}""",
    )

    private fun event(account: Long, json: String) =
        Json.decodeFromString(CoreEvent.serializer(), """{"contextId":$account,"event":$json}""")

    private fun count(t: ScriptedRpcTransport, method: String) = t.requests.count { "\"$method\"" in it }

    @Test
    fun contextIdIsTheAccount() {
        val e = Json.decodeFromString(CoreEvent.serializer(), """{"contextId":7,"event":{"kind":"MsgRead","chatId":3,"msgId":9}}""")
        assertEquals(7L, e.accountId)
        assertEquals("MsgRead", e.kind)
    }

    @Test
    fun settingTheAppIconRefreshesLiveNotifications() = runBlocking {
        val f = started(script())
        try {
            assertEquals(0, f.notifier.refreshes)
            f.model.onSetAppIcon(AppIconChoice.Badge)
            assertEquals(1, f.notifier.refreshes)
            // Same choice again: no-op, no extra refresh.
            f.model.onSetAppIcon(AppIconChoice.Badge)
            assertEquals(1, f.notifier.refreshes)
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun notificationKeysAreUniquePerAccountAndChat() {
        assertNotEquals(AppModel.notificationKey(1, 12), AppModel.notificationKey(2, 12))
        assertNotEquals(AppModel.notificationKey(1, 12), AppModel.notificationKey(11, 2))
        assertEquals(AppModel.notificationKey(3, 4), AppModel.notificationKey(3, 4))
    }

    @Test
    fun openChatInForegroundIsSuppressedButBackgroundNotifies() = runBlocking {
        val f = started(script())
        try {
            f.openChat5()
            f.model.handleEvent(incoming(1))
            delay(300)
            assertTrue(f.notifier.posted.isEmpty(), "chat on screen + app visible = no notification")

            f.model.onAppForeground(false)
            f.model.handleEvent(incoming(1))
            withTimeout(5_000) { while (f.notifier.posted.isEmpty()) yield() }
            assertEquals(Triple(1L, 5L, "Alice|hi"), f.notifier.posted.single())
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun otherAccountNotifiesWithItsOwnIdAndDoesNotReloadThisOne() = runBlocking {
        val f = started(script())
        try {
            delay(400) // let the startup archived-list lookup settle first
            val listLoads = count(f.transport, "get_chatlist_entries")
            f.model.handleEvent(incoming(2))
            withTimeout(5_000) { while (f.notifier.posted.isEmpty()) yield() }
            assertEquals(2L, f.notifier.posted.single().first, "notification carries the event's account")
            // Any lookup for account 2 (account 1's own startup reload may
            // land after it — "last" was flaky).
            val lookups = f.transport.requests.filter { "\"get_chatlist_items_by_entries\"" in it }
            assertTrue(
                lookups.any { Json.parseToJsonElement(it).jsonObject["params"]!!.jsonArray[0].toString() == "2" },
                "the notification lookup runs on the event's account",
            )
            delay(400)
            assertEquals(listLoads, count(f.transport, "get_chatlist_entries"), "account 1's list must not reload")
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun mutedChatDoesNotNotify() = runBlocking {
        val f = started(script(muted = true))
        try {
            f.model.handleEvent(incoming(1))
            delay(400)
            assertTrue(f.notifier.posted.isEmpty())
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun noticedElsewhereCancelsTheNotification() = runBlocking {
        val f = started(script())
        try {
            f.model.handleEvent(event(2, """{"kind":"MsgsNoticed","chatId":5}"""))
            assertTrue((2L to 5L) in f.notifier.cancelled)
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun visibleUnseenIncomingMessagesAreMarkedSeenOnce() = runBlocking {
        val f = started(script())
        try {
            f.openChat5()
            f.model.onMessagesVisible(listOf(41, 42, 43))
            withTimeout(5_000) { while (count(f.transport, "markseen_msgs") < 1) yield() }
            val line = f.transport.requests.first { "\"markseen_msgs\"" in it }
            val params = Json.parseToJsonElement(line).jsonObject["params"]!!.jsonArray
            assertEquals("1", params[0].toString())
            assertEquals("[41]", params[1].toString(), "only the unseen INCOMING row")

            f.model.onMessagesVisible(listOf(41))
            delay(300)
            assertEquals(1, count(f.transport, "markseen_msgs"), "each message is marked once")
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun noReadReceiptsWhileInBackground() = runBlocking {
        val f = started(script())
        try {
            f.openChat5()
            f.model.onAppForeground(false)
            f.model.onMessagesVisible(listOf(41))
            delay(300)
            assertEquals(0, count(f.transport, "markseen_msgs"))
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun deliveryAndReadEventsRefetchOnlyTheNamedMessage() = runBlocking {
        val f = started(script(state = 16))
        try {
            f.openChat5()
            for (kind in listOf("MsgRead", "MsgDelivered", "MsgFailed", "ReactionsChanged")) {
                val idLoads = count(f.transport, "get_message_ids")
                val msgLoads = count(f.transport, "get_messages")
                f.model.handleEvent(event(1, """{"kind":"$kind","chatId":5,"msgId":42}"""))
                withTimeout(5_000) { while (count(f.transport, "get_messages") <= msgLoads) yield() }
                assertEquals(idLoads, count(f.transport, "get_message_ids"), "$kind must not refetch the whole window (#507)")
                val last = f.transport.requests.last { "\"get_messages\"" in it }
                assertTrue("[42]" in last, "$kind refetches only the named message: $last")
            }
            // Another account's read receipt does not touch this chat.
            val before = count(f.transport, "get_messages")
            f.model.handleEvent(event(2, """{"kind":"MsgRead","chatId":5,"msgId":42}"""))
            delay(400)
            assertEquals(before, count(f.transport, "get_messages"))
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun msgDeletedDropsTheRowWithoutAWindowReload() = runBlocking {
        val f = started(script(state = 16))
        try {
            f.openChat5()
            // After the delete the core answers get_messages([42]) with a
            // LoadingError entry, which the facade drops — an empty map here.
            f.transport.dynamic["get_messages"] = "{}"
            val idLoads = count(f.transport, "get_message_ids")
            f.model.handleEvent(event(1, """{"kind":"MsgDeleted","chatId":5,"msgId":42}"""))
            withTimeout(5_000) { while (f.model.chatMessages.any { it.id == 42L }) yield() }
            assertEquals(listOf(41L, 43L), f.model.chatMessages.map { it.id })
            assertEquals(idLoads, count(f.transport, "get_message_ids"), "a delete must not refetch the window (#507)")
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun incomingMsgAppendsTheTailMessageWithoutAWindowReload() = runBlocking {
        val f = started(script())
        try {
            f.openChat5()
            f.transport.dynamic["get_messages"] = """{
                "41":{"kind":"message","id":41,"chatId":5,"fromId":2,"text":"hi","viewType":"Text","state":10,"timestamp":1700000001},
                "42":{"kind":"message","id":42,"chatId":5,"fromId":1,"text":"mine","viewType":"Text","state":26,"timestamp":1700000002},
                "43":{"kind":"message","id":43,"chatId":5,"fromId":2,"text":"old","viewType":"Text","state":16,"timestamp":1700000003},
                "44":{"kind":"message","id":44,"chatId":5,"fromId":2,"text":"new","viewType":"Text","state":10,"timestamp":1700000004}}"""
            val idLoads = count(f.transport, "get_message_ids")
            f.model.handleEvent(incoming(1, msg = 44))
            withTimeout(5_000) { while (f.model.chatMessages.none { it.id == 44L }) yield() }
            assertEquals(listOf(41L, 42L, 43L, 44L), f.model.chatMessages.map { it.id })
            assertEquals(idLoads, count(f.transport, "get_message_ids"), "an append must not refetch the window (#507)")
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun msgsChangedWithoutAnIdFallsBackToAWindowReload() = runBlocking {
        val f = started(script())
        try {
            f.openChat5()
            val idLoads = count(f.transport, "get_message_ids")
            f.model.handleEvent(event(1, """{"kind":"MsgsChanged","chatId":5,"msgId":0}"""))
            withTimeout(5_000) { while (count(f.transport, "get_message_ids") <= idLoads) yield() }
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun chatlistChangedReloadsTheList() = runBlocking {
        val f = started(script())
        try {
            val before = count(f.transport, "get_chatlist_entries")
            f.model.handleEvent(event(1, """{"kind":"ChatlistChanged"}"""))
            withTimeout(5_000) { while (count(f.transport, "get_chatlist_entries") <= before) yield() }
        } finally {
            f.scope.cancel()
        }
    }

    @Test
    fun notificationTapSwitchesAccountAndOpensTheChat() = runBlocking {
        val f = started(script())
        try {
            f.model.openFromNotification(2, 5)
            withTimeout(5_000) { while (f.model.screen !is AppModel.Screen.Chat) yield() }
            assertEquals(2L, f.model.accountId)
            assertEquals(5L, (f.model.screen as AppModel.Screen.Chat).chatId)
            assertTrue(f.transport.requests.any { "\"select_account\"" in it && "\"params\":[2]" in it })
            assertTrue((2L to 5L) in f.notifier.cancelled, "opening the chat clears its notification")
        } finally {
            f.scope.cancel()
        }
    }
}
