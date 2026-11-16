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
import org.velta.kmp.ui.EPHEMERAL_OPTIONS
import org.velta.kmp.ui.canSetEphemeral
import org.velta.kmp.ui.ephemeralPreselect
import org.velta.kmp.ui.ephemeralSecsToSend
import org.velta.kmp.ui.showsEphemeralRow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #358 C: stable openEphemeralDialog + adminCaps.canSetTimer. */
class EphemeralRulesTest {

    @Test
    fun optionsMatchStable() {
        assertEquals(
            listOf(0, 300, 3600, 86400, 604800, 3024000, 31536000),
            EPHEMERAL_OPTIONS.map { it.second },
        )
    }

    @Test
    fun rowVisibilityAndPermission() {
        assertTrue(showsEphemeralRow("group"))
        assertTrue(showsEphemeralRow("single"))
        listOf("saved", "device", "channel", "deaddrop").forEach { assertFalse(showsEphemeralRow(it), it) }
        assertTrue(canSetEphemeral("single", null))
        assertTrue(canSetEphemeral("group", null))
        assertTrue(canSetEphemeral("group", 1))
        assertFalse(canSetEphemeral("group", 9))
    }

    @Test
    fun preselectAndSend() {
        assertEquals(3600, ephemeralPreselect(3600))
        assertEquals(0, ephemeralPreselect(0))
        assertNull(ephemeralPreselect(45))
        assertEquals(0, ephemeralSecsToSend(-5))
        assertEquals(300, ephemeralSecsToSend(300))
    }

    private fun transport(set: String = "null") = ScriptedRpcTransport(
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
                """{"5":{"kind":"ChatListItem","id":5,"name":"Crew","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0,"chatType":"Group"}}""",
            "get_full_chat_by_id" to """{"id":5,"name":"Crew","chatType":"Group","contactIds":[1,7],"ephemeralTimer":0,"groupAdminId":null}""",
            "get_chat_media" to "[]",
            "get_chat_contacts" to "[1,7]",
            "get_contacts_by_ids" to "{}",
            "get_chat_ephemeral_timer" to "3600",
            "set_chat_ephemeral_timer" to set,
            "list_transports" to """[{"addr":"a@relay.example.dev"}]""",
            "get_server_metadata" to "{}",
        ),
    )

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, block: suspend (AppModel) -> Unit) = runBlocking {
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-ephemeral-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = t
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.connect()
            until { model.screen == AppModel.Screen.ChatList && model.chats.isNotEmpty() }
            model.openProfile(5, "Crew")
            until { model.profile != null }
            block(model)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun okSetsTheTimerAndUpdatesTheRow() {
        val t = transport()
        run(t) { m ->
            m.openEphemeralDialog()
            until { m.ephemeralDraft != null }
            assertEquals(3600, m.ephemeralDraft!!.selected)
            m.pickEphemeral(604800)
            m.applyEphemeral()
            until { m.ephemeralDraft == null }
            assertTrue(t.requests.any { "\"set_chat_ephemeral_timer\"" in it && "[1,5,604800]" in it })
            assertEquals(604800, m.profile!!.ephemeralSecs)
        }
    }

    @Test
    fun anErrorKeepsTheDialogOpen() {
        run(transport(set = "ERROR:not a member")) { m ->
            m.openEphemeralDialog()
            until { m.ephemeralDraft != null }
            m.applyEphemeral()
            until { m.ephemeralError != null }
            assertTrue(m.ephemeralError!!.startsWith("Couldn't set disappearing messages: "))
            assertTrue(m.ephemeralDraft != null)
        }
    }
}
